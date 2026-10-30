import { randomUUID, createHash } from "node:crypto";
import { REQUIRED_COMPOSER_BUILD } from "./chrome-bridge.js";
import { HumanApprovalAlerts } from "./human-approval-alerts.js";

const MAX_TEXT = 800;
const COMMAND_LEASE_MS = 2 * 60_000;
const OBSERVATION_MAX_AGE_MS = 150_000;
const OBSERVATION_MIN_STABLE_MS = 30_000;
const SHA256 = /^[a-f0-9]{64}$/;
const digest = x => createHash("sha256").update(x).digest("hex");
const rowConfig = r => r ? ({
  workstreamId:r.workstream_id,enabled:Boolean(r.enabled),mode:r.mode,
  message:r.message,intervalMinutes:r.interval_minutes,
  approvedAt:r.approved_at,approvedSessionKey:r.approved_session_key||null,
  approvedUrlHash:r.approved_url_hash||null,
  evidenceHash:r.evidence_hash,
  nextDueAt:r.next_due_at,lastSentAt:r.last_sent_at,
  sentCount:r.sent_count,
  ciResumeTargetHash:r.ci_resume_target_hash||null,
  status:r.status,
  statusReason:r.status_reason
}) : null;
const rowCommand = r => r ? ({
  id:r.id,workstreamId:r.workstream_id,extensionId:r.extension_id,sessionKey:r.session_key,
  state:r.state,createdAt:r.created_at,claimedAt:r.claimed_at,
  finishedAt:r.finished_at,reason:r.reason,attempt:r.attempt,
  // Never expose a conversation URL or a whole ChatGPT transcript.
  messageHash:r.message_hash
}) : null;

export class ChatContinuation {
  constructor(store,{bridge,watchtower,github,gate,ciCandidates=()=>[],now=()=>Date.now()}={}){
    if(!bridge||!watchtower||!github||!gate)throw Error("Chat continuation requires identity and CI sources.");
    this.store=store;this.db=store.db;this.bridge=bridge;
    this.watchtower=watchtower;this.github=github;this.gate=gate;this.now=now;
    this.ciCandidates=ciCandidates;
    this.approvals=new HumanApprovalAlerts(store,{now});
    // Challenge state is deliberately ephemeral. A restart requires fresh browser proofs.
    this.observationRequests=new Map();
    this.lastObservationDiagnostics=new Map();
    this.observationStartedAt=this.now();
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS chat_continuation_settings(",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),",
      "enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),",
      "mode TEXT NOT NULL CHECK(mode IN ('manual','scheduled')),",
      "message TEXT NOT NULL,interval_minutes INTEGER CHECK(interval_minutes BETWEEN 1 AND 1440),"+
      "approved_at INTEGER NOT NULL,approved_session_key TEXT,approved_url_hash TEXT,",
      "evidence_hash TEXT,",
      "next_due_at INTEGER NOT NULL,last_sent_at INTEGER,",
      "sent_count INTEGER NOT NULL DEFAULT 0,",
      "status TEXT NOT NULL,status_reason TEXT NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS chat_continuation_commands(",
      "id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id),",
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,",
      "message TEXT NOT NULL,message_hash TEXT NOT NULL,",
      "state TEXT NOT NULL CHECK(state IN ('queued','claimed','sent','blocked','unknown')),",
      "created_at INTEGER NOT NULL,claimed_at INTEGER,finished_at INTEGER,",
      "reason TEXT NOT NULL,attempt INTEGER NOT NULL DEFAULT 0,",
      "UNIQUE(workstream_id,created_at)) STRICT;",
      "CREATE INDEX IF NOT EXISTS chat_commands_client_idx ON chat_continuation_commands(",
      "extension_id,state,created_at);"
    ].join(" "));
    this.db.exec("CREATE TABLE IF NOT EXISTS chat_response_observations ("+
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id) ON DELETE CASCADE,"+
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,"+
      "binding_fingerprint TEXT,reply_fingerprint TEXT,"+
      "first_seen_at INTEGER,verified_at INTEGER,sent_reply_fingerprint TEXT) STRICT");
    if(!this.db.prepare("PRAGMA table_info(chat_continuation_commands)").all()
      .some(c=>c.name==="source_reply_fingerprint"))
      this.db.exec("ALTER TABLE chat_continuation_commands ADD COLUMN source_reply_fingerprint TEXT");
    // Existing installations stored the workstream interval, not a user-approved
    // chat interval. Never silently migrate that implicit value into consent.
    const columns=this.db.prepare("PRAGMA table_info(chat_continuation_settings)").all();
    if(!columns.some(column=>column.name==="ci_resume_target_hash")){
      this.db.exec("ALTER TABLE chat_continuation_settings ADD COLUMN ci_resume_target_hash TEXT");
    }
    if(!columns.some(column=>column.name==="interval_minutes")){
      this.db.exec("ALTER TABLE chat_continuation_settings ADD COLUMN interval_minutes "+
        "INTEGER CHECK(interval_minutes BETWEEN 1 AND 1440)");
    }
    if(!columns.some(column=>column.name==="approved_session_key")){
      this.db.exec("ALTER TABLE chat_continuation_settings ADD COLUMN approved_session_key TEXT");
    }
    if(!columns.some(column=>column.name==="approved_url_hash"))
      this.db.exec("ALTER TABLE chat_continuation_settings ADD COLUMN approved_url_hash TEXT");
    // Existing campaigns had no evidence tying consent to a specific tab.
    // A reconnected/re-registered tab must not revive them without fresh approval.
    this.db.prepare(
      "UPDATE chat_continuation_settings SET enabled=0,status='paused',"+
      "status_reason='CHAT_SESSION_REAPPROVAL_REQUIRED_AFTER_UPGRADE' "+
      "WHERE enabled=1 AND approved_session_key IS NULL"
    ).run();
    this.db.prepare(
      "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='SESSION_REAPPROVAL_REQUIRED' "+
      "WHERE state='queued' AND workstream_id IN "+
      "(SELECT workstream_id FROM chat_continuation_settings WHERE approved_session_key IS NULL)"
    ).run(this.now());
    // Drop obsolete count and duration columns from existing installations.
    for(const obsolete of ["expires_at","max_messages"]){
      if(columns.some(column=>column.name===obsolete))
        this.db.exec("ALTER TABLE chat_continuation_settings DROP COLUMN "+obsolete);
    }
    this.db.prepare(
      "UPDATE chat_continuation_settings SET enabled=0,status='paused',"+
      "status_reason='INTERVAL_REQUIRES_EXPLICIT_REAPPROVAL' "+
      "WHERE interval_minutes IS NULL AND enabled=1"
    ).run();
    this.db.prepare(
      "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='INTERVAL_NOT_APPROVED' "+
      "WHERE state='queued' AND workstream_id IN "+
      "(SELECT workstream_id FROM chat_continuation_settings WHERE interval_minutes IS NULL)"
    ).run(this.now());
  }
  // Only paired, freshly linked extensions can receive a read-only challenge.
  requestObservations(extensionId){
    const now=this.now(), requests=[];
    for(const cfg of this.configs()){
      if(cfg.mode!=="scheduled"||
        (!cfg.enabled&&cfg.statusReason!=="MIGRATION_IN_PROGRESS"))continue;
      const link=this.linkedSession(cfg.workstreamId,now);
      if(!link||link.extensionId!==extensionId)continue;
      for(const [key,pending] of this.observationRequests){
        if(pending.expiresAt<now)this.observationRequests.delete(key);
      }
      if([...this.observationRequests.values()].some(p=>p.workstreamId===cfg.workstreamId))continue;
      const requestId=randomUUID();
      this.observationRequests.set(requestId,{extensionId,workstreamId:cfg.workstreamId,
        sessionKey:link.sessionKey,expiresAt:now+90_000});
      requests.push({requestId,workstreamId:cfg.workstreamId,
        sessionKey:link.sessionKey,permitted:true});
    }
    return requests;
  }
  acceptObservation(extensionId,{requestId,observation}={}){
    const pending=this.observationRequests.get(requestId);
    if(!pending||pending.extensionId!==extensionId||
      this.now()>pending.expiresAt)throw Error("OBSERVATION_REQUEST_INVALID_OR_EXPIRED");
    this.observationRequests.delete(requestId); // One response per challenge, even on rejection.
    const now=this.now(),cfg=this.config(pending.workstreamId);
    const link=this.linkedSession(pending.workstreamId,now);
    if((!cfg?.enabled&&cfg?.statusReason!=="MIGRATION_IN_PROGRESS")||
      cfg?.mode!=="scheduled"||
      link?.extensionId!==extensionId||link.sessionKey!==pending.sessionKey)
      throw Error("OBSERVATION_SESSION_CHANGED");
    const valid=observation?.schemaVersion===1&&
      observation.sourceVersion==="chat-observer-1"&&
      observation.source==="chatgpt-dom"&&observation.verified===true&&
      observation.assistantBusy===false&&observation.composerHasDraft===false&&
      observation.stopControlVerified===false&&observation.contentComplete===true&&
      observation.uiAmbiguous===false&&observation.connectionWarning===false&&
      observation.lengthWarning===false&&observation.providerRestriction===false&&
      observation.otherWarning===false&&observation.humanActionCue===false&&
      observation.scopeCompleteCue===false&&observation.ciWaitCue===false&&
      SHA256.test(observation.bindingFingerprint||"")&&
      SHA256.test(observation.replyFingerprint||"")&&
      Number.isSafeInteger(observation.observedAt)&&
      observation.observedAt>=now-30_000&&observation.observedAt<=now+5_000;
    const diagnosticFields=["verified","reasonCode","assistantBusy","composerHasDraft",
      "stopControlVerified","contentComplete","uiAmbiguous","connectionWarning",
      "lengthWarning","providerRestriction","otherWarning","humanActionCue",
      "scopeCompleteCue","ciWaitCue"];
    this.lastObservationDiagnostics.set(pending.workstreamId,{
      at:now,accepted:valid,flags:Object.fromEntries(diagnosticFields.map(k=>[k,
        ["boolean","string"].includes(typeof observation?.[k])?observation[k]:null])),
      hasBinding:SHA256.test(observation?.bindingFingerprint||""),
      hasReply:SHA256.test(observation?.replyFingerprint||""),
      hasTimestamp:Number.isSafeInteger(observation?.observedAt),
      dom:observation?.diagnostic&&typeof observation.diagnostic==="object"?{
        hasMessageId:observation.diagnostic.hasMessageId===true,
        hasReply:observation.diagnostic.hasReply===true,
        traversalIncomplete:observation.diagnostic.traversalIncomplete===true,
        currentRenderer:observation.diagnostic.currentRenderer===true,
        currentProof:observation.diagnostic.currentProof===true,
        threadForms:Number.isSafeInteger(observation.diagnostic.threadForms)?observation.diagnostic.threadForms:null,
        threadEditors:Number.isSafeInteger(observation.diagnostic.threadEditors)?observation.diagnostic.threadEditors:null,
        ignoredOutsideEditors:Number.isSafeInteger(observation.diagnostic.ignoredOutsideEditors)?observation.diagnostic.ignoredOutsideEditors:null,
        hiddenSkipped:Number.isSafeInteger(observation.diagnostic.hiddenSkipped)?observation.diagnostic.hiddenSkipped:null,
        unsafeEmbedded:Number.isSafeInteger(observation.diagnostic.unsafeEmbedded)?observation.diagnostic.unsafeEmbedded:null,
        nodeBudgetExceeded:observation.diagnostic.nodeBudgetExceeded===true,
        textBudgetExceeded:observation.diagnostic.textBudgetExceeded===true
      }:null});
    const observationSourceValid=observation?.schemaVersion===1&&
      observation.sourceVersion==="chat-observer-1"&&
      observation.source==="chatgpt-dom"&&observation.verified===true&&
      SHA256.test(observation.bindingFingerprint||"")&&
      Number.isSafeInteger(observation.observedAt)&&
      observation.observedAt>=now-30_000&&observation.observedAt<=now+5_000;
    const approval=observationSourceValid?
      this.approvals.observe(pending.workstreamId,extensionId,pending.sessionKey,observation):
      {accepted:false};
    if(approval.pending===true){
      // Migration already owns the pause reason. Do not overwrite its
      // restoration marker with an independent human-permission blocker.
      if(cfg.enabled)this.db.prepare("UPDATE chat_continuation_settings SET status='paused',"+
        "status_reason='WAITING_HUMAN_APPROVAL' WHERE workstream_id=?")
        .run(pending.workstreamId);
      this.db.prepare("UPDATE chat_continuation_commands SET state='blocked',"+
        "reason='WAITING_HUMAN_APPROVAL',finished_at=? "+
        "WHERE workstream_id=? AND state='queued'").run(now,pending.workstreamId);
    }
    if(approval.cleared===true&&cfg.enabled){
      this.db.prepare("UPDATE chat_continuation_settings SET status='armed',"+
        "status_reason='APPROVAL_CLEARED_WAIT_RESPONSE' "+
        "WHERE workstream_id=? AND status_reason='WAITING_HUMAN_APPROVAL'")
        .run(pending.workstreamId);
    }
    const old=this.db.prepare("SELECT * FROM chat_response_observations WHERE workstream_id=?")
      .get(pending.workstreamId);
    const same=valid&&old?.extension_id===extensionId&&
      old.session_key===pending.sessionKey&&
      old.binding_fingerprint===observation.bindingFingerprint&&
      old.reply_fingerprint===observation.replyFingerprint&&
      // Re-establish the stability window after each server restart. Otherwise
      // an unchanged reply retains a pre-restart firstSeenAt forever and can
      // never satisfy observationProof() until the assistant writes a new reply.
      old.first_seen_at>=this.observationStartedAt&&
      old.verified_at>=now-OBSERVATION_MAX_AGE_MS&&
      old.verified_at<=now;
    const first=same?old.first_seen_at:now;
    // Persist validated digests only, not the conversation, URL or text.
    this.db.prepare("INSERT INTO chat_response_observations "+
      "(workstream_id,extension_id,session_key,binding_fingerprint,reply_fingerprint,"+
      "first_seen_at,verified_at,sent_reply_fingerprint) VALUES(?,?,?,?,?,?,?,?) "+
      "ON CONFLICT(workstream_id) DO UPDATE SET extension_id=excluded.extension_id,"+
      "session_key=excluded.session_key,binding_fingerprint=excluded.binding_fingerprint,"+
      "reply_fingerprint=excluded.reply_fingerprint,first_seen_at=excluded.first_seen_at,"+
      "verified_at=excluded.verified_at")
      .run(pending.workstreamId,extensionId,pending.sessionKey,
        valid?observation.bindingFingerprint:null,valid?observation.replyFingerprint:null,
        valid?first:null,valid?now:null,old?.sent_reply_fingerprint||null);
    return {accepted:valid,stable:valid&&now-first>=OBSERVATION_MIN_STABLE_MS,
      waitingHumanApproval:this.approvals.active(pending.workstreamId)};
  }
  observationProof(id,now=this.now()){
    const row=this.db.prepare("SELECT * FROM chat_response_observations WHERE workstream_id=?").get(id);
    const link=this.linkedSession(id,now);
    if(!row||!link||row.extension_id!==link.extensionId||
      row.session_key!==link.sessionKey||!SHA256.test(row.binding_fingerprint||"")||
      !SHA256.test(row.reply_fingerprint||"")||
      row.reply_fingerprint===row.sent_reply_fingerprint||
      !Number.isSafeInteger(row.first_seen_at)||
      !Number.isSafeInteger(row.verified_at)||
      row.first_seen_at<this.observationStartedAt||
      now-row.first_seen_at<OBSERVATION_MIN_STABLE_MS||
      now-row.verified_at>OBSERVATION_MAX_AGE_MS||
      now<row.verified_at)return null;
    return {bindingFingerprint:row.binding_fingerprint,
      replyFingerprint:row.reply_fingerprint,ciWaitCue:false};
  }
  observationStates(){
    return this.db.prepare("SELECT workstream_id,first_seen_at,verified_at "+
      "FROM chat_response_observations").all().map(r=>({
        workstreamId:r.workstream_id,firstSeenAt:r.first_seen_at,verifiedAt:r.verified_at,
        ready:!!this.observationProof(r.workstream_id),
        diagnostic:this.lastObservationDiagnostics.get(r.workstream_id)||null
      }));
  }
  configs(){return this.db.prepare(
    "SELECT * FROM chat_continuation_settings ORDER BY workstream_id").all().map(rowConfig)}
  commands(limit=30){return this.db.prepare(
    "SELECT * FROM chat_continuation_commands ORDER BY created_at DESC LIMIT ?")
    .all(limit).map(rowCommand)}
  config(id){return rowConfig(this.db.prepare(
    "SELECT * FROM chat_continuation_settings WHERE workstream_id=?").get(id))}
  hasConfigured(id){return Boolean(this.config(id))}
  hasPending(id){return Boolean(this.db.prepare(
    "SELECT id FROM chat_continuation_commands WHERE workstream_id=? AND state IN ('queued','claimed') LIMIT 1").get(id))}
  linkedSession(id,now){
    const snapshot=this.bridge.getSnapshot(now);
    const matches=snapshot.links.filter(l=>l.workstreamId===id);
    if(matches.length!==1)return null;
    const link=matches[0];
    const session=snapshot.sessions.find(s=>s.extensionId===link.extensionId && s.sessionKey===link.sessionKey);
    if(!session||session.status!=="connected"||session.origin!=="https://chatgpt.com"||
       link.status!=="connected"||
       !snapshot.clients.some(c=>c.extensionId===link.extensionId&&c.status==="online"&&
        c.composerBuild===REQUIRED_COMPOSER_BUILD))return null;
    return link;
  }
  prerequisite(id,now){
    const stream=this.store.mustGet(id);
    if(this.store.isStopped())return "GLOBAL_STOP";
    if(!stream.enabled||stream.paused)return "WORKSTREAM_PAUSED";
    if(stream.active_operation_id || ["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN","BLOCKED","UNKNOWN"].includes(stream.state))
      return "WORKSTREAM_NOT_IDLE";
    if(!this.linkedSession(id,now))return "CHAT_SESSION_NOT_CONNECTED";
    if(this.hasPending(id))return "COMMAND_PENDING";
    const hasWatch=this.watchtower.targets.list().some(t=>t.workstreamId===id);
    const hasGit=this.github.targets.list().some(t=>t.workstreamId===id);
    if(hasWatch||hasGit){
      const decision=this.gate.one(id);
      const cfg=this.config(id);
      if(decision?.decision==="REVIEWED" &&
         typeof decision.evidenceHash==="string" && /^[a-f0-9]{64}$/.test(decision.evidenceHash))return null;
      if(!cfg)return "CI_PR_GATE_NOT_REVIEWED";
      // An operator-approved campaign retains its CI fingerprint beyond short-lived human-review
      // record, but ONLY while fresh Watchtower/GitHub evidence has the exact
      // same identity and checks fingerprint.
      if(!cfg?.evidenceHash || !decision?.evidenceHash ||
         cfg.evidenceHash!==decision.evidenceHash ||
         decision.decision!=="WAIT_HUMAN")
        return "CI_PR_EVIDENCE_CHANGED_OR_STALE";
    }
    return null;
  }
  configure(id,{enabled,mode="manual",message,intervalMinutes,ciResumeTargetHash=null}={}){
    const now=this.now();
    this.store.mustGet(id);
    if(typeof enabled!=="boolean"||!["manual","scheduled"].includes(mode) ||
       typeof message!=="string"||!message.trim()||message.length>MAX_TEXT||
       /[\0\r]/.test(message)||!Number.isSafeInteger(intervalMinutes)||
       intervalMinutes<1||intervalMinutes>1440){
      throw Error("INVALID_CONTINUATION_CONFIGURATION");
    }
    if(ciResumeTargetHash!==null && (!enabled||mode!=="scheduled"||
      typeof ciResumeTargetHash!=="string"||!/^[a-f0-9]{64}$/.test(ciResumeTargetHash)||
      !this.ciCandidates(true).some(c=>c.workstreamId===id&&c.targetHash===ciResumeTargetHash)))
      throw Error("CI_RESUME_EVIDENCE_NOT_REVIEWED");
    return this.store.transaction(()=>{
      if(enabled){
        const problem=this.prerequisite(id,now);
        if(problem)throw Error(problem);
      }
      const approvedLink=enabled?this.linkedSession(id,now):null;
      const old=this.config(id);
      if(old && this.hasPending(id))throw Error("COMMAND_PENDING");
      // Never reuse a pre-approval observation for a new campaign.
      this.db.prepare("DELETE FROM chat_response_observations WHERE workstream_id=?").run(id);
      const hasWatch=this.watchtower.targets.list().some(t=>t.workstreamId===id);
      const hasGit=this.github.targets.list().some(t=>t.workstreamId===id);
      const evidenceHash=enabled && (hasWatch||hasGit)
        ? this.gate.one(id)?.evidenceHash ?? null : null;
      const nextDue=enabled?now+intervalMinutes*60_000:0;
      this.db.prepare(
        "INSERT INTO chat_continuation_settings(workstream_id,enabled,mode,message,interval_minutes,approved_at,"+
         "next_due_at,last_sent_at,sent_count,status,status_reason,evidence_hash,ci_resume_target_hash,approved_session_key,approved_url_hash) "+
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET "+
        "enabled=excluded.enabled,mode=excluded.mode,message=excluded.message,"+
        "interval_minutes=excluded.interval_minutes,"+
        "approved_at=excluded.approved_at,"+
        "next_due_at=excluded.next_due_at,last_sent_at=excluded.last_sent_at,"+
        "sent_count=excluded.sent_count,"+
        "status=excluded.status,status_reason=excluded.status_reason,evidence_hash=excluded.evidence_hash,"+
        "ci_resume_target_hash=excluded.ci_resume_target_hash,approved_session_key=excluded.approved_session_key,"+
        "approved_url_hash=excluded.approved_url_hash"
      ).run(id,Number(enabled),mode,message.trim(),intervalMinutes,now,nextDue,null,0,
        enabled?"armed":"disabled",enabled?"EXPLICIT_OPERATOR_APPROVAL":"OPERATOR_DISABLED",evidenceHash,ciResumeTargetHash,approvedLink?.sessionKey||null,approvedLink?.urlHash||null);
      this.store.event(id,now,enabled?"chat_armed":"chat_disabled",null,null,
        enabled?"explicit_chat_session_only_no_codex":"manual_stop");
      return this.config(id);
    });
  }
  suspendForSessionChange(id){
    const now=this.now();
    return this.store.transaction(()=>{
      const cfg=this.config(id);
      if(!cfg||cfg.statusReason==="MIGRATION_IN_PROGRESS"||!cfg.enabled)return cfg;
      this.db.prepare(
        "UPDATE chat_continuation_settings SET enabled=0,status='paused',"+
        "status_reason='CHAT_SESSION_RECONNECTED_REAPPROVAL_REQUIRED' WHERE workstream_id=?"
      ).run(id);
      this.db.prepare(
        "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='SESSION_REAPPROVAL_REQUIRED' "+
        "WHERE workstream_id=? AND state='queued'"
      ).run(now,id);
      this.db.prepare("DELETE FROM chat_response_observations WHERE workstream_id=?").run(id);
      this.store.event(id,now,"chat_session_reapproval_required",null,null,
        "reconnected_or_changed_session_requires_explicit_approval");
      return this.config(id);
    });
  }
  stop(id){
    this.store.mustGet(id);
    return this.store.transaction(()=>{
      this.db.prepare(
        "UPDATE chat_continuation_settings SET enabled=0,status='disabled',status_reason='OPERATOR_DISABLED' "+
        "WHERE workstream_id=?").run(id);
      this.db.prepare(
        "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='OPERATOR_STOP' "+
        "WHERE workstream_id=? AND state='queued'"
      ).run(this.now(),id);
      this.store.event(id,this.now(),"chat_disabled",null,null,"manual_stop");
      return this.config(id);
    });
  }
  queue(id,{manual=false}={}){
    const now=this.now();
    return this.store.transaction(()=>{
      const cfg=this.config(id);
      if(!cfg||!cfg.enabled)throw Error("CHAT_CONTINUATION_NOT_APPROVED");
      const linked=this.linkedSession(id,now);
      if(!cfg.approvedSessionKey ||
        (linked && (linked.sessionKey!==cfg.approvedSessionKey ||
          (cfg.approvedUrlHash && linked.urlHash!==cfg.approvedUrlHash)))){
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=0,status='paused',"+
          "status_reason='CHAT_SESSION_REAPPROVAL_REQUIRED' WHERE workstream_id=?"
        ).run(id);
        this.db.prepare(
          "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='SESSION_REAPPROVAL_REQUIRED' "+
          "WHERE workstream_id=? AND state='queued'"
        ).run(now,id);
        return null;
      }
      if(!Number.isSafeInteger(cfg.intervalMinutes)||cfg.intervalMinutes<1||cfg.intervalMinutes>1440)
        throw Error("CHAT_INTERVAL_REQUIRES_EXPLICIT_APPROVAL");
      if(!manual && cfg.mode!=="scheduled")return null;
      if(cfg.ciResumeTargetHash && !this.ciCandidates(false).some(c=>
        c.workstreamId===id&&c.targetHash===cfg.ciResumeTargetHash)){
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',status_reason='CI_EVIDENCE_CHANGED_OR_STALE' WHERE workstream_id=?").run(id);
        return null;
      }
      if(now<cfg.nextDueAt && (!manual || cfg.lastSentAt!==null))return null;
      const reason=this.prerequisite(id,now);
      if(reason){
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',status_reason=? WHERE workstream_id=?")
          .run(reason,id);
        return null;
      }
      // A live tool permission dialog pauses this registered chat, not others.
      if(this.approvals.active(id)){
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',"+
          "status_reason='WAITING_HUMAN_APPROVAL' WHERE workstream_id=?").run(id);
        return null;
      }
      // Even a due schedule with valid approval has no right to send without a stable reply.
      if(cfg.mode==="scheduled"&&!this.observationProof(id,now)){
        this.db.prepare("UPDATE chat_continuation_settings SET status='waiting',"+
          "status_reason='RESPONSE_PROOF_REQUIRED' WHERE workstream_id=?").run(id);
        return null;
      }
      const link=this.linkedSession(id,now);
      if(!link)return null;
      const commandId=randomUUID();
      const proof=cfg.mode==="scheduled"?this.observationProof(id,now):null;
      this.db.prepare(
        "INSERT INTO chat_continuation_commands(id,workstream_id,extension_id,session_key,message,"+
        "message_hash,state,created_at,reason,source_reply_fingerprint) "+
        "VALUES(?,?,?,?,?,?,'queued',?,'RESERVED',?)"
      ).run(commandId,id,link.extensionId,link.sessionKey,cfg.message,digest(cfg.message),now,proof?.replyFingerprint||null);
      this.db.prepare(
        "UPDATE chat_continuation_settings SET status='queued',status_reason='WAIT_EXTENSION_CLAIM' WHERE workstream_id=?"
      ).run(id);
      this.store.event(id,now,"chat_queued",null,null,
        "explicit_approved_chat_prompt_queued",commandId);
      return {id:commandId,workstreamId:id,state:"queued"};
    });
  }
  tick(){
    const result=[];
    for(const cfg of this.configs()){
      if(!cfg.enabled||cfg.mode!=="scheduled")continue;
      try{
        const queued=this.queue(cfg.workstreamId);
        if(queued)result.push(queued);
      }catch(error){
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',status_reason=? WHERE workstream_id=?")
          .run(String(error.message).slice(0,90),cfg.workstreamId);
      }
    }
    return result;
  }
  claim(extensionId){
    const now=this.now();
    return this.store.transaction(()=>{
      const pending=this.db.prepare(
        "SELECT * FROM chat_continuation_commands WHERE extension_id=? AND state='queued' "+
        "ORDER BY created_at LIMIT 1").get(extensionId);
      if(!pending)return null;
      const cfg=this.config(pending.workstream_id);
      if(this.approvals.active(pending.workstream_id)){
        this.db.prepare("UPDATE chat_continuation_commands SET state='blocked',"+
          "finished_at=?,reason='WAITING_HUMAN_APPROVAL' WHERE id=?")
          .run(now,pending.id);
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',"+
          "status_reason='WAITING_HUMAN_APPROVAL' WHERE workstream_id=?")
          .run(pending.workstream_id);
        return null;
      }
      const proof=cfg?.mode==="scheduled"?this.observationProof(pending.workstream_id,now):null;
      if(!cfg?.enabled || (cfg.ciResumeTargetHash && !this.ciCandidates(false).some(c=>
         c.workstreamId===pending.workstream_id&&c.targetHash===cfg.ciResumeTargetHash)) ||
         (cfg.mode==="scheduled"&&(!proof||proof.replyFingerprint!==pending.source_reply_fingerprint))||
         this.prerequisiteIgnoringOwnCommand(pending,now)){
        this.db.prepare(
          "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='SAFETY_PRECONDITION_CHANGED' WHERE id=?"
        ).run(now,pending.id);
        this.db.prepare("UPDATE chat_continuation_settings SET enabled=0,status='paused',status_reason='SAFETY_PRECONDITION_CHANGED' WHERE workstream_id=?")
          .run(pending.workstream_id);
        return null;
      }
      this.db.prepare(
        "UPDATE chat_continuation_commands SET state='claimed',attempt=1,claimed_at=?,reason='EXTENSION_CLAIMED' WHERE id=?"
      ).run(now,pending.id);
      this.store.event(pending.workstream_id,now,"chat_claimed",null,null,
        "claimed_once_never_replay",pending.id);
      return { id:pending.id,workstreamId:pending.workstream_id,sessionKey:pending.session_key,
        message:pending.message,messageHash:pending.message_hash,claimedAt:now,
        ...(proof?{observationProof:proof}:{}) };
    });
  }
  prerequisiteIgnoringOwnCommand(command,now){
    const stream=this.store.mustGet(command.workstream_id);
    if(this.store.isStopped()||stream.paused||!stream.enabled||
       stream.active_operation_id||["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN","BLOCKED","UNKNOWN"].includes(stream.state))return true;
    const link=this.linkedSession(command.workstream_id,now);
    if(!link||link.extensionId!==command.extension_id||link.sessionKey!==command.session_key)return true;
    const cfg=this.config(command.workstream_id);
    if(cfg?.approvedSessionKey!==link.sessionKey||
       (cfg.approvedUrlHash && cfg.approvedUrlHash!==link.urlHash))return true;
    if(this.watchtower.targets.list().some(t=>t.workstreamId===stream.id) ||
       this.github.targets.list().some(t=>t.workstreamId===stream.id)){
      const review=this.gate.one(stream.id);
      const cfg=this.config(stream.id);
      if(review?.decision!=="REVIEWED" &&
         !(review?.decision==="WAIT_HUMAN" &&
           cfg?.evidenceHash && cfg.evidenceHash===review.evidenceHash))return true;
    }
    return false;
  }
  acknowledge(extensionId,id,status,reason=""){
    const now=this.now();
    if(!["sent","blocked","unknown"].includes(status)||typeof reason!=="string"||reason.length>100)
      throw Error("INVALID_CHAT_ACKNOWLEDGEMENT");
    return this.store.transaction(()=>{
      const command=this.db.prepare("SELECT * FROM chat_continuation_commands WHERE id=?").get(id);
      if(!command||command.extension_id!==extensionId||command.state!=="claimed")
        throw Error("CHAT_COMMAND_NOT_CLAIMED_BY_EXTENSION");
      const cfg=this.config(command.workstream_id);
      const safeReason=/^[A-Z0-9_]{0,100}$/.test(reason)?reason:"EXTENSION_STATUS";
      this.db.prepare(
        "UPDATE chat_continuation_commands SET state=?,finished_at=?,reason=? WHERE id=?"
      ).run(status,now,safeReason,id);
      if(status==="sent"){
        this.db.prepare(
          "UPDATE chat_continuation_settings SET sent_count=sent_count+1,last_sent_at=?,"+
          "next_due_at=?,status='sent',status_reason='MESSAGE_SUBMITTED_NOT_RESPONSE_VERIFIED' WHERE workstream_id=?"
        ).run(now,now+cfg.intervalMinutes*60_000,command.workstream_id);
        if(command.source_reply_fingerprint){
          this.db.prepare("UPDATE chat_response_observations SET sent_reply_fingerprint=?,"+
            "binding_fingerprint=NULL,reply_fingerprint=NULL,first_seen_at=NULL,verified_at=NULL "+
            "WHERE workstream_id=?").run(command.source_reply_fingerprint,command.workstream_id);
        }
      }else{
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=0,status=?,status_reason=? WHERE workstream_id=?"
        ).run(status,safeReason||"REQUIRES_OPERATOR",command.workstream_id);
      }
      this.store.event(command.workstream_id,now,"chat_"+status,null,null,
        "web_submission_"+status+"_no_output_extraction",id);
      return {id,state:status};
    });
  }
  // Bound to an authenticated Chrome extension's registered session via the
  // localhost bridge. Suspend recurring sends before migration starts.
  pauseForMigration(extensionId,sessionKey) {
    const link=this.bridge.getSnapshot(this.now()).links.find(l=>
      l.extensionId===extensionId && l.sessionKey===sessionKey);
    if(!link)return {workstreamId:null,previouslyScheduled:false};
    return this.store.transaction(()=>{
      const cfg=this.config(link.workstreamId);
      if(!cfg) return {workstreamId:link.workstreamId,previouslyScheduled:false};
      const wasScheduled=cfg.enabled && cfg.mode==="scheduled";
      if(cfg.enabled){
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=0,status='paused',status_reason='MIGRATION_IN_PROGRESS' WHERE workstream_id=?"
        ).run(link.workstreamId);
      }
      this.db.prepare(
        "UPDATE chat_continuation_commands SET state='blocked',finished_at=?,reason='MIGRATION_IN_PROGRESS' WHERE workstream_id=? AND state='queued'"
      ).run(this.now(),link.workstreamId);
      this.store.event(link.workstreamId,this.now(),"chat_migration_paused",
        null,null,"source_limit_migration_automatic_cutover");
      return {workstreamId:link.workstreamId,previouslyScheduled:wasScheduled};
    });
  }

  resumeAfterMigration(extensionId,sessionKey) {
    const now=this.now();
    const link=this.bridge.getSnapshot(now).links.find(l=>
      l.extensionId===extensionId && l.sessionKey===sessionKey &&
      l.status==="connected");
    if(!link){
      const stale=this.bridge.getSnapshot(now).links.some(l=>
        l.extensionId===extensionId&&l.sessionKey===sessionKey);
      if(stale)throw Error("MIGRATION_NEW_SESSION_NOT_SYNCED");
      return {workstreamId:null,resumed:false};
    }
    if(this.store.isStopped())throw Error("MIGRATION_GLOBAL_STOP_ACTIVE");
    if(this.approvals.active(link.workstreamId))
      return {workstreamId:link.workstreamId,resumed:false,
        reasonCode:"MIGRATION_WAITING_HUMAN_APPROVAL"};
    return this.store.transaction(()=>{
      const cfg=this.config(link.workstreamId);
      if(!cfg) return {workstreamId:link.workstreamId,resumed:false};
      if(cfg.statusReason==="MIGRATION_IN_PROGRESS" && cfg.mode==="scheduled" &&
        !this.hasPending(link.workstreamId)){
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=1,status='armed',status_reason='MIGRATION_AUTO_RESUMED',"+
          "approved_session_key=?,approved_url_hash=?,next_due_at=? WHERE workstream_id=?"
        ).run(link.sessionKey,link.urlHash||null,now+cfg.intervalMinutes*60_000,link.workstreamId);
        this.store.event(link.workstreamId,now,"chat_migration_resumed",
          null,null,"same_project_new_chat_rebound");
        return {workstreamId:link.workstreamId,resumed:true};
      }
      return {workstreamId:link.workstreamId,resumed:false};
    });
  }
  reconcile(){
    const now=this.now();
    return this.store.transaction(()=>{
      const stale=this.db.prepare(
        "SELECT * FROM chat_continuation_commands WHERE state='claimed' AND claimed_at<?"
      ).all(now-COMMAND_LEASE_MS);
      for(const cmd of stale){
        this.db.prepare(
          "UPDATE chat_continuation_commands SET state='unknown',finished_at=?,reason='CLAIM_TIMEOUT_NO_REPLAY' WHERE id=?"
        ).run(now,cmd.id);
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=0,status='unknown',status_reason='CLAIM_TIMEOUT_NO_REPLAY' WHERE workstream_id=?"
        ).run(cmd.workstream_id);
        this.store.event(cmd.workstream_id,now,"chat_unknown",null,null,
          "extension_receipt_absent_may_have_sent_no_retry",cmd.id);
      }
      return stale.length;
    });
  }
}

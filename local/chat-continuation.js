import { randomUUID, createHash } from "node:crypto";
import { REQUIRED_COMPOSER_BUILD } from "./chrome-bridge.js";

const MAX_APPROVAL_MS = 24 * 60 * 60_000;
const MAX_MESSAGES_PER_APPROVAL = 12;
const MAX_TEXT = 800;
const COMMAND_LEASE_MS = 2 * 60_000;
const digest = x => createHash("sha256").update(x).digest("hex");
const rowConfig = r => r ? ({
  workstreamId:r.workstream_id,enabled:Boolean(r.enabled),mode:r.mode,
  message:r.message,intervalMinutes:r.interval_minutes,
  approvedAt:r.approved_at,expiresAt:r.expires_at,
  evidenceHash:r.evidence_hash,
  nextDueAt:r.next_due_at,lastSentAt:r.last_sent_at,
  sentCount:r.sent_count,maxMessages:r.max_messages,status:r.status,
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
  constructor(store,{bridge,watchtower,github,gate,now=()=>Date.now()}={}){
    if(!bridge||!watchtower||!github||!gate)throw Error("Chat continuation requires identity and CI sources.");
    this.store=store;this.db=store.db;this.bridge=bridge;
    this.watchtower=watchtower;this.github=github;this.gate=gate;this.now=now;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS chat_continuation_settings(",
      "workstream_id TEXT PRIMARY KEY REFERENCES workstreams(id),",
      "enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),",
      "mode TEXT NOT NULL CHECK(mode IN ('manual','scheduled')),",
      "message TEXT NOT NULL,interval_minutes INTEGER CHECK(interval_minutes BETWEEN 1 AND 1440),"+
      "approved_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,",
      "evidence_hash TEXT,",
      "next_due_at INTEGER NOT NULL,last_sent_at INTEGER,",
      "sent_count INTEGER NOT NULL DEFAULT 0,max_messages INTEGER NOT NULL,",
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
    // Existing installations stored the workstream interval, not a user-approved
    // chat interval. Never silently migrate that implicit value into consent.
    const columns=this.db.prepare("PRAGMA table_info(chat_continuation_settings)").all();
    if(!columns.some(column=>column.name==="interval_minutes")){
      this.db.exec("ALTER TABLE chat_continuation_settings ADD COLUMN interval_minutes "+
        "INTEGER CHECK(interval_minutes BETWEEN 1 AND 1440)");
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
      // A bounded operator campaign approval survives the short-lived human-review
      // record, but ONLY while fresh Watchtower/GitHub evidence has the exact
      // same identity and checks fingerprint.
      if(!cfg?.evidenceHash || !decision?.evidenceHash ||
         cfg.evidenceHash!==decision.evidenceHash ||
         decision.decision!=="WAIT_HUMAN")
        return "CI_PR_EVIDENCE_CHANGED_OR_STALE";
    }
    return null;
  }
  configure(id,{enabled,mode="manual",message,intervalMinutes,hours=24,maxMessages=MAX_MESSAGES_PER_APPROVAL}={}){
    const now=this.now();
    this.store.mustGet(id);
    if(typeof enabled!=="boolean"||!["manual","scheduled"].includes(mode) ||
       typeof message!=="string"||!message.trim()||message.length>MAX_TEXT||
       /[\0\r]/.test(message)||!Number.isSafeInteger(intervalMinutes)||
       intervalMinutes<1||intervalMinutes>1440||!Number.isSafeInteger(hours)||hours<1||hours>24 ||
       !Number.isSafeInteger(maxMessages)||maxMessages<1||maxMessages>MAX_MESSAGES_PER_APPROVAL){
      throw Error("INVALID_CONTINUATION_CONFIGURATION");
    }
    return this.store.transaction(()=>{
      if(enabled){
        const problem=this.prerequisite(id,now);
        if(problem)throw Error(problem);
      }
      const old=this.config(id);
      if(old && this.hasPending(id))throw Error("COMMAND_PENDING");
      const hasWatch=this.watchtower.targets.list().some(t=>t.workstreamId===id);
      const hasGit=this.github.targets.list().some(t=>t.workstreamId===id);
      const evidenceHash=enabled && (hasWatch||hasGit)
        ? this.gate.one(id)?.evidenceHash ?? null : null;
      const expires=enabled?now+hours*60*60_000:now;
      const nextDue=enabled?now+intervalMinutes*60_000:0;
      this.db.prepare(
        "INSERT INTO chat_continuation_settings(workstream_id,enabled,mode,message,interval_minutes,approved_at,expires_at,"+
        "next_due_at,last_sent_at,sent_count,max_messages,status,status_reason,evidence_hash) "+
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workstream_id) DO UPDATE SET "+
        "enabled=excluded.enabled,mode=excluded.mode,message=excluded.message,"+
        "interval_minutes=excluded.interval_minutes,"+
        "approved_at=excluded.approved_at,expires_at=excluded.expires_at,"+
        "next_due_at=excluded.next_due_at,last_sent_at=excluded.last_sent_at,"+
        "sent_count=excluded.sent_count,max_messages=excluded.max_messages,"+
        "status=excluded.status,status_reason=excluded.status_reason,evidence_hash=excluded.evidence_hash"
      ).run(id,Number(enabled),mode,message.trim(),intervalMinutes,now,expires,nextDue,null,0,maxMessages,
        enabled?"armed":"disabled",enabled?"EXPLICIT_OPERATOR_APPROVAL":"OPERATOR_DISABLED",evidenceHash);
      this.store.event(id,now,enabled?"chat_armed":"chat_disabled",null,null,
        enabled?"explicit_chat_session_only_no_codex":"manual_stop");
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
      if(!Number.isSafeInteger(cfg.intervalMinutes)||cfg.intervalMinutes<1||cfg.intervalMinutes>1440)
        throw Error("CHAT_INTERVAL_REQUIRES_EXPLICIT_APPROVAL");
      if(now>=cfg.expiresAt || cfg.sentCount>=cfg.maxMessages){
        this.db.prepare("UPDATE chat_continuation_settings SET enabled=0,status='expired',status_reason='APPROVAL_LIMIT' WHERE workstream_id=?").run(id);
        return null;
      }
      if(!manual && cfg.mode!=="scheduled")return null;
      if(now<cfg.nextDueAt && (!manual || cfg.lastSentAt!==null))return null;
      const reason=this.prerequisite(id,now);
      if(reason){
        this.db.prepare("UPDATE chat_continuation_settings SET status='paused',status_reason=? WHERE workstream_id=?")
          .run(reason,id);
        return null;
      }
      const link=this.linkedSession(id,now);
      if(!link)return null;
      const commandId=randomUUID();
      this.db.prepare(
        "INSERT INTO chat_continuation_commands(id,workstream_id,extension_id,session_key,message,"+
        "message_hash,state,created_at,reason) VALUES(?,?,?,?,?,?,'queued',?,'RESERVED')"
      ).run(commandId,id,link.extensionId,link.sessionKey,cfg.message,digest(cfg.message),now);
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
        // Expiration itself is safe. All other issues remain observable.
        if(error.message!=="CHAT_APPROVAL_EXPIRED_OR_LIMIT"){
          this.db.prepare("UPDATE chat_continuation_settings SET status='paused',status_reason=? WHERE workstream_id=?")
            .run(String(error.message).slice(0,90),cfg.workstreamId);
        }
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
      if(!cfg?.enabled||now>=cfg.expiresAt||
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
        message:pending.message,messageHash:pending.message_hash,claimedAt:now };
    });
  }
  prerequisiteIgnoringOwnCommand(command,now){
    const stream=this.store.mustGet(command.workstream_id);
    if(this.store.isStopped()||stream.paused||!stream.enabled||
       stream.active_operation_id||["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN","BLOCKED","UNKNOWN"].includes(stream.state))return true;
    const link=this.linkedSession(command.workstream_id,now);
    if(!link||link.extensionId!==command.extension_id||link.sessionKey!==command.session_key)return true;
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
    if(!link)throw Error("MIGRATION_NEW_SESSION_NOT_SYNCED");
    if(this.store.isStopped())throw Error("MIGRATION_GLOBAL_STOP_ACTIVE");
    return this.store.transaction(()=>{
      const cfg=this.config(link.workstreamId);
      if(!cfg) return {workstreamId:link.workstreamId,resumed:false};
      if(cfg.statusReason==="MIGRATION_IN_PROGRESS" && cfg.mode==="scheduled" &&
        cfg.expiresAt>now && cfg.sentCount<cfg.maxMessages &&
        !this.hasPending(link.workstreamId)){
        this.db.prepare(
          "UPDATE chat_continuation_settings SET enabled=1,status='armed',status_reason='MIGRATION_AUTO_RESUMED',next_due_at=? WHERE workstream_id=?"
        ).run(now+cfg.intervalMinutes*60_000,link.workstreamId);
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

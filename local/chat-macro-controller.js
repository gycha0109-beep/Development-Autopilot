import {createHash,randomUUID} from "node:crypto";
import {REQUIRED_COMPOSER_BUILD} from "./chrome-bridge.js";
import {verifiedCiFailure} from "./chat-ci-signal.js";
import {sendWindowsTelegramText} from "./windows-telegram-compat.js";

const digest=x=>createHash("sha256").update(JSON.stringify(x)).digest("hex");
const SHA=/^[a-f0-9]{64}$/;
const STABILITY_MS=30_000,OBS_MAX_MS=150_000;
const MACRO_KEYS=["general","ci_red","roadmap","blocker","network","disconnect","migration"];
export const DEFAULT_MACROS=Object.freeze({
  general:"로드맵과 현재 완료 상태를 확인한 뒤 다음 우선순위 작업을 계속 진행해 주세요. 완료/남은 과제/다음 작업/블로커를 간결하게 보고하고 승인 필요 시 실행하지 마세요.",
  ci_red:"현재 CI 실패의 저장소, Run ID, Attempt, HEAD SHA와 실패 원인을 확인하고 수정·재검증해 주세요. 정확한 근거가 없다면 판단을 보류하세요.",
  roadmap:"현재 로드맵의 완료 작업, 미완료 단계, 다음 작업, 승인 사항을 간결하게 보고해 주세요.",
  blocker:"막힌 원인과 필요한 사용자 결정, 선택 가능한 안전한 절차를 정리해 주세요. 승인 전에는 진행하지 마세요.",
  network:"네트워크 오류의 원인과 복구 절차를 점검해 주세요. 전송 결과가 불확실한 작업은 중복 실행하지 마세요.",
  disconnect:"연결이 끊긴 원인과 재연결 방법을 안내해 주세요. 설정과 기존 결과는 보존하고 미확인 작업은 재전송하지 마세요.",
  migration:"현재 대화의 목적, 확정된 결정, 구현 결과, 미완료 작업, 관련 저장소와 파일, 다음 실행 절차를 누락 없이 이관 문서로 정리해 주세요. 이관 실행에는 확인을 요청하세요."
});
const row=r=>r?({extensionId:r.extension_id,sessionKey:r.session_key,enabled:!!r.enabled,
  mode:r.mode,intervalMinutes:r.interval_minutes,status:r.status,reason:r.reason,
  approvedUrlHash:r.url_hash,updatedAt:r.updated_at,lastMacro:r.last_macro,
  lastReplyFingerprint:r.last_reply,lastSentAt:r.last_sent_at,
  repository:r.repository||null,lastCiIdentity:r.last_ci_identity||null}):null;
const reason=s=>/^[A-Z][A-Z0-9_]{1,99}$/.test(s||"")?s:"MACRO_REQUIRES_OPERATOR";
const observed=o=>o?.schemaVersion===1&&o.sourceVersion==="chat-observer-1"&&
  o.source==="chatgpt-dom"&&o.verified===true&&SHA.test(o.bindingFingerprint||"")&&
  SHA.test(o.replyFingerprint||"")&&Number.isSafeInteger(o.observedAt);
export function classifyMacroObservation(o,{lastMacro=null}={}){
  if(!observed(o))return {kind:"hold",reason:"OBSERVATION_UNVERIFIED"};
  if(o.lengthWarning===true)return {kind:"hold",macro:"migration",reason:"CHAT_LENGTH_MIGRATION_REQUIRED"};
  if(o.connectionWarning===true)return {kind:"hold",macro:"network",reason:"NETWORK_RECOVERY_REQUIRED"};
  if(o.humanActionCue===true||o.providerRestriction===true)
    return {kind:"hold",macro:"blocker",reason:"USER_APPROVAL_OR_PROVIDER_BLOCKER"};
  if(o.ciWaitCue===true)return {kind:"hold",reason:"CI_STATUS_NEEDS_VERIFIED_EVIDENCE"};
  if(["lengthWarning","connectionWarning","providerRestriction","humanActionCue",
      "ciWaitCue","scopeCompleteCue","otherWarning","uiAmbiguous",
      "stopControlVerified","contentComplete","composerHasDraft"].some(k=>typeof o[k]!=="boolean"))
    return {kind:"hold",reason:"OBSERVATION_FLAGS_INCOMPLETE"};
  if(o.uiAmbiguous!==false||o.otherWarning===true)return {kind:"hold",reason:"CHAT_UI_UNCERTAIN"};
  if(o.assistantBusy!==false||o.stopControlVerified!==false||
    o.composerHasDraft!==false||o.contentComplete!==true)
    return {kind:"wait",reason:"REPLY_NOT_READY"};
  return {kind:"send",macro:o.scopeCompleteCue===true&&lastMacro!=="roadmap"?"roadmap":"general",
    reason:"VERIFIED_REPLY_COMPLETE"};
}

export class ChatMacroController {
  constructor(store,{bridge,now=()=>Date.now()}={}){
    if(!bridge)throw Error("MACRO_BRIDGE_REQUIRED");
    this.store=store;this.bridge=bridge;this.db=store.db;this.now=now;
    this.startedAt=now();this.challenges=new Map();this.ciProvider=()=>null;
    this.alertEnabled=process.env.AUTOPILOT_TELEGRAM_ENABLED==="1"&&
      process.env.AUTOPILOT_MACRO_ALERTS_ENABLED==="1";
    this.sendAlert=sendWindowsTelegramText;this.alertBusy=false;
    this.db.exec([
      "CREATE TABLE IF NOT EXISTS macro_sessions(",
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,url_hash TEXT NOT NULL,",
      "enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),mode TEXT NOT NULL CHECK(mode IN ('auto','manual')),",
      "interval_minutes INTEGER NOT NULL CHECK(interval_minutes BETWEEN 1 AND 1440),",
      "status TEXT NOT NULL,reason TEXT NOT NULL,updated_at INTEGER NOT NULL,",
      "last_reply TEXT,last_macro TEXT,last_sent_at INTEGER,next_due INTEGER NOT NULL,",
      "PRIMARY KEY(extension_id,session_key)) STRICT;",
      "CREATE TABLE IF NOT EXISTS macro_templates(",
      "extension_id TEXT NOT NULL,macro_key TEXT NOT NULL,prompt TEXT NOT NULL,",
      "PRIMARY KEY(extension_id,macro_key)) STRICT;",
      "CREATE TABLE IF NOT EXISTS macro_proofs(",
      "proof_key TEXT PRIMARY KEY,binding TEXT NOT NULL,reply TEXT NOT NULL,",
      "first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS macro_commands(",
      "id TEXT PRIMARY KEY,extension_id TEXT NOT NULL,session_key TEXT NOT NULL,",
      "macro_key TEXT NOT NULL,message TEXT NOT NULL,binding TEXT,reply TEXT,url_hash TEXT NOT NULL,",
      "state TEXT NOT NULL CHECK(state IN ('queued','claimed','sent','blocked','unknown')),",
      "created_at INTEGER NOT NULL,claimed_at INTEGER,finished_at INTEGER,reason TEXT NOT NULL) STRICT;",
      "CREATE INDEX IF NOT EXISTS macro_commands_idx ON macro_commands(extension_id,state,created_at);",
      "CREATE TABLE IF NOT EXISTS macro_alerts(",
      "alert_key TEXT PRIMARY KEY,extension_id TEXT NOT NULL,session_key TEXT NOT NULL,",
      "kind TEXT NOT NULL,reason TEXT NOT NULL,",
      "state TEXT NOT NULL CHECK(state IN ('pending','claimed','accepted','unknown','suppressed')),",
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;",
      "CREATE TABLE IF NOT EXISTS macro_recovery(",
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,kind TEXT NOT NULL,",
      "state TEXT NOT NULL CHECK(state IN ('recovering','attention','recovered')),",
      "attempts INTEGER NOT NULL DEFAULT 0,next_due INTEGER NOT NULL,",
      "started_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,",
      "operation_id TEXT,operation_state TEXT,reason TEXT NOT NULL,",
      "PRIMARY KEY(extension_id,session_key)) STRICT;"
    ].join(" "));
    const previouslyClaimed=this.db.prepare("SELECT extension_id,session_key FROM macro_commands WHERE state='claimed'").all();
    this.db.prepare("UPDATE macro_commands SET state='unknown',finished_at=?,reason='RESTART_UNCERTAIN_NO_REPLAY' WHERE state='claimed'")
      .run(now());
    for(const claimed of previouslyClaimed)this.pause(claimed.extension_id,claimed.session_key,
      "RESTART_UNCERTAIN_NO_REPLAY");
    this.db.prepare("UPDATE macro_recovery SET operation_state='unknown' WHERE operation_state='claimed'")
      .run();
    this.db.prepare("UPDATE macro_alerts SET state='unknown' WHERE state='claimed'").run();
    const sessionColumns=this.db.prepare("PRAGMA table_info(macro_sessions)").all().map(x=>x.name);
    if(!sessionColumns.includes("repository"))
      this.db.exec("ALTER TABLE macro_sessions ADD COLUMN repository TEXT");
    if(!sessionColumns.includes("last_ci_identity"))
      this.db.exec("ALTER TABLE macro_sessions ADD COLUMN last_ci_identity TEXT");
    const commandColumns=this.db.prepare("PRAGMA table_info(macro_commands)").all().map(x=>x.name);
    if(!commandColumns.includes("ci_identity"))
      this.db.exec("ALTER TABLE macro_commands ADD COLUMN ci_identity TEXT");
    if(!commandColumns.includes("ci_wait"))
      this.db.exec("ALTER TABLE macro_commands ADD COLUMN ci_wait INTEGER NOT NULL DEFAULT 0");
  }
  setCIProvider(provider){
    if(typeof provider!=="function")throw Error("MACRO_CI_PROVIDER_INVALID");
    this.ciProvider=provider;
  }
  ciFailure(repository){
    const data=this.ciProvider()||{};
    return verifiedCiFailure({...data,repository,now:this.now()});
  }
  migrationTargets(extensionId){
    return this.list(extensionId).filter(x=>x.enabled&&x.mode==="auto"&&
      x.repository&&x.status!=="needs_attention"&&x.status!=="paused")
      .map(x=>({sessionKey:x.sessionKey,repository:x.repository,
        sourceKind:"chat-macro"}));
  }
  generalMigrationTargets(extensionId){
    return this.list(extensionId).filter(x=>x.enabled&&x.mode==="auto"&&
      x.status!=="needs_attention"&&x.status!=="paused")
      .map(x=>({sessionKey:x.sessionKey,sourceKind:"chat-macro-general",
        migrationStatus:x.status}));
  }
  reportMigrationFailure(extensionId,{sessionKey,reason:why}={}){
    if(typeof sessionKey!=="string"||typeof why!=="string"||
      !/^[A-Z0-9_]{5,100}$/.test(why))
      throw Error("MACRO_MIGRATION_FAILURE_INVALID");
    const cfg=this.get(extensionId,sessionKey);
    if(!cfg?.enabled||cfg.mode!=="auto")return {accepted:false};
    this.pause(extensionId,sessionKey,"GENERIC_MIGRATION_NEEDS_ATTENTION");
    return {accepted:true,status:"needs_attention"};
  }
  pauseForMigration(extensionId,sessionKey,{generic=false}={}){
    if(this.store.isStopped())throw Error("MACRO_MIGRATION_GLOBAL_STOP");
    const cfg=this.get(extensionId,sessionKey);
    if(!cfg?.enabled||cfg.mode!=="auto"||(!generic&&!cfg.repository))
      throw Error("MACRO_MIGRATION_NOT_ARMED");
    if(this.pending(extensionId,sessionKey))
      throw Error("MACRO_MIGRATION_PENDING_MESSAGE");
    this.chat(extensionId,sessionKey);
    this.db.prepare("UPDATE macro_sessions SET status='migrating',reason='MIGRATION_IN_PROGRESS',updated_at=?"+
      " WHERE extension_id=? AND session_key=? AND enabled=1")
      .run(this.now(),extensionId,sessionKey);
    return {workstreamId:null,previouslyScheduled:true,macroSession:true};
  }
  resumeAfterMigration(extensionId,sessionKey,{generic=false}={}){
    if(this.store.isStopped())throw Error("MACRO_MIGRATION_GLOBAL_STOP");
    const cfg=this.get(extensionId,sessionKey);
    if(!cfg?.enabled||cfg.status!=="migrating"||(!generic&&!cfg.repository))
      throw Error("MACRO_MIGRATION_NOT_IN_PROGRESS");
    const latest=this.chat(extensionId,sessionKey);
    if(latest.urlHash===cfg.approvedUrlHash)
      throw Error("MACRO_MIGRATION_TARGET_NOT_CHANGED");
    if(this.pending(extensionId,sessionKey))
      throw Error("MACRO_MIGRATION_COMMAND_IN_FLIGHT");
    this.db.prepare("UPDATE macro_sessions SET url_hash=?,last_reply=NULL,last_macro=NULL,"+
      "next_due=?,status='armed',reason='MIGRATION_VERIFIED_WAIT_NEXT_REPLY',updated_at=?"+
      " WHERE extension_id=? AND session_key=? AND status='migrating'")
      .run(latest.urlHash,this.now()+cfg.intervalMinutes*60_000,this.now(),extensionId,sessionKey);
    this.db.prepare("DELETE FROM macro_proofs WHERE proof_key=?")
      .run(digest([extensionId,sessionKey]));
    return {workstreamId:null,resumed:true,macroSession:true};
  }
  list(extensionId){
    return this.db.prepare("SELECT * FROM macro_sessions WHERE extension_id=? ORDER BY updated_at DESC")
      .all(extensionId).map(row);
  }
  get(extensionId,key){
    return row(this.db.prepare("SELECT * FROM macro_sessions WHERE extension_id=? AND session_key=?")
      .get(extensionId,key));
  }
  templates(extensionId){
    const result={...DEFAULT_MACROS};
    for(const r of this.db.prepare("SELECT macro_key,prompt FROM macro_templates WHERE extension_id=?").all(extensionId))
      result[r.macro_key]=r.prompt;
    return result;
  }
  recordAlert(extensionId,sessionKey,kind,why){
    const now=this.now(),event=digest([extensionId,sessionKey,kind,why,
      Math.floor(now/86_400_000)]);
    this.db.prepare("INSERT OR IGNORE INTO macro_alerts("+
      "alert_key,extension_id,session_key,kind,reason,state,created_at,updated_at)"+
      " VALUES(?,?,?,?,?,?,?,?)")
      .run(event,extensionId,sessionKey,kind,reason(why),
        this.alertEnabled?"pending":"suppressed",now,now);
  }
  async drainAlerts(){
    if(!this.alertEnabled||this.alertBusy)return {status:"disabled_or_busy"};
    this.alertBusy=true;
    try{
      const now=this.now(),day=Math.floor(now/86_400_000)*86_400_000;
      const count=this.db.prepare("SELECT count(*) AS n FROM macro_alerts "+
        "WHERE state IN ('claimed','accepted','unknown') AND updated_at>=?")
        .get(day).n;
      if(count>=12)return {status:"budget_exceeded"};
      const next=this.db.prepare("SELECT * FROM macro_alerts WHERE state='pending' "+
        "ORDER BY created_at,alert_key LIMIT 1").get();
      if(!next)return {status:"empty"};
      this.db.prepare("UPDATE macro_alerts SET state='claimed',updated_at=? WHERE alert_key=? AND state='pending'")
        .run(now,next.alert_key);
      const chat=this.bridge.getSnapshot(this.now()).sessions.find(x=>
        x.extensionId===next.extension_id&&x.sessionKey===next.session_key);
      const safeTitle=String(chat?.title||"??? ??").replace(/[\r\n\x00-\x1f]/g," ").slice(0,80);
      const message=["[Development Autopilot] ?? ?? ??",
        "??: "+safeTitle,"??: "+next.kind,
        "??: "+next.reason,
        "?? ?? ??? ??? ???? ?? ?? ???? ?????.",
        "? ??? ???? ?? ???? ?? ??? ????? ????."].join("\n");
      let status="unknown";
      try{if(await this.sendAlert(message)===true)status="accepted";}catch{}
      this.db.prepare("UPDATE macro_alerts SET state=?,updated_at=? WHERE alert_key=? AND state='claimed'")
        .run(status,this.now(),next.alert_key);
      return {status};
    }finally{this.alertBusy=false;}
  }
  alerts(extensionId){
    return this.db.prepare("SELECT session_key AS sessionKey,kind,reason,state,created_at AS createdAt "+
      "FROM macro_alerts WHERE extension_id=? ORDER BY created_at DESC LIMIT 30")
      .all(extensionId);
  }
  recovery(extensionId,sessionKey){
    const r=this.db.prepare("SELECT * FROM macro_recovery WHERE extension_id=? AND session_key=?")
      .get(extensionId,sessionKey);
    return r?{kind:r.kind,state:r.state,attempts:r.attempts,nextDue:r.next_due,
      operationId:r.operation_id,operationState:r.operation_state,reason:r.reason}:null;
  }
  recoveries(extensionId){
    return this.db.prepare("SELECT extension_id AS extensionId,session_key AS sessionKey,"+
      "kind,state,attempts,next_due AS nextDue,reason FROM macro_recovery WHERE extension_id=?")
      .all(extensionId);
  }
  // Situations recover autonomously. Only exhausted recovery or unsafe proof
  // escalates to an operator; never replay a message whose delivery is uncertain.
  beginRecovery(extensionId,sessionKey,kind,{observation=null}={}){
    if(!["network","disconnect"].includes(kind))throw Error("MACRO_RECOVERY_KIND_INVALID");
    const now=this.now(),old=this.db.prepare(
      "SELECT * FROM macro_recovery WHERE extension_id=? AND session_key=?")
      .get(extensionId,sessionKey);
    if(old?.kind===kind&&old.state==="attention")return {status:"attention"};
    if(old?.kind===kind&&old.state==="recovering"&&now<old.next_due)
      return {status:"waiting",nextDue:old.next_due};
    const attempts=(old?.kind===kind&&old.state==="recovering"?old.attempts:0)+1;
    const interval=Math.min(5*60_000,30_000*2**Math.min(attempts-1,4));
    const exhausted=attempts>=5;
    const issue=kind==="network"?"NETWORK_RECOVERY_IN_PROGRESS":"CONNECTION_REATTACH_IN_PROGRESS";
    const operationEligible=kind==="network"&&attempts===1&&
      observation?.assistantBusy===true&&observation?.stopControlVerified===true&&
      observation?.connectionWarning===true&&observation?.composerHasDraft===false&&
      observation?.humanActionCue===false&&observation?.providerRestriction===false&&
      observation?.uiAmbiguous===false&&!this.store.isStopped();
    const operationId=operationEligible?randomUUID():null;
    const previousOp=old?.kind===kind?old.operation_id:null;
    this.db.prepare(
      "INSERT INTO macro_recovery(extension_id,session_key,kind,state,attempts,next_due,"+
      "started_at,updated_at,operation_id,operation_state,reason) VALUES(?,?,?,?,?,?,?,?,?,?,?) "+
      "ON CONFLICT(extension_id,session_key) DO UPDATE SET "+
      "kind=excluded.kind,state=excluded.state,attempts=excluded.attempts,next_due=excluded.next_due,"+
      "started_at=excluded.started_at,updated_at=excluded.updated_at,"+
      "operation_id=excluded.operation_id,operation_state=excluded.operation_state,reason=excluded.reason"
    ).run(extensionId,sessionKey,kind,exhausted?"attention":"recovering",attempts,
      now+interval,old?.kind===kind?old.started_at:now,now,
      previousOp||operationId,previousOp?old.operation_state:operationId?"prepared":null,
      exhausted?"RECOVERY_RETRIES_EXHAUSTED":issue);
    this.db.prepare("UPDATE macro_sessions SET status=?,reason=?,updated_at=? "+
      "WHERE extension_id=? AND session_key=? AND enabled=1")
      .run(exhausted?"needs_attention":"recovering",exhausted?"RECOVERY_RETRIES_EXHAUSTED":issue,
        now,extensionId,sessionKey);
    if(exhausted)this.recordAlert(extensionId,sessionKey,"recovery_exhausted",
      "RECOVERY_RETRIES_EXHAUSTED");
    return {status:exhausted?"attention":"recovering",attempts,
      ...(operationId?{recoveryAction:{operationId,sessionKey,
        kind:"verified-disconnect-stop",bindingFingerprint:observation.bindingFingerprint}}:{})};
  }
  authorizeRecovery(extensionId,{operationId,sessionKey,bindingFingerprint,observation}={}){
    if(this.store.isStopped())return {authorized:false,reason:"GLOBAL_STOP_ACTIVE"};
    const event=this.db.prepare("SELECT * FROM macro_recovery WHERE extension_id=? AND session_key=? AND operation_id=?")
      .get(extensionId,sessionKey,operationId);
    const cfg=this.get(extensionId,sessionKey);
    let live=null;try{live=this.chat(extensionId,sessionKey);}catch{}
    if(!event||event.kind!=="network"||event.state!=="recovering"||
      event.operation_state!=="prepared"||!cfg?.enabled||!live||
      live.urlHash!==cfg.approvedUrlHash||this.pending(extensionId,sessionKey)||
      !observed(observation)||observation.bindingFingerprint!==bindingFingerprint||
      observation.connectionWarning!==true||observation.assistantBusy!==true||
      observation.stopControlVerified!==true||observation.composerHasDraft!==false||
      observation.uiAmbiguous!==false||observation.humanActionCue!==false||
      observation.providerRestriction!==false||
      !Number.isSafeInteger(observation.observedAt)||
      Math.abs(this.now()-observation.observedAt)>30_000)
      return {authorized:false,reason:"RECOVERY_PRECONDITION_CHANGED"};
    const claim=this.db.prepare("UPDATE macro_recovery SET operation_state='claimed',updated_at=? "+
      "WHERE extension_id=? AND session_key=? AND operation_id=? AND operation_state='prepared'")
      .run(this.now(),extensionId,sessionKey,operationId);
    return {authorized:claim.changes===1};
  }
  acknowledgeRecovery(extensionId,{operationId,outcome}={}){
    if(typeof operationId!=="string"||!["clicked","refused","unknown"].includes(outcome))
      throw Error("MACRO_RECOVERY_ACK_INVALID");
    const previous=this.db.prepare("SELECT * FROM macro_recovery WHERE extension_id=? AND operation_id=?")
      .get(extensionId,operationId);
    if(!previous||!["claimed","prepared"].includes(previous.operation_state)||
      (outcome==="clicked"&&previous.operation_state!=="claimed"))
      throw Error("MACRO_RECOVERY_ALREADY_CONSUMED");
    this.db.prepare("UPDATE macro_recovery SET operation_state=?,updated_at=? "+
      "WHERE extension_id=? AND operation_id=? AND operation_state=?")
      .run(outcome,this.now(),extensionId,operationId,previous.operation_state);
    return {accepted:true,outcome};
  }
  resolveRecovery(extensionId,key){
    const old=this.recovery(extensionId,key);
    if(!old||old.state==="recovered")return old;
    this.db.prepare("UPDATE macro_recovery SET state='recovered',reason='VERIFIED_RECOVERY_COMPLETED',updated_at=?"+
      " WHERE extension_id=? AND session_key=?")
      .run(this.now(),extensionId,key);
    this.db.prepare("UPDATE macro_sessions SET status='armed',reason='RECOVERED_WAIT_FRESH_REPLY',updated_at=?"+
      " WHERE extension_id=? AND session_key=? AND enabled=1")
      .run(this.now(),extensionId,key);
    this.recordAlert(extensionId,key,"recovered","VERIFIED_RECOVERY_COMPLETED");
    return this.recovery(extensionId,key);
  }
  view(extensionId){
    return {sessions:this.list(extensionId),templates:this.templates(extensionId),
      recoveries:this.recoveries(extensionId),alerts:this.alerts(extensionId),
      alertEnabled:this.alertEnabled,
      commands:this.db.prepare("SELECT id,session_key AS sessionKey,macro_key AS macroKey,state,reason,created_at AS createdAt FROM macro_commands WHERE extension_id=? ORDER BY created_at DESC LIMIT 15").all(extensionId),
      globalStopped:this.store.isStopped(),
      repositories:(this.ciProvider()?.registry?.repositories||[]).map(x=>x.name||x.fullName||x.repository)
        .filter(x=>typeof x==="string"&&/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(x))};
  }
  chat(extensionId,key){
    const snap=this.bridge.getSnapshot(this.now());
    const client=snap.clients.find(c=>c.extensionId===extensionId&&c.status==="online");
    const chat=snap.sessions.find(s=>s.extensionId===extensionId&&s.sessionKey===key);
    if(!client||client.composerBuild!==REQUIRED_COMPOSER_BUILD||
      !chat||chat.status!=="connected"||!SHA.test(chat.urlHash||""))
      throw Error("MACRO_REGISTERED_CONNECTED_CHAT_REQUIRED");
    return chat;
  }
  pending(extensionId,key){
    return !!this.db.prepare("SELECT 1 FROM macro_commands WHERE extension_id=? AND session_key=? AND state IN ('queued','claimed') LIMIT 1")
      .get(extensionId,key);
  }
  configure(extensionId,{sessionKey,enabled,mode="manual",intervalMinutes=2,repository=undefined}={}){
    if(typeof sessionKey!=="string"||typeof enabled!=="boolean"||
      !["manual","auto"].includes(mode)||!Number.isSafeInteger(intervalMinutes)||
      intervalMinutes<1||intervalMinutes>1440)throw Error("MACRO_CONFIG_INVALID");
    const chat=this.chat(extensionId,sessionKey);
    if(this.bridge.getSnapshot(this.now()).links.some(x=>x.extensionId===extensionId&&
      x.sessionKey===sessionKey))
      throw Error("MACRO_LEGACY_WORKSTREAM_LINK_ACTIVE");
    if(this.pending(extensionId,sessionKey))throw Error("MACRO_COMMAND_PENDING");
    const now=this.now(),current=this.get(extensionId,sessionKey);
    const repo=repository===undefined?current?.repository||null:repository;
    if(repo!==null&&(typeof repo!=="string"||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)))
      throw Error("MACRO_REPOSITORY_INVALID");
    this.db.prepare("INSERT INTO macro_sessions(extension_id,session_key,url_hash,enabled,mode,"+
      "interval_minutes,status,reason,updated_at,last_reply,last_macro,last_sent_at,next_due,repository) "+
      "VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?,?) ON CONFLICT(extension_id,session_key) DO UPDATE SET "+
      "url_hash=excluded.url_hash,enabled=excluded.enabled,mode=excluded.mode,"+
      "interval_minutes=excluded.interval_minutes,status=excluded.status,reason=excluded.reason,"+
      "updated_at=excluded.updated_at,last_reply=NULL,last_macro=NULL,"+
      "next_due=excluded.next_due,repository=excluded.repository")
      .run(extensionId,sessionKey,chat.urlHash,Number(enabled),mode,intervalMinutes,
        enabled?"armed":"disabled",enabled?"OPERATOR_OPT_IN":"OPERATOR_DISABLED",now,now,repo);
    this.db.prepare("DELETE FROM macro_recovery WHERE extension_id=? AND session_key=?")
      .run(extensionId,sessionKey);
    if(current?.repository!==repo)
      this.db.prepare("UPDATE macro_sessions SET last_ci_identity=NULL WHERE extension_id=? AND session_key=?")
        .run(extensionId,sessionKey);
    return this.get(extensionId,sessionKey);
  }
  setTemplate(extensionId,{macroKey,prompt}={}){
    if(!MACRO_KEYS.includes(macroKey)||typeof prompt!=="string"||!prompt.trim()||
      prompt.length>800||/[\0\r]/.test(prompt))throw Error("MACRO_TEMPLATE_INVALID");
    this.db.prepare("INSERT INTO macro_templates(extension_id,macro_key,prompt) VALUES(?,?,?) "+
      "ON CONFLICT(extension_id,macro_key) DO UPDATE SET prompt=excluded.prompt")
      .run(extensionId,macroKey,prompt.trim());
    return {macroKey,prompt:prompt.trim()};
  }
  pause(extensionId,key,why){
    const now=this.now(),safe=reason(why);
    const old=this.get(extensionId,key);
    if(old?.reason!==safe)this.recordAlert(extensionId,key,"operator_attention",safe);
    this.db.prepare("UPDATE macro_sessions SET enabled=0,status='paused',reason=?,updated_at=? WHERE extension_id=? AND session_key=?")
      .run(safe,now,extensionId,key);
    this.db.prepare("UPDATE macro_commands SET state='blocked',finished_at=?,reason=? WHERE extension_id=? AND session_key=? AND state='queued'")
      .run(now,safe,extensionId,key);
  }
  revokeExtension(extensionId){
    const now=this.now();
    return this.store.transaction(()=>{
      const updated=this.db.prepare("UPDATE macro_sessions SET enabled=0,status='paused',"+
        "reason='EXTENSION_REPAIRED_REAPPROVAL',updated_at=? WHERE extension_id=? AND enabled=1")
        .run(now,extensionId).changes;
      this.db.prepare("UPDATE macro_commands SET state='blocked',finished_at=?,reason='EXTENSION_PAIRING_CHANGED' "+
        "WHERE extension_id=? AND state='queued'").run(now,extensionId);
      for(const [key,pending] of this.challenges)
        if(pending.extensionId===extensionId)this.challenges.delete(key);
      return {revoked:updated};
    });
  }
  reconcile(){
    const now=this.now(),snap=this.bridge.getSnapshot(now);
    for(const cfg of this.db.prepare("SELECT * FROM macro_sessions WHERE enabled=1").all()){
      if(cfg.status==="migrating")continue;
      if(snap.links.some(x=>x.extensionId===cfg.extension_id&&x.sessionKey===cfg.session_key)){
        this.pause(cfg.extension_id,cfg.session_key,"LEGACY_WORKSTREAM_LINK_CONFLICT");
        continue;
      }
      const chat=snap.sessions.find(x=>x.extensionId===cfg.extension_id&&x.sessionKey===cfg.session_key);
      if(chat?.urlHash&&chat.urlHash!==cfg.url_hash){
        this.pause(cfg.extension_id,cfg.session_key,"CHAT_IDENTITY_CHANGED_REAPPROVAL");
      }else if(!chat||chat.status!=="connected"){
        this.beginRecovery(cfg.extension_id,cfg.session_key,"disconnect");
      }else if(this.recovery(cfg.extension_id,cfg.session_key)?.kind==="disconnect"&&
        this.recovery(cfg.extension_id,cfg.session_key)?.state!=="recovered"){
        this.db.prepare("UPDATE macro_sessions SET status='armed',reason='RECONNECTED_AWAIT_VERIFIED_REPLY'"+
          " WHERE extension_id=? AND session_key=?").run(cfg.extension_id,cfg.session_key);
      }
    }
    const expired=this.db.prepare("SELECT extension_id,session_key FROM macro_commands WHERE state='claimed' AND claimed_at<?")
      .all(now-120_000);
    this.db.prepare("UPDATE macro_commands SET state='unknown',finished_at=?,reason='CLAIM_TIMEOUT_NO_REPLAY' WHERE state='claimed' AND claimed_at<?")
      .run(now,now-120_000);
    for(const item of expired)this.pause(item.extension_id,item.session_key,
      "CLAIM_TIMEOUT_NO_REPLAY");
  }
  requestObservations(extensionId){
    this.reconcile();
    const at=this.now(),requests=[];
    for(const cfg of this.list(extensionId).filter(x=>x.enabled&&x.mode==="auto"&&
      x.status!=="migrating")){
      let live;try{live=this.chat(extensionId,cfg.sessionKey);}catch{continue;}
      if(live.urlHash!==cfg.approvedUrlHash){
        this.pause(extensionId,cfg.sessionKey,"CHAT_IDENTITY_CHANGED_REAPPROVAL");continue;
      }
      if(this.pending(extensionId,cfg.sessionKey))continue;
      if([...this.challenges.values()].some(x=>x.extensionId===extensionId&&
        x.sessionKey===cfg.sessionKey&&x.expiresAt>=at))continue;
      const requestId=randomUUID();
      this.challenges.set(requestId,{extensionId,sessionKey:cfg.sessionKey,urlHash:live.urlHash,
        expiresAt:at+90_000});
      requests.push({requestId,sessionKey:cfg.sessionKey,workstreamId:"macro:"+cfg.sessionKey,
        macroObservation:true,permitted:true});
    }
    return requests;
  }
  observe(extensionId,{requestId,observation}={}){
    const challenge=this.challenges.get(requestId);
    this.challenges.delete(requestId);
    const at=this.now();
    if(!challenge||challenge.extensionId!==extensionId||challenge.expiresAt<at)
      throw Error("MACRO_CHALLENGE_EXPIRED");
    const key=challenge.sessionKey,cfg=this.get(extensionId,key);
    if(!cfg?.enabled||cfg.mode!=="auto")throw Error("MACRO_NOT_ARMED");
    const live=this.chat(extensionId,key);
    if(live.urlHash!==cfg.approvedUrlHash||live.urlHash!==challenge.urlHash){
      this.pause(extensionId,key,"CHAT_IDENTITY_CHANGED_REAPPROVAL");
      throw Error("MACRO_IDENTITY_CHANGED");
    }
    if(!observed(observation)||observation.observedAt<at-30_000||
       observation.observedAt>at+5_000){
      this.pause(extensionId,key,"OBSERVATION_UNVERIFIED");
      return {queued:false,reason:"OBSERVATION_UNVERIFIED"};
    }
    const selection=classifyMacroObservation(observation,{lastMacro:cfg.lastMacro});
    const ci=this.ciFailure(cfg.repository);
    const newlyFailed=ci&&ci.identity!==cfg.lastCiIdentity?ci:null;
    // Plain assistant "waiting for CI" text cannot create a run failure.
    // Only fresh, exact Run+Attempt+SHA plus a matching CI incident may select
    // CI-red, and the completed reply's editor must remain safe.
    if(selection.reason==="CI_STATUS_NEEDS_VERIFIED_EVIDENCE"&&!newlyFailed){
      this.db.prepare("UPDATE macro_sessions SET status='waiting',reason='WAIT_VERIFIED_CI'"+
        " WHERE extension_id=? AND session_key=?").run(extensionId,key);
      return {queued:false,reason:"WAIT_VERIFIED_CI"};
    }
    if(selection.reason==="CI_STATUS_NEEDS_VERIFIED_EVIDENCE"&&newlyFailed&&
      observation.assistantBusy===false&&observation.stopControlVerified===false&&
      observation.composerHasDraft===false&&observation.contentComplete===true&&
      observation.uiAmbiguous===false&&observation.humanActionCue===false&&
      observation.providerRestriction===false&&observation.connectionWarning===false)
      selection.kind="send";
    if(selection.kind==="hold"){
      if(selection.reason==="CHAT_LENGTH_MIGRATION_REQUIRED"&&
        cfg.mode==="auto"){
        this.db.prepare("UPDATE macro_sessions SET status='waiting',reason='AUTO_MIGRATION_WATCH_PENDING'"+
          " WHERE extension_id=? AND session_key=?").run(extensionId,key);
        return {queued:false,reason:"AUTO_MIGRATION_WATCH_PENDING",
          automaticMigration:true};
      }
      if(selection.reason==="NETWORK_RECOVERY_REQUIRED"){
        const recovering=this.beginRecovery(extensionId,key,"network",{observation});
        return {queued:false,reason:selection.reason,recovery:recovering.status,
          ...(recovering.recoveryAction?{recoveryAction:recovering.recoveryAction}:{})};
      }
      this.pause(extensionId,key,selection.reason);
      return {queued:false,reason:selection.reason,suggestedMacro:selection.macro||null};
    }
    if(selection.kind!=="send"||this.store.isStopped()||this.pending(extensionId,key))
      return {queued:false,reason:this.store.isStopped()?"GLOBAL_STOP_ACTIVE":selection.reason};
    const proofKey=digest([extensionId,key]);
    const previous=this.db.prepare("SELECT * FROM macro_proofs WHERE proof_key=?").get(proofKey);
    const same=previous?.binding===observation.bindingFingerprint&&
      previous.reply===observation.replyFingerprint&&
      previous.first_seen>=this.startedAt&&at-previous.last_seen<=OBS_MAX_MS;
    if(!same){
      this.db.prepare("INSERT INTO macro_proofs(proof_key,binding,reply,first_seen,last_seen) "+
        "VALUES(?,?,?,?,?) ON CONFLICT(proof_key) DO UPDATE SET binding=excluded.binding,"+
        "reply=excluded.reply,first_seen=excluded.first_seen,last_seen=excluded.last_seen")
        .run(proofKey,observation.bindingFingerprint,observation.replyFingerprint,at,at);
      return {queued:false,reason:"REPLY_STABILITY_PENDING"};
    }
    this.db.prepare("UPDATE macro_proofs SET last_seen=? WHERE proof_key=?").run(at,proofKey);
    const due=this.db.prepare("SELECT next_due AS n FROM macro_sessions WHERE extension_id=? AND session_key=?")
      .get(extensionId,key).n;
    if(at-previous.first_seen<STABILITY_MS||cfg.lastReplyFingerprint===observation.replyFingerprint||at<due)
      return {queued:false,reason:"WAIT_FRESH_REPLY_OR_INTERVAL"};
    const recovery=this.recovery(extensionId,key);
    const macro=recovery?.state!=="recovered"&&
      ["network","disconnect"].includes(recovery?.kind)?recovery.kind:
      newlyFailed?"ci_red":selection.macro;
    const command=this.enqueue(extensionId,key,macro,{
      binding:observation.bindingFingerprint,reply:observation.replyFingerprint,urlHash:live.urlHash,
      ciIdentity:macro==="ci_red"?newlyFailed?.identity:null,
      ciWaitCue:observation.ciWaitCue===true
    });
    return {queued:true,commandId:command.id,macroKey:macro};
  }
  enqueue(extensionId,sessionKey,macroKey,{
    binding=null,reply=null,urlHash=null,ciIdentity=null,ciWaitCue=false}={}){
    if(this.store.isStopped())throw Error("GLOBAL_STOP_ACTIVE");
    if(!MACRO_KEYS.includes(macroKey))throw Error("MACRO_KEY_INVALID");
    const cfg=this.get(extensionId,sessionKey),live=this.chat(extensionId,sessionKey);
    if(!cfg?.enabled||this.pending(extensionId,sessionKey)||
      this.bridge.getSnapshot(this.now()).links.some(x=>x.extensionId===extensionId&&x.sessionKey===sessionKey)||
      cfg.approvedUrlHash!==live.urlHash||(urlHash&&urlHash!==live.urlHash))
      throw Error("MACRO_NOT_READY");
    if(reply!==null&&(!SHA.test(reply)||!SHA.test(binding||"")))
      throw Error("MACRO_PROOF_INVALID");
    const ci=ciIdentity!==null?this.ciFailure(cfg.repository):null;
    if(ciIdentity!==null&&(macroKey!=="ci_red"||ci?.identity!==ciIdentity))
      throw Error("MACRO_CI_FACT_CHANGED");
    const evidence=ci?"\nCI ?? ??: "+ci.repository+" Run "+ci.runId+
      " Attempt "+ci.runAttempt+" HEAD "+ci.headSha+". ?? ?? ? PR ??? ??? ?????.":"";
    const message=this.templates(extensionId)[macroKey]+evidence;
    if(message.length>800)throw Error("MACRO_MESSAGE_TOO_LONG");
    const at=this.now(),id=randomUUID();
    this.db.prepare("INSERT INTO macro_commands(id,extension_id,session_key,macro_key,message,"+
      "binding,reply,url_hash,state,created_at,claimed_at,finished_at,reason,ci_identity,ci_wait) "+
      "VALUES(?,?,?,?,?,?,?,?,'queued',?,NULL,NULL,'QUEUED',?,?)")
      .run(id,extensionId,sessionKey,macroKey,message,
        binding,reply,live.urlHash,at,ciIdentity,Number(ciWaitCue===true));
    return {id,macroKey,state:"queued"};
  }
  claim(extensionId){
    this.reconcile();
    if(this.store.isStopped())return null;
    const cmd=this.db.prepare("SELECT * FROM macro_commands WHERE extension_id=? AND state='queued' ORDER BY created_at,id LIMIT 1")
      .get(extensionId);
    if(!cmd)return null;
    const cfg=this.get(extensionId,cmd.session_key);
    let live=null;try{live=this.chat(extensionId,cmd.session_key);}catch{}
    if(!cfg?.enabled||!live||live.urlHash!==cmd.url_hash||cfg.approvedUrlHash!==live.urlHash||
      (cmd.ci_identity&&this.ciFailure(cfg.repository)?.identity!==cmd.ci_identity)){
      this.db.prepare("UPDATE macro_commands SET state='blocked',finished_at=?,reason='MACRO_SESSION_UNAVAILABLE' WHERE id=?")
        .run(this.now(),cmd.id);return null;
    }
    this.db.prepare("UPDATE macro_commands SET state='claimed',claimed_at=? WHERE id=? AND state='queued'")
      .run(this.now(),cmd.id);
    return {id:cmd.id,sessionKey:cmd.session_key,macroKey:cmd.macro_key,message:cmd.message,
      observationProof:cmd.reply?{bindingFingerprint:cmd.binding,replyFingerprint:cmd.reply,
        ciWaitCue:cmd.ci_wait===1}:null};
  }
  ack(extensionId,{id,status,reason:why="ACK"}={}){
    if(typeof id!=="string"||!["sent","blocked","unknown"].includes(status))
      throw Error("MACRO_ACK_INVALID");
    const cmd=this.db.prepare("SELECT * FROM macro_commands WHERE id=? AND extension_id=? AND state='claimed'")
      .get(id,extensionId);
    if(!cmd)throw Error("MACRO_COMMAND_NOT_CLAIMED");
    const at=this.now();
    return this.store.transaction(()=>{
      this.db.prepare("UPDATE macro_commands SET state=?,finished_at=?,reason=? WHERE id=?")
        .run(status,at,reason(why),id);
      if(status==="sent"){
        const config=this.get(extensionId,cmd.session_key);
        this.db.prepare("UPDATE macro_sessions SET status='armed',reason='WAIT_NEXT_REPLY',"+
          "last_macro=?,last_reply=?,last_sent_at=?,next_due=?,updated_at=? "+
          "WHERE extension_id=? AND session_key=?")
          .run(cmd.macro_key,cmd.reply,at,at+config.intervalMinutes*60_000,at,
            extensionId,cmd.session_key);
        if(cmd.ci_identity)
          this.db.prepare("UPDATE macro_sessions SET last_ci_identity=? "+
            "WHERE extension_id=? AND session_key=?").run(cmd.ci_identity,extensionId,cmd.session_key);
        if(["network","disconnect"].includes(cmd.macro_key))
          this.resolveRecovery(extensionId,cmd.session_key);
      }else{
        this.pause(extensionId,cmd.session_key,
          status==="unknown"?"UNCERTAIN_SUBMISSION_NO_RETRY":reason(why));
      }
      return {id,status};
    });
  }
}

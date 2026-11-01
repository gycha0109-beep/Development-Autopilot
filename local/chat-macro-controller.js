import {createHash,randomUUID} from "node:crypto";
import {REQUIRED_COMPOSER_BUILD} from "./chrome-bridge.js";

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
  lastReplyFingerprint:r.last_reply,lastSentAt:r.last_sent_at}):null;
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
    this.startedAt=now();this.challenges=new Map();
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
      "CREATE INDEX IF NOT EXISTS macro_commands_idx ON macro_commands(extension_id,state,created_at);"
    ].join(" "));
    const previouslyClaimed=this.db.prepare("SELECT extension_id,session_key FROM macro_commands WHERE state='claimed'").all();
    this.db.prepare("UPDATE macro_commands SET state='unknown',finished_at=?,reason='RESTART_UNCERTAIN_NO_REPLAY' WHERE state='claimed'")
      .run(now());
    for(const claimed of previouslyClaimed)this.pause(claimed.extension_id,claimed.session_key,
      "RESTART_UNCERTAIN_NO_REPLAY");
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
  view(extensionId){
    return {sessions:this.list(extensionId),templates:this.templates(extensionId),
      commands:this.db.prepare("SELECT id,session_key AS sessionKey,macro_key AS macroKey,state,reason,created_at AS createdAt FROM macro_commands WHERE extension_id=? ORDER BY created_at DESC LIMIT 15").all(extensionId),
      globalStopped:this.store.isStopped()};
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
  configure(extensionId,{sessionKey,enabled,mode="manual",intervalMinutes=2}={}){
    if(typeof sessionKey!=="string"||typeof enabled!=="boolean"||
      !["manual","auto"].includes(mode)||!Number.isSafeInteger(intervalMinutes)||
      intervalMinutes<1||intervalMinutes>1440)throw Error("MACRO_CONFIG_INVALID");
    const chat=this.chat(extensionId,sessionKey);
    if(this.bridge.getSnapshot(this.now()).links.some(x=>x.extensionId===extensionId&&
      x.sessionKey===sessionKey))
      throw Error("MACRO_LEGACY_WORKSTREAM_LINK_ACTIVE");
    if(this.pending(extensionId,sessionKey))throw Error("MACRO_COMMAND_PENDING");
    const now=this.now();
    this.db.prepare("INSERT INTO macro_sessions(extension_id,session_key,url_hash,enabled,mode,"+
      "interval_minutes,status,reason,updated_at,last_reply,last_macro,last_sent_at,next_due) "+
      "VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,NULL,?) ON CONFLICT(extension_id,session_key) DO UPDATE SET "+
      "url_hash=excluded.url_hash,enabled=excluded.enabled,mode=excluded.mode,"+
      "interval_minutes=excluded.interval_minutes,status=excluded.status,reason=excluded.reason,"+
      "updated_at=excluded.updated_at,last_reply=NULL,last_macro=NULL,next_due=excluded.next_due")
      .run(extensionId,sessionKey,chat.urlHash,Number(enabled),mode,intervalMinutes,
        enabled?"armed":"disabled",enabled?"OPERATOR_OPT_IN":"OPERATOR_DISABLED",now,now);
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
      if(snap.links.some(x=>x.extensionId===cfg.extension_id&&x.sessionKey===cfg.session_key)){
        this.pause(cfg.extension_id,cfg.session_key,"LEGACY_WORKSTREAM_LINK_CONFLICT");
        continue;
      }
      const chat=snap.sessions.find(x=>x.extensionId===cfg.extension_id&&x.sessionKey===cfg.session_key);
      if(chat?.urlHash&&chat.urlHash!==cfg.url_hash){
        this.pause(cfg.extension_id,cfg.session_key,"CHAT_IDENTITY_CHANGED_REAPPROVAL");
      }else if(!chat||chat.status!=="connected"){
        this.db.prepare("UPDATE macro_sessions SET status='waiting',reason='CHAT_DISCONNECTED' WHERE extension_id=? AND session_key=?")
          .run(cfg.extension_id,cfg.session_key);
      }else if(cfg.reason==="CHAT_DISCONNECTED"){
        this.db.prepare("UPDATE macro_sessions SET status='armed',reason='RECONNECTED_AWAIT_OBSERVATION' WHERE extension_id=? AND session_key=?")
          .run(cfg.extension_id,cfg.session_key);
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
    for(const cfg of this.list(extensionId).filter(x=>x.enabled&&x.mode==="auto")){
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
    if(selection.kind==="hold"){
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
    const command=this.enqueue(extensionId,key,selection.macro,{
      binding:observation.bindingFingerprint,reply:observation.replyFingerprint,urlHash:live.urlHash
    });
    return {queued:true,commandId:command.id,macroKey:selection.macro};
  }
  enqueue(extensionId,sessionKey,macroKey,{binding=null,reply=null,urlHash=null}={}){
    if(this.store.isStopped())throw Error("GLOBAL_STOP_ACTIVE");
    if(!MACRO_KEYS.includes(macroKey))throw Error("MACRO_KEY_INVALID");
    const cfg=this.get(extensionId,sessionKey),live=this.chat(extensionId,sessionKey);
    if(!cfg?.enabled||this.pending(extensionId,sessionKey)||
      this.bridge.getSnapshot(this.now()).links.some(x=>x.extensionId===extensionId&&x.sessionKey===sessionKey)||
      cfg.approvedUrlHash!==live.urlHash||(urlHash&&urlHash!==live.urlHash))
      throw Error("MACRO_NOT_READY");
    if(reply!==null&&(!SHA.test(reply)||!SHA.test(binding||"")))
      throw Error("MACRO_PROOF_INVALID");
    const at=this.now(),id=randomUUID();
    this.db.prepare("INSERT INTO macro_commands(id,extension_id,session_key,macro_key,message,"+
      "binding,reply,url_hash,state,created_at,claimed_at,finished_at,reason) "+
      "VALUES(?,?,?,?,?,?,?,?,'queued',?,NULL,NULL,'QUEUED')")
      .run(id,extensionId,sessionKey,macroKey,this.templates(extensionId)[macroKey],
        binding,reply,live.urlHash,at);
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
    if(!cfg?.enabled||!live||live.urlHash!==cmd.url_hash||cfg.approvedUrlHash!==live.urlHash){
      this.db.prepare("UPDATE macro_commands SET state='blocked',finished_at=?,reason='MACRO_SESSION_UNAVAILABLE' WHERE id=?")
        .run(this.now(),cmd.id);return null;
    }
    this.db.prepare("UPDATE macro_commands SET state='claimed',claimed_at=? WHERE id=? AND state='queued'")
      .run(this.now(),cmd.id);
    return {id:cmd.id,sessionKey:cmd.session_key,macroKey:cmd.macro_key,message:cmd.message,
      observationProof:cmd.reply?{bindingFingerprint:cmd.binding,replyFingerprint:cmd.reply,
        ciWaitCue:false}:null};
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
      }else{
        this.pause(extensionId,cmd.session_key,
          status==="unknown"?"UNCERTAIN_SUBMISSION_NO_RETRY":reason(why));
      }
      return {id,status};
    });
  }
}

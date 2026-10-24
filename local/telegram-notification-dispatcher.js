// Telegram notification channel. Independent from SMS-02's fake-only channel.
// The persistent ledger is shared (notification_intents); delivery states are
// separate, and no Telegram reply can approve or resume any Workstream.
import {createHash,randomUUID} from "node:crypto";
import {TelegramBotTransport} from "./telegram-bot-transport.js";
import {NotificationIntents} from "./notification-intents.js";
import {notificationSourceValidity} from "./notification-source-validation.js";

const hash=value=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const HASH=/^[a-f0-9]{64}$/;
const DAY=86_400_000;
const stamp=t=>Number.isSafeInteger(t)&&t>=0;
const configInt=(v,min,max,label)=>{
  if(!Number.isSafeInteger(v)||v<min||v>max)throw Error("INVALID_"+label);
};
export class TelegramNotificationDispatcher {
  #draining=false;
  constructor(store,{transport=new TelegramBotTransport(),enabled=false,
    now=()=>Date.now(),maxAttempts=3,maxBatch=1,maxDaily=80,
    maxWorkstreamDaily=25,backoffMs=10_000,leaseMs=25_000}={}){
    if(!(transport instanceof TelegramBotTransport))
      throw Error("INVALID_TELEGRAM_TRANSPORT");
    for(const [v,min,max,label] of [
      [maxAttempts,1,3,"MAX_ATTEMPTS"],[maxBatch,1,5,"MAX_BATCH"],
      [maxDaily,1,1000,"DAILY_LIMIT"],
      [maxWorkstreamDaily,1,100,"WORKSTREAM_LIMIT"],
      [backoffMs,1000,600_000,"BACKOFF"],
      [leaseMs,1000,60_000,"LEASE"]
    ])configInt(v,min,max,"TELEGRAM_"+label);
    this.store=store;this.db=store.db;this.transport=transport;
    this.enabled=enabled===true;this.now=now;
    this.maxAttempts=maxAttempts;this.maxBatch=maxBatch;this.maxDaily=maxDaily;
    this.maxWorkstreamDaily=maxWorkstreamDaily;
    this.backoffMs=backoffMs;this.leaseMs=leaseMs;
    this.status="NOT_ENABLED";
    this.intents=new NotificationIntents(store,{now});
    this.db.exec(`CREATE TABLE IF NOT EXISTS telegram_delivery_states(
      intent_id TEXT PRIMARY KEY REFERENCES notification_intents(intent_id) ON DELETE CASCADE,
      delivery_key TEXT NOT NULL UNIQUE CHECK(length(delivery_key)=64),
      state TEXT NOT NULL CHECK(state IN(
        'pending','claimed','not_sent','accepted','unknown','permanent_failure',
        'exhausted','suppressed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
      current_attempt_id TEXT,
      telegram_message_id TEXT,
      retry_at INTEGER NOT NULL DEFAULT 0,
      reason_code TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS telegram_delivery_attempts(
      attempt_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
      delivery_key TEXT NOT NULL CHECK(length(delivery_key)=64),
      status TEXT NOT NULL CHECK(status IN(
        'claimed','not_sent','accepted','unknown','permanent_failure')),
      claimed_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,
      completed_at INTEGER,
      UNIQUE(intent_id,attempt_no)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS telegram_attempt_time_idx
      ON telegram_delivery_attempts(claimed_at,intent_id);`);
    this.reconcile();
  }
  clock(){
    const t=this.now();
    if(!stamp(t))throw Error("INVALID_TELEGRAM_CLOCK");
    return t;
  }
  get(intentId){
    return this.db.prepare(`SELECT * FROM telegram_delivery_states
      WHERE intent_id=?`).get(intentId)||null;
  }
  reconcile(){
    const time=this.clock();
    return this.store.transaction(()=>{
      const expired=this.db.prepare(`SELECT s.intent_id,s.current_attempt_id
        FROM telegram_delivery_states s JOIN telegram_delivery_attempts a
        ON s.current_attempt_id=a.attempt_id
        WHERE s.state='claimed' AND a.lease_until<=?`).all(time);
      for(const r of expired){
        this.db.prepare(`UPDATE telegram_delivery_attempts
          SET status='unknown',completed_at=?
          WHERE attempt_id=? AND status='claimed'`).run(time,r.current_attempt_id);
        this.db.prepare(`UPDATE telegram_delivery_states
          SET state='unknown',reason_code='UNCERTAIN_PREVIOUS_SEND',updated_at=?
          WHERE intent_id=? AND current_attempt_id=? AND state='claimed'`)
          .run(time,r.intent_id,r.current_attempt_id);
      }
      return expired.length;
    });
  }
  count(time,workstreamId){
    const since=Math.floor(time/DAY)*DAY;
    const all=this.db.prepare(`SELECT count(*) AS n FROM telegram_delivery_attempts
      WHERE claimed_at>=?`).get(since).n;
    const workstream=this.db.prepare(`SELECT count(*) AS n
      FROM telegram_delivery_attempts a JOIN notification_intents i
      ON i.intent_id=a.intent_id WHERE a.claimed_at>=? AND i.workstream_id=?`)
      .get(since,workstreamId).n;
    return {all,workstream};
  }
  claim(intentId){
    if(!this.enabled)throw Error("TELEGRAM_NOT_ENABLED");
    if(!HASH.test(intentId||""))throw Error("INVALID_TELEGRAM_INTENT");
    const now=this.clock();
    return this.store.transaction(()=>{
      const intent=this.db.prepare(`SELECT * FROM notification_intents
        WHERE intent_id=?`).get(intentId);
      if(!intent)return {state:"NOT_FOUND"};
      if(intent.state!=="pending")return {state:"COALESCED"};
      const ws=this.store.mustGet(intent.workstream_id);
      // Existing fake channel evidence can never be considered Telegram evidence.
      const dk=hash(["telegram-v1",intentId]);
      this.db.prepare(`INSERT OR IGNORE INTO telegram_delivery_states(
        intent_id,delivery_key,state,updated_at) VALUES(?,?,'pending',?)`)
        .run(intentId,dk,now);
      const state=this.get(intentId);
      if(state.state==="claimed")return {state:"IN_FLIGHT"};
      if(!["pending","not_sent"].includes(state.state))
        return {state:state.state.toUpperCase()};
      if(state.retry_at>now)return {state:"BACKOFF"};
      if(state.attempt_count>=this.maxAttempts)return {state:"EXHAUSTED"};
      const validity=notificationSourceValidity(this.db,intent,now);
      if(validity==="SOURCE_TABLE_UNAVAILABLE")return {state:"SOURCE_NOT_READY"};
      if(validity!=="VALID"||intent.created_at>now||
         now-intent.created_at>7*DAY){
        const why=validity==="VALID"?"HISTORICAL_INTENT_TOO_OLD":validity;
        this.db.prepare(`UPDATE telegram_delivery_states
          SET state='suppressed',reason_code=?,updated_at=? WHERE intent_id=?`)
          .run(why,now,intentId);
        return {state:"SUPPRESSED",reason:why};
      }
      const budget=this.count(now,intent.workstream_id);
      if(budget.all>=this.maxDaily||
         budget.workstream>=this.maxWorkstreamDaily)return {state:"BUDGET_LIMIT"};
      const attemptId=randomUUID(),no=state.attempt_count+1;
      const leaseUntil=now+this.leaseMs;
      if(!stamp(leaseUntil))throw Error("INVALID_TELEGRAM_LEASE");
      this.db.prepare(`UPDATE telegram_delivery_states SET
        state='claimed',attempt_count=?,current_attempt_id=?,
        reason_code=NULL,updated_at=? WHERE intent_id=?`)
        .run(no,attemptId,now,intentId);
      this.db.prepare(`INSERT INTO telegram_delivery_attempts(
        attempt_id,intent_id,attempt_no,delivery_key,status,claimed_at,lease_until)
        VALUES(?,?,?,?,'claimed',?,?)`)
        .run(attemptId,intentId,no,state.delivery_key,now,leaseUntil);
      return {state:"CLAIMED",intentId,attemptId,attemptNo:no,leaseUntil,
        payload:{workstreamName:ws.name,sourceKind:intent.source_kind,
          severity:intent.severity,reasonCode:intent.reason_code}};
    });
  }
  finish(claim,result){
    const now=this.clock();
    return this.store.transaction(()=>{
      const old=this.get(claim.intentId);
      if(old?.state!=="claimed"||old.current_attempt_id!==claim.attemptId)
        return {state:"STALE_RESULT_IGNORED"};
      const accepted=result?.status==="accepted"&&
        typeof result.providerMessageId==="string"&&
        /^[1-9][0-9]{0,19}$/.test(result.providerMessageId);
      const rejected=result?.status==="not_sent";
      const permanent=result?.status==="permanent_failure";
      const attemptState=accepted?"accepted":rejected?"not_sent":
        permanent?"permanent_failure":"unknown";
      const exhausted=rejected&&old.attempt_count>=this.maxAttempts;
      const state=exhausted?"exhausted":attemptState;
      const retryMs=rejected&&!exhausted?
        Math.max(this.backoffMs*2**(old.attempt_count-1),
          Number.isSafeInteger(result.retryAfterMs)?
            Math.min(Math.max(0,result.retryAfterMs),3_600_000):0):0;
      const retryAt=retryMs?now+retryMs:0;
      if(!stamp(retryAt))throw Error("INVALID_TELEGRAM_BACKOFF");
      const reason=state==="unknown"?"TELEGRAM_SEND_UNCERTAIN":
        state==="exhausted"?"TELEGRAM_RETRIES_EXHAUSTED":
        state==="permanent_failure"?"TELEGRAM_PROVIDER_REJECTED":null;
      this.db.prepare(`UPDATE telegram_delivery_attempts
        SET status=?,completed_at=? WHERE attempt_id=? AND status='claimed'`)
        .run(attemptState,now,claim.attemptId);
      this.db.prepare(`UPDATE telegram_delivery_states SET state=?,
        telegram_message_id=?,retry_at=?,reason_code=?,updated_at=?
        WHERE intent_id=? AND current_attempt_id=?`)
        .run(state,accepted?result.providerMessageId:null,retryAt,reason,now,
          claim.intentId,claim.attemptId);
      return {state:state.toUpperCase(),attemptNo:old.attempt_count,
        retryAt,providerMessageId:accepted?result.providerMessageId:null};
    });
  }
  async dispatch(intentId){
    if(!this.enabled)return {state:"NOT_ENABLED"};
    // Never acquire a durable claim when the private bot is not configured.
    let credential;
    try{credential=await this.transport.ready();}
    catch{this.status="CREDENTIAL_NOT_CONFIGURED";return {state:"NOT_CONFIGURED"};}
    const claim=this.claim(intentId);
    if(claim.state!=="CLAIMED")return claim;
    let result;
    try{result=await this.transport.send(claim.payload,credential);}
    catch{result={status:"unknown"};}
    const finalized=this.finish(claim,result);
    this.status=finalized.state==="ACCEPTED"?"PROVIDER_ACCEPTED":
      finalized.state==="UNKNOWN"?"SEND_UNCERTAIN":
      finalized.state==="NOT_SENT"?"RETRY_WAIT":finalized.state;
    return finalized;
  }
  async drain(limit=this.maxBatch){
    if(!this.enabled)return [];
    if(!Number.isSafeInteger(limit)||limit<1||limit>this.maxBatch)
      throw Error("INVALID_TELEGRAM_BATCH");
    if(this.#draining)return [];
    this.#draining=true;
    try{
      this.reconcile();
      const now=this.clock();
      const candidates=this.db.prepare(`SELECT i.intent_id FROM notification_intents i
        LEFT JOIN telegram_delivery_states d ON d.intent_id=i.intent_id
        WHERE i.state='pending' AND (
          d.state IS NULL OR (d.state IN ('pending','not_sent') AND d.retry_at<=?))
        ORDER BY i.created_at,i.intent_id LIMIT ?`)
        .all(now,limit*40);
      const output=[];
      for(const item of candidates){
        if(output.length>=limit)break;
        const r=await this.dispatch(item.intent_id);
        if(["BUDGET_LIMIT","NOT_CONFIGURED"].includes(r.state))break;
        if(["BACKOFF","IN_FLIGHT"].includes(r.state))continue;
        output.push({intentId:item.intent_id,...r});
      }
      return output;
    }finally{this.#draining=false;}
  }
  snapshot(limit=200){
    configInt(limit,1,500,"TELEGRAM_SNAPSHOT_LIMIT");
    return {channel:"telegram",enabled:this.enabled,
      configuredState:this.status,
      realHandsetDeliveryVerified:false,
      repliesGrantApproval:false,
      records:this.db.prepare(`SELECT i.intent_id AS intentId,
        i.workstream_id AS workstreamId,i.source_kind AS sourceKind,
        i.reason_code AS reasonCode,
        i.state AS intentState,d.state AS deliveryState,
        d.attempt_count AS attempts,d.reason_code AS failureReason,
        d.retry_at AS retryAt,d.updated_at AS updatedAt
        FROM notification_intents i LEFT JOIN telegram_delivery_states d
        ON d.intent_id=i.intent_id
        ORDER BY i.created_at DESC,i.intent_id DESC LIMIT ?`)
        .all(limit).map(r=>({...r,deliveryState:r.intentState==="coalesced"?
          "COALESCED":r.deliveryState==="claimed"?"IN_FLIGHT":
          (r.deliveryState||"pending").toUpperCase()}))};
  }
}

// SMS-02 — SQLite-bound, fake-only outbound dispatcher.
// No phone number, billing, provider credentials, network request or automatic
// scheduler is reachable from this implementation.
import {createHash,randomUUID} from "node:crypto";
import {NotificationIntents} from "./notification-intents.js";
import {FakeSmsProvider} from "./fake-sms-provider.js";

const sha=v=>createHash("sha256").update(JSON.stringify(v)).digest("hex");
const key=v=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
const MS_DAY=86_400_000;
const validTime=n=>Number.isSafeInteger(n)&&n>=0;

export class SmsDeliveryDispatcher {
  constructor(store,{transport=null,enabled=false,now=()=>Date.now(),
    maxAttempts=3,maxBatch=8,maxDailyAttempts=40,maxWorkstreamDailyAttempts=10,
    initialBackoffMs=5_000,leaseMs=30_000}={}){
    if(transport!==null&&!(transport instanceof FakeSmsProvider))
      throw Error("REAL_SMS_TRANSPORT_NOT_APPROVED");
    if(enabled===true&&!(transport instanceof FakeSmsProvider))
      throw Error("SMS_PROVIDER_NOT_APPROVED");
    for(const [label,value,min,max] of [
      ["MAX_ATTEMPTS",maxAttempts,1,3],["MAX_BATCH",maxBatch,1,20],
      ["DAILY_BUDGET",maxDailyAttempts,1,1000],
      ["WORKSTREAM_BUDGET",maxWorkstreamDailyAttempts,1,100],
      ["BACKOFF",initialBackoffMs,1000,600_000],
      ["LEASE",leaseMs,1000,600_000]
    ])if(!Number.isSafeInteger(value)||value<min||value>max)
      throw Error("INVALID_SMS_"+label);
    this.store=store;this.db=store.db;this.transport=transport;
    this.enabled=enabled===true;this.now=now;
    this.maxAttempts=maxAttempts;this.maxBatch=maxBatch;
    this.maxDailyAttempts=maxDailyAttempts;
    this.maxWorkstreamDailyAttempts=maxWorkstreamDailyAttempts;
    this.initialBackoffMs=initialBackoffMs;this.leaseMs=leaseMs;
    this.intents=new NotificationIntents(store,{now});
    this.db.exec(`CREATE TABLE IF NOT EXISTS sms_delivery_states(
      intent_id TEXT PRIMARY KEY REFERENCES notification_intents(intent_id) ON DELETE CASCADE,
      delivery_key TEXT NOT NULL UNIQUE CHECK(length(delivery_key)=64),
      state TEXT NOT NULL CHECK(state IN
        ('pending','claimed','not_sent','accepted','delivered','unknown',
         'permanent_failure','exhausted','suppressed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 3),
      current_attempt_id TEXT,
      next_attempt_at INTEGER NOT NULL DEFAULT 0,
      provider_message_id TEXT,
      reason_code TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sms_delivery_attempts(
      attempt_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id) ON DELETE CASCADE,
      attempt_no INTEGER NOT NULL CHECK(attempt_no BETWEEN 1 AND 3),
      delivery_key TEXT NOT NULL CHECK(length(delivery_key)=64),
      status TEXT NOT NULL CHECK(status IN
        ('claimed','not_sent','accepted','unknown','permanent_failure')),
      claimed_at INTEGER NOT NULL,lease_until INTEGER NOT NULL,
      completed_at INTEGER,provider_message_id TEXT,
      UNIQUE(intent_id,attempt_no)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sms_delivery_attempts_at_idx
      ON sms_delivery_attempts(claimed_at,intent_id);
    CREATE TABLE IF NOT EXISTS sms_delivery_receipts(
      event_id TEXT PRIMARY KEY,
      intent_id TEXT NOT NULL REFERENCES notification_intents(intent_id) ON DELETE CASCADE,
      provider_message_id TEXT NOT NULL,confirmed_at INTEGER NOT NULL
    ) STRICT;`);
    // Fail closed across process restarts: an expired, previously in-flight
    // send is UNKNOWN, not a new PENDING attempt. No transport is invoked.
    this.reconcile();
  }
  clock(){
    const value=this.now();
    if(!validTime(value))throw Error("INVALID_SMS_CLOCK");
    return value;
  }
  row(id){
    return this.db.prepare("SELECT * FROM sms_delivery_states WHERE intent_id=?").get(id)||null;
  }
  // Never backfill old events; source state is revalidated before each send.
  sourceValidity(intent,now){
    if(intent.state!=="pending")return "COALESCED";
    const schema=this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?");
    if(intent.source_kind==="blocker"){
      if(!schema.get("ci_blockers"))return "SOURCE_TABLE_UNAVAILABLE";
      const existing=this.db.prepare(`SELECT state FROM ci_blockers
        WHERE workstream_id=? AND blocker_key=?`).get(intent.workstream_id,intent.source_key);
      const latest=this.db.prepare(`SELECT MAX(source_revision) AS rev
        FROM notification_intents WHERE source_kind='blocker' AND source_key=?`)
        .get(intent.source_key).rev;
      return existing?.state==="open"&&latest===intent.source_revision?
        "VALID":"SOURCE_RESOLVED_OR_REPLACED";
    }
    if(intent.source_kind==="approval"){
      if(!schema.get("operator_requests"))return "SOURCE_TABLE_UNAVAILABLE";
      const request=this.db.prepare(`SELECT state,revision,expires_at
        FROM operator_requests WHERE id=? AND workstream_id=?`)
        .get(intent.source_key,intent.workstream_id);
      return request&&["pending","held"].includes(request.state)&&
        request.revision===intent.source_revision&&now<request.expires_at?
        "VALID":"APPROVAL_NOT_CURRENT";
    }
    if(intent.source_kind==="pause"){
      if(!schema.get("ci_pause_episodes"))return "SOURCE_TABLE_UNAVAILABLE";
      const episode=this.db.prepare(`SELECT episode,active FROM ci_pause_episodes
        WHERE workstream_id=?`).get(intent.workstream_id);
      return episode?.active===1&&sha([intent.workstream_id,
        "ci-supervision-stop",episode.episode])===intent.source_key?
        "VALID":"PAUSE_NOT_CURRENT";
    }
    return "UNSUPPORTED_SOURCE";
  }
  totals(now,workstreamId){
    const since=Math.floor(now/MS_DAY)*MS_DAY;
    const all=this.db.prepare(`SELECT count(*) AS n FROM sms_delivery_attempts
      WHERE claimed_at>=?`).get(since).n;
    const perWorkstream=this.db.prepare(`SELECT count(*) AS n FROM sms_delivery_attempts a
      JOIN notification_intents i ON a.intent_id=i.intent_id
      WHERE a.claimed_at>=? AND i.workstream_id=?`).get(since,workstreamId).n;
    return {all,perWorkstream};
  }
  ensureRow(intent,now){
    const id=intent.intent_id;
    const deliveryKey=sha(["sms-02","fake-only",id]);
    this.db.prepare(`INSERT OR IGNORE INTO sms_delivery_states
      (intent_id,delivery_key,state,next_attempt_at,updated_at)
      VALUES(?,?,'pending',0,?)`).run(id,deliveryKey,now);
    return this.row(id);
  }
  // Source identity and an exactly-once database claim are persisted BEFORE
  // the fake transport runs. Existing UNKNOWN/claimed states never claim again.
  claim(intentId){
    if(!this.enabled)throw Error("SMS_DISPATCH_DISABLED");
    if(!key(intentId))throw Error("INVALID_SMS_INTENT_ID");
    const now=this.clock();
    return this.store.transaction(()=>{
      const intent=this.db.prepare(`SELECT * FROM notification_intents
        WHERE intent_id=?`).get(intentId);
      if(!intent)return {state:"NOT_FOUND"};
      if(intent.state!=="pending")return {state:"COALESCED"};
      const state=this.ensureRow(intent,now);
      if(state.state==="claimed")return {state:"IN_FLIGHT"};
      if(!["pending","not_sent"].includes(state.state))
        return {state:state.state.toUpperCase()};
      if(state.next_attempt_at>now)return {state:"BACKOFF"};
      if(state.attempt_count>=this.maxAttempts)return {state:"EXHAUSTED"};
      const validity=this.sourceValidity(intent,now);
      if(validity==="SOURCE_TABLE_UNAVAILABLE")return {state:"SOURCE_NOT_READY"};
      if(validity!=="VALID"){
        this.db.prepare(`UPDATE sms_delivery_states
          SET state='suppressed',reason_code=?,updated_at=? WHERE intent_id=?`)
          .run(validity,now,intentId);
        return {state:"SUPPRESSED",reason:validity};
      }
      const totals=this.totals(now,intent.workstream_id);
      if(totals.all>=this.maxDailyAttempts||
         totals.perWorkstream>=this.maxWorkstreamDailyAttempts)
        return {state:"BUDGET_LIMIT"};
      const attemptId=randomUUID();
      const attemptNo=state.attempt_count+1;
      const leaseUntil=now+this.leaseMs;
      if(!Number.isSafeInteger(leaseUntil))throw Error("INVALID_SMS_LEASE");
      this.db.prepare(`UPDATE sms_delivery_states
        SET state='claimed',attempt_count=?,current_attempt_id=?,
        reason_code=NULL,updated_at=? WHERE intent_id=?`)
        .run(attemptNo,attemptId,now,intentId);
      this.db.prepare(`INSERT INTO sms_delivery_attempts
        (attempt_id,intent_id,attempt_no,delivery_key,status,claimed_at,lease_until)
        VALUES(?,?,?,?,'claimed',?,?)`).run(attemptId,intentId,attemptNo,
          state.delivery_key,now,leaseUntil);
      return {state:"CLAIMED",intentId,attemptId,attemptNo,
        deliveryKey:state.delivery_key,leaseUntil,
        // Explicitly minimal metadata — no phone number, prompt, token or body.
        payload:Object.freeze({
          intentId,deliveryKey:state.delivery_key,
          sourceKind:intent.source_kind,severity:intent.severity,
          reasonCode:intent.reason_code
        })};
    });
  }
  finalize(claim,result){
    const now=this.clock();
    const accepted=result?.status==="accepted"&&
      typeof result.providerMessageId==="string"&&
      /^[A-Za-z0-9_-]{1,128}$/.test(result.providerMessageId);
    const notSent=result?.status==="not_sent";
    const permanent=result?.status==="permanent_failure";
    const state=accepted?"accepted":notSent?"not_sent":
      permanent?"permanent_failure":"unknown";
    return this.store.transaction(()=>{
      const old=this.row(claim.intentId);
      if(old?.state!=="claimed"||old.current_attempt_id!==claim.attemptId)
        return {state:"STALE_RESULT_IGNORED"};
      const attempts=old.attempt_count;
      const exhausted=notSent&&attempts>=this.maxAttempts;
      const newState=exhausted?"exhausted":state;
      const next=notSent&&!exhausted?
        now+Math.min(600_000,this.initialBackoffMs*2**(attempts-1)):0;
      if(!validTime(next))throw Error("INVALID_SMS_BACKOFF");
      const reason=state==="unknown"?"SEND_RESULT_UNVERIFIED":
        exhausted?"RETRY_LIMIT_EXHAUSTED":null;
      const providerId=accepted?result.providerMessageId:null;
      this.db.prepare(`UPDATE sms_delivery_attempts
        SET status=?,completed_at=?,provider_message_id=?
        WHERE attempt_id=? AND status='claimed'`)
        .run(state,now,providerId,claim.attemptId);
      this.db.prepare(`UPDATE sms_delivery_states SET state=?,next_attempt_at=?,
        provider_message_id=?,reason_code=?,updated_at=?
        WHERE intent_id=? AND current_attempt_id=?`)
        .run(newState,next,providerId,reason,now,claim.intentId,claim.attemptId);
      return {state:newState.toUpperCase(),attemptNo:attempts,
        nextAttemptAt:next,providerMessageId:providerId};
    });
  }
  async dispatch(intentId){
    const claim=this.claim(intentId);
    if(claim.state!=="CLAIMED")return claim;
    let result;
    try{
      result=await this.transport.send(claim.payload);
    }catch{
      // Catch and deliberately discard exception text: it may contain PII,
      // credentials or provider HTTP bodies, and send outcome is UNKNOWN.
      result={status:"unknown"};
    }
    return this.finalize(claim,result);
  }
  // A reclaimed attempt may have actually been sent. Mark UNKNOWN, not failed.
  // This is the ONLY automatic stale-lease transition, and it never replays.
  reconcile(){
    const now=this.clock();
    return this.store.transaction(()=>{
      const expired=this.db.prepare(`SELECT intent_id,current_attempt_id FROM sms_delivery_states
        WHERE state='claimed' AND EXISTS(
          SELECT 1 FROM sms_delivery_attempts a
          WHERE a.attempt_id=sms_delivery_states.current_attempt_id AND a.lease_until<=?)`)
        .all(now);
      for(const item of expired){
        this.db.prepare(`UPDATE sms_delivery_attempts
          SET status='unknown',completed_at=?
          WHERE attempt_id=? AND status='claimed'`)
          .run(now,item.current_attempt_id);
        this.db.prepare(`UPDATE sms_delivery_states
          SET state='unknown',reason_code='LEASE_EXPIRED_UNVERIFIED',updated_at=?
          WHERE intent_id=? AND current_attempt_id=? AND state='claimed'`)
          .run(now,item.intent_id,item.current_attempt_id);
      }
      return {unknown:expired.length};
    });
  }
  async drain(limit=this.maxBatch){
    if(!this.enabled)throw Error("SMS_DISPATCH_DISABLED");
    if(!Number.isSafeInteger(limit)||limit<1||limit>this.maxBatch)
      throw Error("INVALID_SMS_BATCH_LIMIT");
    this.reconcile();
    const candidates=this.db.prepare(`SELECT i.intent_id FROM notification_intents i
      LEFT JOIN sms_delivery_states d ON d.intent_id=i.intent_id
      WHERE i.state='pending' AND (d.state IS NULL OR
        d.state IN ('pending','not_sent') AND d.next_attempt_at<=?)
      ORDER BY i.created_at,i.intent_id LIMIT ?`)
      .all(this.clock(),limit*20);
    const output=[];
    for(const candidate of candidates){
      if(output.length>=limit)break;
      const result=await this.dispatch(candidate.intent_id);
      if(result.state==="BUDGET_LIMIT"||result.state==="IN_FLIGHT"||
         result.state==="BACKOFF")continue;
      output.push({intentId:candidate.intent_id,...result});
    }
    return output;
  }
  // Receipt state is separate from provider ACCEPTED. In SMS-02 only a
  // cryptographically verified fake-provider receipt can mark DELIVERED.
  acceptReceipt(receipt){
    if(!this.enabled||this.transport?.kind!=="fake-sms"||
      this.transport.verifyReceipt?.(receipt)!==true)
      throw Error("SMS_RECEIPT_NOT_VERIFIED");
    const {eventId,providerMessageId,deliveryKey}=receipt;
    const now=this.clock();
    return this.store.transaction(()=>{
      const state=this.db.prepare(`SELECT * FROM sms_delivery_states WHERE delivery_key=?`)
        .get(deliveryKey);
      if(!state||state.provider_message_id!==providerMessageId||
         !["accepted","delivered"].includes(state.state))
        return {state:"RECEIPT_UNMATCHED"};
      const saved=this.db.prepare(`INSERT OR IGNORE INTO sms_delivery_receipts
        (event_id,intent_id,provider_message_id,confirmed_at) VALUES(?,?,?,?)`)
        .run(eventId,state.intent_id,providerMessageId,now);
      if(saved.changes===0)return {state:"ALREADY_RECORDED"};
      this.db.prepare(`UPDATE sms_delivery_states SET state='delivered',
        updated_at=? WHERE intent_id=? AND state IN ('accepted','delivered')`)
        .run(now,state.intent_id);
      return {state:"DELIVERED"};
    });
  }
  snapshot(limit=200){
    if(!Number.isSafeInteger(limit)||limit<1||limit>500)
      throw Error("INVALID_SMS_SNAPSHOT_LIMIT");
    const rows=this.db.prepare(`SELECT i.intent_id AS intentId,i.workstream_id AS workstreamId,
      i.source_kind AS sourceKind,i.state AS intentState,d.state AS deliveryState,
      d.attempt_count AS attempts,d.next_attempt_at AS nextAttemptAt,
      d.reason_code AS reasonCode,d.updated_at AS updatedAt
      FROM notification_intents i LEFT JOIN sms_delivery_states d
      ON i.intent_id=d.intent_id
      ORDER BY i.created_at DESC,i.intent_id DESC LIMIT ?`).all(limit);
    return {mode:this.enabled?"fake_simulation":"fake_only_disabled_in_server",
      enabled:this.enabled,providerConfigured:false,actualSmsSends:0,records:rows.map(r=>({
        ...r,deliveryState:r.intentState==="coalesced"?"COALESCED":
          r.deliveryState==="claimed"?"IN_FLIGHT":
          (r.deliveryState||"pending").toUpperCase()
      }))};
  }
}

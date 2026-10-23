import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkstreamStore} from "../local/store.js";
import {OperatorInbox} from "../local/operator-inbox.js";
import {CiIncidentLedger} from "../local/ci-incident-ledger.js";
import {SmsDeliveryDispatcher} from "../local/sms-delivery-dispatcher.js";
import {FakeSmsProvider} from "../local/fake-sms-provider.js";

const NOW=Date.parse("2026-10-24T00:00:00Z");
const SHA="a".repeat(40);
function fixture({path=":memory:",transport=new FakeSmsProvider(),
  config={},enabled=true}={}){
  let time=NOW;
  const store=new WorkstreamStore(path);
  for(const id of ["saju","myeongha"]){
    if(!store.get(id))store.create({id,name:id,projectKey:id,
      repository:"owner/"+id},NOW);
  }
  const clock=()=>time;
  const inbox=new OperatorInbox(store,{now:clock});
  const incident=new CiIncidentLedger(store,{inbox,now:clock});
  const sms=new SmsDeliveryDispatcher(store,{transport,enabled,now:clock,...config});
  const blocker=(id="saju",key="test")=>incident.addBlocker(id,{
    reasonCode:"LOGIN_REQUIRED",evidenceKey:key});
  const approval=(id="saju")=>inbox.open(id,{
    reasonCategory:"approval",reasonCode:"HUMAN_REVIEW_REQUIRED",
    actionFingerprint:"c".repeat(64),headSha:SHA,
    evidenceTimestamp:time,expiresAt:time+60_000
  });
  return {store,inbox,incident,sms,transport,blocker,approval,
    time:()=>time,advance:ms=>{time+=ms;},now:clock};
}
const primary=f=>f.incident.notificationIntents().find(x=>x.state==="pending");
const dbrow=(f,id)=>f.store.db.prepare("SELECT * FROM sms_delivery_states WHERE intent_id=?").get(id);
const attempts=(f,id)=>f.store.db.prepare(`SELECT * FROM sms_delivery_attempts
  WHERE intent_id=? ORDER BY attempt_no`).all(id);

test("default dispatcher and unknown/real provider are fail-closed: no external send",async()=>{
  const f=fixture({enabled:false});
  try{
    const intent=primary((f.blocker(),f));
    assert.equal(f.sms.snapshot().enabled,false);
    await assert.rejects(f.sms.dispatch(intent.intentId),/SMS_DISPATCH_DISABLED/);
    await assert.rejects(f.sms.drain(),/SMS_DISPATCH_DISABLED/);
    assert.equal(f.transport.calls.length,0);
    assert.equal(attempts(f,intent.intentId).length,0);
    assert.equal(f.store.operations().length,0);
    assert.throws(()=>new SmsDeliveryDispatcher(f.store,{enabled:true}),
      /SMS_PROVIDER_NOT_APPROVED/);
    assert.throws(()=>new SmsDeliveryDispatcher(f.store,{
      transport:{kind:"real",send(){}},enabled:true}),/REAL_SMS_TRANSPORT_NOT_APPROVED/);
  }finally{f.store.close();}
});

test("accepted fake request is NOT a delivered SMS; idempotency key and receipts persist",async()=>{
  const f=fixture();
  try{
    f.blocker();
    const intent=primary(f);
    const result=await f.sms.dispatch(intent.intentId);
    assert.equal(result.state,"ACCEPTED");
    assert.equal(f.sms.snapshot().records[0].deliveryState,"ACCEPTED");
    assert.equal(result.attemptNo,1);
    assert.equal(result.nextAttemptAt,0);
    assert.equal(attempts(f,intent.intentId).length,1);
    assert.equal(attempts(f,intent.intentId)[0].delivery_key,
      dbrow(f,intent.intentId).delivery_key);
    assert.equal(f.transport.calls.length,1);
    assert.equal(f.transport.calls[0].intentId,intent.intentId);
    assert.equal(f.transport.calls[0].phoneNumber,undefined);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"ACCEPTED");
    assert.equal(f.transport.calls.length,1);
    assert.equal(f.sms.snapshot().actualSmsSends,0);
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("verified fake delivery receipt can mark DELIVERED once, forged and duplicate cannot",async()=>{
  const f=fixture();
  try{
    f.blocker();
    const intent=primary(f);
    const ack=await f.sms.dispatch(intent.intentId);
    const receipt=f.transport.receipt(ack.providerMessageId);
    assert.throws(()=>f.sms.acceptReceipt({...receipt,signature:"0".repeat(64)}),
      /SMS_RECEIPT_NOT_VERIFIED/);
    assert.throws(()=>f.sms.acceptReceipt({...receipt,providerMessageId:"fake-mismatched"}),
      /SMS_RECEIPT_NOT_VERIFIED/);
    assert.equal(f.sms.acceptReceipt(receipt).state,"DELIVERED");
    assert.equal(f.sms.acceptReceipt(receipt).state,"ALREADY_RECORDED");
    assert.equal(f.sms.snapshot().records[0].deliveryState,"DELIVERED");
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"DELIVERED");
    assert.equal(f.transport.calls.length,1);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sms_delivery_receipts").get().n,1);
  }finally{f.store.close();}
});

test("definitely NOT_SENT may retry with exponential backoff, maximum 3 attempts",async()=>{
  const fake=new FakeSmsProvider({outcomes:["not_sent","not_sent","accepted"]});
  const f=fixture({transport:fake});
  try{
    f.blocker();const intent=primary(f);
    let r=await f.sms.dispatch(intent.intentId);
    assert.equal(r.state,"NOT_SENT");
    assert.equal(r.nextAttemptAt,NOW+5000);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"BACKOFF");
    assert.equal(fake.calls.length,1);
    f.advance(5000);
    r=await f.sms.dispatch(intent.intentId);
    assert.equal(r.state,"NOT_SENT");
    assert.equal(r.nextAttemptAt,NOW+15000);
    f.advance(9999);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"BACKOFF");
    f.advance(1);
    r=await f.sms.dispatch(intent.intentId);
    assert.equal(r.state,"ACCEPTED");
    assert.equal(r.attemptNo,3);
    assert.equal(fake.calls.length,3);
    assert.equal(new Set(fake.calls.map(x=>x.deliveryKey)).size,1);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"ACCEPTED");
  }finally{f.store.close();}
});

test("three definitely NOT_SENT errors exhaust attempts, no fourth send",async()=>{
  const f=fixture({transport:new FakeSmsProvider({outcomes:["not_sent"]})});
  try{
    f.blocker();const intent=primary(f);
    for(const interval of [0,5000,10000]){
      f.advance(interval);
      await f.sms.dispatch(intent.intentId);
    }
    assert.equal(dbrow(f,intent.intentId).state,"exhausted");
    f.advance(1_000_000);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"EXHAUSTED");
    assert.equal(f.transport.calls.length,3);
    assert.equal(attempts(f,intent.intentId).length,3);
  }finally{f.store.close();}
});

test("network timeout and response-lost-after-accept are UNKNOWN and never replayed",async()=>{
  for(const outcome of ["timeout","crash_after_accept"]){
    const f=fixture({transport:new FakeSmsProvider({outcomes:[outcome]})});
    try{
      f.blocker();const intent=primary(f);
      assert.equal((await f.sms.dispatch(intent.intentId)).state,"UNKNOWN");
      assert.equal(f.sms.snapshot().records[0].deliveryState,"UNKNOWN");
      f.advance(2*86_400_000);
      assert.equal((await f.sms.dispatch(intent.intentId)).state,"UNKNOWN");
      assert.equal(f.sms.reconcile().unknown,0);
      assert.equal(f.transport.calls.length,1);
      assert.equal(attempts(f,intent.intentId).length,1);
      assert.equal(f.sms.snapshot().actualSmsSends,0);
    }finally{f.store.close();}
  }
});

test("expired lease becomes UNKNOWN; delayed ACK from old claim is ignored",()=>{
  const f=fixture({config:{leaseMs:2000}});
  try{
    f.blocker();const intent=primary(f);
    const claim=f.sms.claim(intent.intentId);
    assert.equal(claim.state,"CLAIMED");
    assert.equal(f.sms.claim(intent.intentId).state,"IN_FLIGHT");
    f.advance(2000);
    assert.equal(f.sms.reconcile().unknown,1);
    assert.equal(f.sms.finalize(claim,{
      status:"accepted",providerMessageId:"fake-old-ack"}).state,
      "STALE_RESULT_IGNORED");
    assert.equal(f.sms.snapshot().records[0].deliveryState,"UNKNOWN");
    assert.equal(f.transport.calls.length,0);
    assert.equal(f.sms.reconcile().unknown,0);
  }finally{f.store.close();}
});

test("restart with in-flight CLAIMED reconciles to UNKNOWN without calling fake provider again",()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-sms02-restart-"));
  const path=join(dir,"isolated.sqlite3");
  const fake=new FakeSmsProvider();
  try{
    let f=fixture({path,transport:fake,config:{leaseMs:1000}});
    f.blocker();
    const intent=primary(f),claim=f.sms.claim(intent.intentId);
    assert.equal(claim.state,"CLAIMED");
    f.store.close();
    f=fixture({path,transport:fake,config:{leaseMs:1000}});
    f.advance(1000);
    assert.equal(f.sms.reconcile().unknown,1);
    assert.equal(f.sms.claim(intent.intentId).state,"UNKNOWN");
    assert.equal(attempts(f,intent.intentId).length,1);
    assert.equal(fake.calls.length,0);
    f.store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test("source revalidation suppresses resolved blockers, closed or expired approval, and old revision",async()=>{
  const f=fixture();
  try{
    const b=f.blocker("saju","resolved");
    const first=primary(f);
    f.incident.resolveBlocker("saju",b.blockerKey);
    assert.equal((await f.sms.dispatch(first.intentId)).state,"SUPPRESSED");
    assert.equal(f.transport.calls.length,0);

    const request=f.approval("myeongha");
    const intent=f.incident.notificationIntents().find(x=>x.sourceKind==="approval");
    assert.equal(request.state,"pending");
    f.advance(60_000);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"SUPPRESSED");

    f.blocker("saju","once");
    const old=f.incident.notificationIntents().find(x=>x.sourceKind==="blocker"&&x.sourceKey!==b.blockerKey);
    f.incident.resolveBlocker("saju",old.sourceKey);
    f.blocker("saju","once");
    const newIntent=f.incident.notificationIntents().find(x=>
      x.sourceKind==="blocker"&&x.sourceKey===old.sourceKey&&x.sourceRevision>old.sourceRevision);
    assert.equal((await f.sms.dispatch(old.intentId)).state,"SUPPRESSED");
    assert.equal((await f.sms.dispatch(newIntent.intentId)).state,"ACCEPTED");
  }finally{f.store.close();}
});

test("coalesced pause has no claim and standalone pause is revalidated",async()=>{
  const f=fixture();
  try{
    f.incident.addBlocker("saju",{reasonCode:"DATA_CORRUPTION",
      evidenceKey:"db",severity:"critical"});
    const pause=f.incident.notificationIntents().find(x=>x.sourceKind==="pause");
    assert.equal(pause.state,"coalesced");
    assert.equal((await f.sms.dispatch(pause.intentId)).state,"COALESCED");
    assert.equal(f.transport.calls.length,0);
  }finally{f.store.close();}
});

test("per-day and per-workstream fake attempt budgets cap attempts without changing authorization",async()=>{
  const f=fixture({config:{maxDailyAttempts:2,maxWorkstreamDailyAttempts:1}});
  try{
    f.blocker("saju","a");f.blocker("saju","b");f.blocker("myeongha","c");
    const items=f.incident.notificationIntents();
    const first=items.find(x=>x.workstreamId==="saju");
    const second=items.filter(x=>x.workstreamId==="saju").find(x=>x.intentId!==first.intentId);
    const other=items.find(x=>x.workstreamId==="myeongha");
    assert.equal((await f.sms.dispatch(first.intentId)).state,"ACCEPTED");
    assert.equal((await f.sms.dispatch(second.intentId)).state,"BUDGET_LIMIT");
    assert.equal((await f.sms.dispatch(other.intentId)).state,"ACCEPTED");
    assert.equal(f.transport.calls.length,2);
    f.advance(1);
    assert.equal((await f.sms.dispatch(second.intentId)).state,"BUDGET_LIMIT");
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("20 independent workstreams concurrent drainers never double claim an intent",async()=>{
  const f=fixture({config:{maxDailyAttempts:40,maxWorkstreamDailyAttempts:2,maxBatch:20}});
  try{
    for(let i=0;i<20;i++){
      const id="work-"+i;
      f.store.create({id,name:id,projectKey:"demo",repository:"owner/demo"},NOW);
      f.blocker(id,"same-source");
    }
    const [a,b]=await Promise.all([f.sms.drain(20),f.sms.drain(20)]);
    assert.ok(a.length+b.length>=20);
    assert.equal(f.transport.calls.length,20);
    assert.equal(new Set(f.transport.calls.map(x=>x.deliveryKey)).size,20);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sms_delivery_attempts").get().n,20);
    assert.equal(f.store.operations().length,0);
    assert.equal(f.incident.notificationIntents().length,20);
    assert.ok(f.incident.notificationIntents().every(x=>x.sourceKind==="blocker"));
  }finally{f.store.close();}
});

test("read-only snapshot never auto sends, and old SQLite intent/outbox rows survive additive schema",()=>{
  const f=fixture();
  try{
    f.incident.addBlocker("saju",{reasonCode:"CRITICAL_CORRUPTION",
      evidenceKey:"important",severity:"critical"});
    const before=f.incident.alerts(),all=f.incident.notificationIntents();
    new SmsDeliveryDispatcher(f.store);
    assert.deepEqual(f.incident.alerts(),before);
    assert.deepEqual(f.incident.notificationIntents(),all);
    const read=f.sms.snapshot();
    assert.equal(read.records.length,2);
    assert.equal(read.records.find(x=>x.intentState==="coalesced").deliveryState,"COALESCED");
    assert.equal(f.transport.calls.length,0);
    assert.equal(f.store.operations().length,0);
    assert.equal(f.store.get("saju").paused,true);
  }finally{f.store.close();}
});

test("invalid fake payload and unverified delivery receipt are rejected before mutation",async()=>{
  const f=fixture();
  try{
    f.blocker();const intent=primary(f);
    assert.equal((await f.sms.dispatch(intent.intentId)).state,"ACCEPTED");
    assert.throws(()=>f.sms.acceptReceipt({
      eventId:"evt-fake",deliveryKey:dbrow(f,intent.intentId).delivery_key,
      providerMessageId:"fake-unrelated",signature:"0".repeat(64)
    }),/SMS_RECEIPT_NOT_VERIFIED/);
    assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM sms_delivery_receipts").get().n,0);
  }finally{f.store.close();}
});

test("permanent failure stops immediately; an unrecognized provider response is UNKNOWN",async()=>{
  const permanent=fixture({transport:new FakeSmsProvider({outcomes:["permanent_failure"]})});
  try{
    permanent.blocker();const intent=primary(permanent);
    assert.equal((await permanent.sms.dispatch(intent.intentId)).state,"PERMANENT_FAILURE");
    permanent.advance(3*86_400_000);
    assert.equal((await permanent.sms.dispatch(intent.intentId)).state,"PERMANENT_FAILURE");
    assert.equal(permanent.transport.calls.length,1);
  }finally{permanent.store.close();}
  const weird=fixture();
  try{
    weird.transport.send=async input=>{
      weird.transport.calls.push(input);
      return {status:"delivered",providerMessageId:"cannot-claim-delivered-directly"};
    };
    weird.blocker();
    const intent=primary(weird);
    assert.equal((await weird.sms.dispatch(intent.intentId)).state,"UNKNOWN");
    assert.equal((await weird.sms.dispatch(intent.intentId)).state,"UNKNOWN");
    assert.equal(weird.transport.calls.length,1);
    assert.equal(dbrow(weird,intent.intentId).provider_message_id,null);
  }finally{weird.store.close();}
});

test("two independent SQLite connections cannot both claim same durable intent",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-sms02-dual-"));
  const path=join(dir,"db.sqlite3"),fake=new FakeSmsProvider();
  let a=null,b=null;
  try{
    a=fixture({path,transport:fake});
    a.blocker();
    const id=primary(a).intentId;
    b=fixture({path,transport:fake});
    const [first,second]=await Promise.all([
      a.sms.dispatch(id),b.sms.dispatch(id)
    ]);
    assert.deepEqual([first.state,second.state].sort(),["ACCEPTED","IN_FLIGHT"].sort());
    assert.equal(fake.calls.length,1);
    assert.equal(attempts(a,id).length,1);
    assert.equal(dbrow(b,id).state,"accepted");
    assert.equal(a.store.operations().length,0);
  }finally{
    a?.store.close();b?.store.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test("source tables unavailable cannot be turned into false success or irreversible suppression",()=>{
  const f=fixture();
  try{
    f.blocker();const intent=primary(f);
    f.store.db.exec("DROP TABLE ci_blockers");
    assert.equal(f.sms.claim(intent.intentId).state,"SOURCE_NOT_READY");
    assert.equal(f.transport.calls.length,0);
    assert.equal(dbrow(f,intent.intentId).state,"pending");
  }finally{f.store.close();}
});

import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkstreamStore} from "../local/store.js";
import {OperatorInbox} from "../local/operator-inbox.js";
import {CiIncidentLedger} from "../local/ci-incident-ledger.js";
import {NotificationIntents} from "../local/notification-intents.js";

const NOW=1234000, SHA="a".repeat(40),E="e".repeat(64),F="f".repeat(64);
const approval={reasonCategory:"approval",reasonCode:"HUMAN_REVIEW_REQUIRED",
  actionFingerprint:"c".repeat(64),headSha:SHA,
  evidenceTimestamp:NOW,expiresAt:NOW+600000};

function context(path=":memory:"){
  const store=new WorkstreamStore(path);
  for(const id of ["saju","myeongha"])
    if(!store.get(id))store.create({id,name:id,projectKey:id,
      repository:"owner/"+id},NOW);
  const inbox=new OperatorInbox(store,{now:()=>NOW});
  const ledger=new CiIncidentLedger(store,{inbox,now:()=>NOW});
  return {store,inbox,ledger,items:()=>ledger.notificationIntents()};
}

test("first ordinary blocker creates one durable intent even below 3-item stop threshold",()=>{
  const f=context();
  try{
    const first=f.ledger.addBlocker("saju",{reasonCode:"LOGIN_REQUIRED",evidenceKey:"identity"});
    const rows=f.items();
    assert.equal(rows.length,1);
    assert.equal(rows[0].sourceKind,"blocker");
    assert.equal(rows[0].sourceKey,first.blockerKey);
    assert.equal(rows[0].sourceRevision,1);
    assert.equal(rows[0].reasonCode,"LOGIN_REQUIRED");
    assert.equal(rows[0].state,"pending");
    assert.equal(f.ledger.alerts().length,0); // existing pause-only outbox not altered
    assert.equal(f.store.get("saju").paused,false);
    for(let k=0;k<15;k++)f.ledger.addBlocker("saju",{
      reasonCode:"LOGIN_REQUIRED",evidenceKey:"identity"});
    assert.deepEqual(f.items(),rows);
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("critical blocker immediately pauses, but coalesces the escalation into one eligible intent",()=>{
  const f=context();
  try{
    const b=f.ledger.addBlocker("saju",{
      reasonCode:"CRITICAL_CORRUPTION",evidenceKey:"db:checksum",severity:"critical"});
    assert.equal(b.paused,true);
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("myeongha").paused,false);
    const items=f.items();
    assert.equal(items.length,2);
    const primary=items.find(x=>x.sourceKind==="blocker");
    const secondary=items.find(x=>x.sourceKind==="pause");
    assert.equal(primary.state,"pending");
    assert.equal(primary.severity,"critical");
    assert.equal(secondary.state,"coalesced");
    assert.equal(secondary.coalescedInto,primary.intentId);
    assert.equal(f.ledger.alerts().length,1);
    assert.equal(f.ledger.alerts()[0].status,"pending");
    f.ledger.holdIfNeeded("saju");
    assert.equal(f.items().length,2);
  }finally{f.store.close();}
});

test("three distinct blockers produce three intents plus one coalesced pause record",()=>{
  const f=context();
  try{
    for(const [reason,key] of [["LOGIN_REQUIRED","a"],["CI_FAILURE","b"],["CREDENTIAL_EXPIRED","c"]])
      f.ledger.addBlocker("saju",{reasonCode:reason,evidenceKey:key});
    assert.equal(f.ledger.count("saju").open,3);
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("myeongha").paused,false);
    const items=f.items();
    assert.equal(items.length,4);
    assert.equal(items.filter(x=>x.state==="pending").length,3);
    assert.equal(items.filter(x=>x.state==="coalesced").length,1);
    assert.equal(f.ledger.alerts().length,1);
    f.ledger.addBlocker("saju",{reasonCode:"CI_FAILURE",evidenceKey:"b"});
    assert.equal(f.items().length,4);
  }finally{f.store.close();}
});

test("resolved blocker recurrence creates new generation but never clears old intent or auto-unpauses",()=>{
  const f=context();
  try{
    const b=f.ledger.addBlocker("saju",{
      reasonCode:"CRITICAL_CORRUPTION",evidenceKey:"db",severity:"critical"});
    const before=f.items().filter(x=>x.sourceKind==="blocker");
    f.ledger.resolveBlocker("saju",b.blockerKey);
    assert.equal(f.store.get("saju").paused,true);
    f.ledger.addBlocker("saju",{
      reasonCode:"CRITICAL_CORRUPTION",evidenceKey:"db",severity:"critical"});
    const after=f.items().filter(x=>x.sourceKind==="blocker");
    assert.equal(after.length,2);
    assert.deepEqual(after.map(x=>x.sourceRevision).sort(),[1,2]);
    assert.equal(f.ledger.alerts().length,2);
    assert.equal(f.items().filter(x=>x.state==="pending").length,2);
  }finally{f.store.close();}
});

test("first Operator Inbox approval requests pause instantly and each create one non-secret intent",()=>{
  const f=context();
  try{
    const req=f.inbox.open("saju",approval);
    const single=f.items();
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("myeongha").paused,false);
    assert.equal(single.length,1);
    assert.equal(single[0].sourceKind,"approval");
    assert.equal(single[0].sourceKey,req.requestId);
    assert.equal(single[0].sourceRevision,1);
    assert.equal(single[0].state,"pending");
    for(let i=0;i<10;i++)f.inbox.open("saju",approval);
    assert.deepEqual(f.items(),single);
    f.inbox.acknowledge(req.requestId);
    assert.equal(f.items().length,1);
    assert.doesNotMatch(JSON.stringify(f.items()),new RegExp(approval.actionFingerprint));
    assert.doesNotMatch(JSON.stringify(f.items()),new RegExp(SHA));
  }finally{f.store.close();}
});

test("reopened approval request increments its revision and re-notifies once; approvals never authorize dispatch",()=>{
  const f=context();
  try{
    const one=f.inbox.open("saju",approval);
    f.inbox.close(one.requestId,approval.actionFingerprint);
    const two=f.inbox.open("saju",approval);
    assert.equal(two.requestId,one.requestId);
    // close increments the request revision, then reopen increments it again.
    assert.equal(two.revision,one.revision+2);
    assert.equal(f.items().length,2);
    assert.deepEqual(f.items().map(x=>x.sourceRevision).sort(),[1,3]);
    assert.equal(f.inbox.open("saju",approval).revision,3);
    assert.equal(f.items().length,2);
    assert.equal(f.store.operations().length,0);
    assert.equal(f.store.get("saju").paused,true);
  }finally{f.store.close();}
});

test("exhausted CI retries generate one blocker intent; repeated RED polls do not spam",()=>{
  const f=context();
  try{
    const progress={
      workstreamId:"saju",repository:"owner/saju",prNumber:2704,headSha:SHA,
      evidenceHash:E,verified:true,state:"RED",
      ordinaryChecks:[{name:"CI Verify",state:"FAILURE"}],integrationChecks:[]
    };
    const first=f.ledger.observe(progress);
    assert.equal(f.items().length,0); // repair review is not yet a blocker
    for(let i=1;i<=2;i++)f.ledger.acknowledgeRepair({
      workstreamId:"saju",fingerprint:first.fingerprint,evidenceHash:E,
      operationId:"repair-"+i,accepted:true
    });
    f.ledger.observe({...progress,headSha:"b".repeat(40),evidenceHash:F});
    assert.equal(f.items().filter(x=>x.sourceKind==="blocker").length,1);
    for(let i=0;i<12;i++)f.ledger.observe({...progress,headSha:"b".repeat(40),evidenceHash:F});
    assert.equal(f.items().length,1);
    assert.equal(f.store.get("saju").paused,false); // one noncritical blocker is below threshold
  }finally{f.store.close();}
});

test("a failed SQL event transaction rolls back BOTH canonical change and notification intent",()=>{
  const f=context();
  try{
    assert.throws(()=>f.store.transaction(()=>{
      f.ledger.notifications.record({workstreamId:"saju",sourceKind:"blocker",
        sourceKey:"a".repeat(64),reasonCode:"LOGIN_REQUIRED"});
      throw Error("CRASH_BEFORE_COMMIT");
    }),/CRASH_BEFORE_COMMIT/);
    assert.equal(f.items().length,0);
    assert.equal(f.store.events().some(x=>x.kind==="notification_intent_recorded"),false);
    assert.throws(()=>f.ledger.notifications.record({
      workstreamId:"saju",sourceKind:"blocker",sourceKey:"a".repeat(64),
      reasonCode:"LOGIN_REQUIRED"}),/NOTIFICATION_SOURCE_TRANSACTION_REQUIRED/);
  }finally{f.store.close();}
});

test("disk restart preserves intents, legacy pause outbox and the original workstream state",()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-sms01-"));
  const file=join(dir,"isolated.sqlite3");
  try{
    let f=context(file);
    f.ledger.addBlocker("saju",{reasonCode:"CRITICAL_CORRUPTION",evidenceKey:"critical",
      severity:"critical"});
    f.inbox.open("myeongha",approval);
    const saved=f.items(),alerts=f.ledger.alerts();
    f.store.close();
    f=context(file);
    assert.deepEqual(f.items(),saved);
    assert.deepEqual(f.ledger.alerts(),alerts);
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("myeongha").paused,true);
    f.store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("upgrade from an existing incident/outbox schema is additive and does not backfill old alerts",()=>{
  const f=context();
  try{
    f.ledger.addBlocker("saju",{reasonCode:"CRITICAL_CORRUPTION",
      evidenceKey:"old",severity:"critical"});
    const legacy=f.ledger.alerts(),count=f.ledger.count("saju");
    f.store.db.exec("DROP TABLE notification_intents");
    const migrated=new CiIncidentLedger(f.store,{inbox:f.inbox,now:()=>NOW});
    assert.deepEqual(migrated.alerts(),legacy);
    assert.deepEqual(migrated.count("saju"),count);
    assert.deepEqual(migrated.notificationIntents(),[]);
    migrated.addBlocker("saju",{reasonCode:"CRITICAL_CORRUPTION",
      evidenceKey:"old",severity:"critical"});
    assert.equal(migrated.notificationIntents().length,0);
    migrated.addBlocker("saju",{reasonCode:"NEW_BLOCKER",evidenceKey:"new"});
    assert.equal(migrated.notificationIntents().length,1);
  }finally{f.store.close();}
});

test("20 independent workstreams can record parallel event calls without duplicates or cross-track pause",async()=>{
  const f=context();
  try{
    for(let i=0;i<20;i++)f.store.create({id:"parallel-"+i,name:"Parallel "+i,
      projectKey:"project",repository:"owner/parallel"},NOW);
    await Promise.all(Array.from({length:20},async(_,i)=>{
      const id="parallel-"+i;
      await Promise.all(Array.from({length:10},async()=>f.ledger.addBlocker(id,{
        reasonCode:"CI_WAIT_TIMEOUT",evidenceKey:"same-event"})));
    }));
    const intents=f.items();
    assert.equal(intents.length,20);
    assert.equal(new Set(intents.map(x=>x.workstreamId)).size,20);
    assert.ok(intents.every(x=>x.state==="pending"&&x.sourceKind==="blocker"));
    assert.equal(f.store.get("saju").paused,false);
    assert.equal(f.store.get("parallel-19").paused,false);
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

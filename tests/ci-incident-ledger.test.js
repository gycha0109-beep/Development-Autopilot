import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {CiIncidentLedger} from "../local/ci-incident-ledger.js";
import {OperatorInbox} from "../local/operator-inbox.js";

const NOW=1_234_000,SHA="a".repeat(40),ALT="b".repeat(40),E="e".repeat(64);
function fixture(){
  let now=NOW;
  const store=new WorkstreamStore();
  store.create({id:"chat",name:"Chat",projectKey:"myeongha",repository:"owner/myeongha"},NOW);
  store.create({id:"saju",name:"Saju",projectKey:"myeongha",repository:"owner/saju"},NOW);
  const inbox=new OperatorInbox(store,{now:()=>now});
  let ledger=new CiIncidentLedger(store,{inbox,now:()=>now});
  const progress=(patch={})=>({
    workstreamId:"chat",repository:"owner/myeongha",prNumber:2495,headSha:SHA,
    evidenceHash:E,verified:true,state:"RED",ordinaryChecks:[{name:"CI Verify",state:"FAILURE"}],
    integrationChecks:[],...patch
  });
  return {store,inbox,progress,get ledger(){return ledger;},now(value){now=value;},
    restart(){ledger=new CiIncidentLedger(store,{inbox,now:()=>now});return ledger;}};
}
test("RED creates one deduplicated failure episode; observation does not consume retry budget",()=>{
  const f=fixture();try{
    const first=f.ledger.observe(f.progress());
    const repeated=f.ledger.observe(f.progress());
    assert.equal(first.state,"REPAIR_REVIEW");
    assert.equal(repeated.fingerprint,first.fingerprint);
    assert.equal(repeated.attempts,0);
    assert.equal(f.ledger.list().find(t=>t.workstreamId==="chat").incidents.length,1);
    assert.equal(f.store.get("chat").paused,false);
  }finally{f.store.close();}
});
test("two accepted repair dispatch receipts are counted once each and the third is rejected",()=>{
  const f=fixture();try{
    const red=f.ledger.observe(f.progress());
    const args=(operationId,evidenceHash=E)=>({workstreamId:"chat",fingerprint:red.fingerprint,
      evidenceHash,operationId,accepted:true});
    assert.equal(f.ledger.acknowledgeRepair(args("try-1")).attempts,1);
    assert.throws(()=>f.ledger.acknowledgeRepair(args("try-1")),/CI_REPAIR_DUPLICATE_OPERATION/);
    assert.throws(()=>f.ledger.acknowledgeRepair(args("try-bad","f".repeat(64))),/CI_REPAIR_NOT_ELIGIBLE/);
    assert.equal(f.ledger.acknowledgeRepair(args("try-2")).attempts,2);
    assert.throws(()=>f.ledger.acknowledgeRepair(args("try-3")),/CI_REPAIR_NOT_ELIGIBLE/);
    const redAgain=f.ledger.observe(f.progress({headSha:ALT,evidenceHash:"f".repeat(64)}));
    assert.equal(redAgain.state,"BLOCKED");
    assert.equal(redAgain.counts.blockers,1);
    assert.equal(f.store.get("chat").paused,false);
    assert.equal(f.store.get("saju").paused,false);
  }finally{f.store.close();}
});
test("the same failed check across a new SHA keeps one incident; a new task revision creates a new episode",()=>{
  const f=fixture();try{
    const first=f.ledger.observe(f.progress());
    f.ledger.acknowledgeRepair({workstreamId:"chat",fingerprint:first.fingerprint,
      evidenceHash:E,operationId:"try-1",accepted:true});
    const second=f.ledger.observe(f.progress({headSha:ALT,evidenceHash:"f".repeat(64)}));
    assert.equal(second.fingerprint,first.fingerprint);
    assert.equal(second.attempts,1);
    f.store.db.prepare("UPDATE workstreams SET task_revision=task_revision+1 WHERE id='chat'").run();
    const third=f.ledger.observe(f.progress());
    assert.notEqual(third.fingerprint,first.fingerprint);
    assert.equal(third.attempts,0);
  }finally{f.store.close();}
});
test("three distinct unresolved blockers pause only their track and enqueue exactly one alert",()=>{
  const f=fixture();try{
    const add=(reason,detail)=>f.ledger.addBlocker("chat",{reasonCode:reason,evidenceKey:detail});
    add("CI_RETRY_EXHAUSTED","a");
    add("CI_RETRY_EXHAUSTED","a");
    add("LOGIN_REQUIRED","b");
    assert.equal(f.ledger.count("chat").open,2);
    assert.equal(f.store.get("chat").paused,false);
    const third=add("CREDENTIAL_EXPIRED","c");
    assert.equal(third.paused,true);
    assert.equal(f.store.get("chat").paused,true);
    assert.equal(f.store.get("saju").paused,false);
    assert.equal(f.ledger.alerts().length,1);
    add("CREDENTIAL_EXPIRED","c");
    add("CONTRACT_CONFLICT","d");
    assert.equal(f.ledger.alerts().length,1);
    assert.equal(f.ledger.alerts()[0].status,"pending");
    assert.equal(f.ledger.alerts()[0].eventKind,"workstream-paused");
  }finally{f.store.close();}
});
test("a cleared blocker episode may notify again on a new stop without duplicate alerts",()=>{
  const f=fixture();try{
    const first=f.ledger.addBlocker("chat",{reasonCode:"DATA_INTEGRITY",evidenceKey:"db",severity:"critical"});
    assert.equal(f.ledger.alerts().length,1);
    f.ledger.resolveBlocker("chat",first.blockerKey);
    f.ledger.addBlocker("chat",{reasonCode:"DATA_INTEGRITY",evidenceKey:"db",severity:"critical"});
    assert.equal(f.ledger.alerts().length,2);
    assert.notEqual(f.ledger.alerts()[0].alertKey,f.ledger.alerts()[1].alertKey);
  }finally{f.store.close();}
});
test("critical blocker stops at one; resolving never silently resumes workstream",()=>{
  const f=fixture();try{
    const r=f.ledger.addBlocker("saju",{reasonCode:"DATA_INTEGRITY",evidenceKey:"db",severity:"critical"});
    assert.equal(r.paused,true);
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("chat").paused,false);
    assert.equal(f.ledger.alerts()[0].reasonCode,"CRITICAL_BLOCKER");
    f.ledger.resolveBlocker("saju",r.blockerKey);
    assert.equal(f.ledger.count("saju").open,0);
    assert.equal(f.store.get("saju").paused,true);
  }finally{f.store.close();}
});
test("Inbox requests contribute to threshold without inflating identical requests",()=>{
  const f=fixture();try{
    f.ledger.addBlocker("chat",{reasonCode:"CI_RETRY_EXHAUSTED",evidenceKey:"a"});
    f.ledger.addBlocker("chat",{reasonCode:"ENVIRONMENT_DENIED",evidenceKey:"b"});
    const args={reasonCategory:"approval",reasonCode:"HUMAN_ACTION_CUE",actionFingerprint:"a".repeat(64),
      headSha:SHA,evidenceTimestamp:NOW,expiresAt:NOW+100000};
    const request=f.inbox.open("chat",args);
    assert.equal(f.inbox.open("chat",args).requestId,request.requestId);
    const result=f.ledger.holdIfNeeded("chat");
    assert.equal(result.open,3);
    assert.equal(result.paused,true);
    assert.equal(f.ledger.alerts().length,1);
  }finally{f.store.close();}
});
test("GREEN resolves only CI-generated blockers; UNKNOWN never clears them",()=>{
  const f=fixture();try{
    const red=f.ledger.observe(f.progress());
    f.ledger.acknowledgeRepair({workstreamId:"chat",fingerprint:red.fingerprint,evidenceHash:E,
      operationId:"1",accepted:true});
    f.ledger.acknowledgeRepair({workstreamId:"chat",fingerprint:red.fingerprint,evidenceHash:E,
      operationId:"2",accepted:true});
    f.ledger.observe(f.progress());
    f.ledger.addBlocker("chat",{reasonCode:"USER_APPROVAL",evidenceKey:"manual"});
    assert.equal(f.ledger.count("chat").open,2);
    f.ledger.observe(f.progress({state:"UNKNOWN",verified:false}));
    assert.equal(f.ledger.count("chat").open,2);
    f.ledger.observe(f.progress({state:"GREEN",ordinaryChecks:[{name:"CI Verify",state:"SUCCESS"}]}));
    assert.equal(f.ledger.count("chat").open,1);
    assert.equal(f.ledger.list().find(x=>x.workstreamId==="chat").incidents[0].state,"resolved");
  }finally{f.store.close();}
});
test("restart preserves attempts, blockers and pending notifications without sending SMS",()=>{
  const f=fixture();try{
    f.ledger.addBlocker("chat",{reasonCode:"LOGIN_REQUIRED",evidenceKey:"1"});
    f.ledger.addBlocker("chat",{reasonCode:"LOGIN_REQUIRED",evidenceKey:"2"});
    f.ledger.addBlocker("chat",{reasonCode:"LOGIN_REQUIRED",evidenceKey:"3"});
    const current=f.ledger.alerts();
    f.restart();
    assert.equal(f.ledger.count("chat").open,3);
    assert.deepEqual(f.ledger.alerts(),current);
  }finally{f.store.close();}
});

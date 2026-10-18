import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {AutopilotState} from "../local/autopilot-state.js";
import {DisconnectRecovery} from "../local/disconnect-recovery.js";
import {inputs,scope,policy,observation,ciEvidence,NOW,BINDING} from "../test-support/autopilot-fixture.js";
import {FairWorkQueue} from "../local/fair-work-queue.js";
import {queueLimits} from "../test-support/queue-limits.js";

function fixture(overrides={}){
  const store=new WorkstreamStore();let now=NOW,stops=0,reports=0,stopId,reportId;
  store.create({id:"work",name:"Test",projectKey:"project",repository:"owner/repo",trackKey:"track"},NOW-5000);
  const state=new AutopilotState(store,{now:()=>now});
  const ctx=inputs({scope:scope({recoveryPermitted:true,reportMessageHash:"e".repeat(64)}),
    policy:{...policy,maxRecoveryAttempts:2,recoveryCooldownMs:5000,recoveryStepTimeoutMs:10_000}});
  const callbacks={state,context:()=>ctx,now:()=>now,
    queue:overrides.withQueue?new FairWorkQueue(store,{limits:queueLimits({recovery:{leaseMs:20_000}}),now:()=>now}):null,
    stop:async intent=>{stops++;stopId=intent.operationId;
      assert.equal(store.db.prepare("SELECT status FROM operations WHERE id=?").get(stopId).status,"reserved");
      return {...intent,outcome:"clicked"};},
    verifyStopped:async intent=>({...intent,verified:true,observedAt:now}),
    requestReport:async intent=>{reports++;reportId=intent.operationId;
      assert.equal(store.db.prepare("SELECT status FROM operations WHERE id=?").get(reportId).status,"reserved");
      return {...intent,outcome:"submitted"};},
    verifyReport:async intent=>({...intent,verified:true}),...overrides};
  let recovery=new DisconnectRecovery(store,callbacks);
  const warning={connectionWarning:true,assistantBusy:true,stopControlVerified:true};
  state.evaluate("work",observation({observedAt:NOW-1000,...warning}),ctx);
  state.evaluate("work",observation(warning),ctx);
  const sample=(at,patch={})=>{now=at;return state.evaluate("work",observation({observedAt:at,...patch}),ctx);};
  const begin=()=>recovery.begin("work");
  const stopAndVerify=async()=>{begin();await recovery.advance("work");sample(NOW+1000);return recovery.advance("work");};
  const reportAndVerify=async(patch={})=>{await stopAndVerify();await recovery.advance("work");
    sample(NOW+2000,{replyFingerprint:"d".repeat(64),...patch});await recovery.advance("work");
    sample(NOW+3000,{replyFingerprint:"d".repeat(64),...patch});return recovery.advance("work");};
  return {store,state,ctx,sample,begin,stopAndVerify,reportAndVerify,
    get recovery(){return recovery;},stops:()=>stops,reports:()=>reports,
    clock:at=>{now=at;},restart:()=>{recovery=new DisconnectRecovery(store,callbacks);return recovery;}};
}

test("stop intent, independent stop proof, one report, independent reply proof, then full gate reevaluation",async()=>{
  const f=fixture();try{
    assert.equal((await f.reportAndVerify()).stage,"REPORT_RESPONSE_VERIFIED");
    const result=await f.recovery.advance("work");assert.equal(result.stage,"DONE");
    assert.equal(result.decision.nextAction,"CONTINUE");assert.equal(f.stops(),1);assert.equal(f.reports(),1);
    assert.equal(f.store.operations().filter(op=>op.status==="completed").length,2);
    assert.equal(f.state.pending("work"),null);
    await f.recovery.advance("work");assert.equal(f.stops(),1);assert.equal(f.reports(),1);
  }finally{f.store.close();}
});

test("recovery purpose queue budgets Stop/report while preserving their pre-effect intents",async()=>{
  const f=fixture({withQueue:true});try{
    assert.equal((await f.reportAndVerify()).stage,"REPORT_RESPONSE_VERIFIED");
    assert.equal((await f.recovery.advance("work")).decision.nextAction,"CONTINUE");
    assert.equal(f.stops(),1);assert.equal(f.reports(),1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM autopilot_queue_tasks WHERE kind='recovery'").get().n,2);
  }finally{f.store.close();}
});

test("hung effect requests abort and becomes UNKNOWN without a second external attempt",async()=>{
  let aborted=false,calls=0;
  const f=fixture({stop:intent=>{calls++;intent.signal.addEventListener("abort",()=>{aborted=true;});return new Promise(()=>{});}});
  try{
    f.ctx.policy.recoveryStepTimeoutMs=1000;f.begin();
    assert.equal((await f.recovery.advance("work")).stage,"UNKNOWN");assert.equal(aborted,true);
    await f.recovery.advance("work");assert.equal(calls,1);
  }finally{f.store.close();}
});

test("warning disappears before stop: no click and no report",async()=>{
  const f=fixture();try{f.begin();f.sample(NOW+1000);
    assert.equal((await f.recovery.advance("work")).reason,"WARNING_CLEARED_NO_CLICK");
    assert.equal(f.stops(),0);assert.equal(f.reports(),0);
  }finally{f.store.close();}
});

test("a click acknowledgement never authorizes a report without independent stop proof",async()=>{
  const f=fixture({verifyStopped:async()=>({verified:false})});try{
    f.begin();await f.recovery.advance("work");f.sample(NOW+1000);
    for(let i=0;i<3;i++)assert.equal((await f.recovery.advance("work")).stage,"STOP_RESULT_PENDING");
    assert.equal(f.stops(),1);assert.equal(f.reports(),0);
  }finally{f.store.close();}
});

test("unknown stop/transport result stays UNKNOWN after recreation and cannot replay",async()=>{
  for(const stop of [async()=>{throw Error("PRIVATE_NETWORK_ERROR");},async()=>({outcome:"clicked",operationId:"wrong",bindingFingerprint:BINDING})]){
    const f=fixture({stop});try{f.begin();assert.equal((await f.recovery.advance("work")).stage,"UNKNOWN");
      f.restart();await f.recovery.advance("work");assert.equal(f.recovery.begin("work"),null);
      assert.equal(f.store.operations().length,1);assert.doesNotMatch(JSON.stringify(f.store.events()),/PRIVATE_/);
    }finally{f.store.close();}
  }
});

test("persisted pre-click intent is UNKNOWN on restart, never sent again",async()=>{
  const f=fixture();try{const row=f.begin();f.recovery.intent("work",row,"stop");
    f.restart();assert.equal(f.recovery.reconcile(),1);assert.equal(f.recovery.reconcile(),0);
    assert.equal((await f.recovery.advance("work")).stage,"UNKNOWN");assert.equal(f.stops(),0);
    assert.throws(()=>f.store.deleteWorkstream("work","Test",NOW),/RECOVERY_IN_FLIGHT/);
  }finally{f.store.close();}
});

test("uncertain report does not send another report after restart",async()=>{
  const f=fixture({requestReport:async()=>{throw Error("ACK_LOST");}});try{
    await f.stopAndVerify();assert.equal((await f.recovery.advance("work")).stage,"UNKNOWN");
    f.restart();await f.recovery.advance("work");assert.equal(f.store.operations().length,2);
  }finally{f.store.close();}
});

test("new reply alone is insufficient when report provenance is unverified",async()=>{
  const f=fixture({verifyReport:async()=>({verified:false})});try{
    assert.equal((await f.reportAndVerify()).stage,"REPORT_RESULT_PENDING");assert.equal(f.reports(),1);
    f.clock(NOW+20_000);assert.equal((await f.recovery.advance("work")).stage,"WAIT_HUMAN");
    assert.equal(f.reports(),1);
  }finally{f.store.close();}
});

test("CI in the verified status report returns WAIT_CI and no continuation action is executed",async()=>{
  const f=fixture();try{const ci=ciEvidence();Object.assign(ci.watchtower.results[0],{decision:"WAIT_EXTERNAL",ciState:"RUNNING"});f.ctx.ci=ci;
    await f.reportAndVerify({ciWaitCue:true});const result=await f.recovery.advance("work");
    assert.equal(result.decision.nextAction,"WAIT_CI");assert.equal(f.reports(),1);assert.equal(f.stops(),1);
  }finally{f.store.close();}
});

test("cost/approval in the report, quota, draft, ambiguous Stop and revoked approval require operator",async()=>{
  for(const mutate of [f=>f.sample(NOW+1000,{providerRestriction:true}),f=>f.sample(NOW+1000,{composerHasDraft:true}),
    f=>f.sample(NOW+1000,{connectionWarning:true,assistantBusy:true,stopControlVerified:false}),
    f=>f.sample(NOW+1000,{connectionWarning:true,lengthWarning:true,assistantBusy:true,stopControlVerified:true}),
    f=>{f.ctx.scope.expiresAt=NOW;},f=>f.store.setStopped(true,NOW)]){
    const f=fixture();try{f.begin();mutate(f);const result=await f.recovery.advance("work");
      assert.equal(result.stage,"WAIT_HUMAN");assert.equal(f.stops(),0);assert.equal(f.reports(),0);
    }finally{f.store.close();}
  }
  const f=fixture();try{await f.stopAndVerify();await f.recovery.advance("work");f.sample(NOW+2000,{humanActionCue:true,replyFingerprint:"d".repeat(64)});
    assert.equal((await f.recovery.advance("work")).stage,"WAIT_HUMAN");assert.equal(f.reports(),1);
  }finally{f.store.close();}
});

test("a fresh snapshot after the step deadline cannot trigger another Stop or report",async()=>{
  const f=fixture({verifyStopped:async()=>({verified:false})});try{
    f.begin();await f.recovery.advance("work");f.sample(NOW+11_000);
    assert.equal((await f.recovery.advance("work")).reason,"RECOVERY_STEP_TIMEOUT");
    assert.equal(f.stops(),1);assert.equal(f.reports(),0);
  }finally{f.store.close();}
});

test("late ACK cannot resurrect an UNKNOWN intent set by another controller",async()=>{
  let release;
  const f=fixture({stop:intent=>new Promise(resolve=>{release=()=>resolve({...intent,outcome:"clicked"});})});
  try{f.begin();const pending=f.recovery.advance("work");
    const other=new DisconnectRecovery(f.store,{state:f.state,context:()=>f.ctx,stop:async()=>{throw Error("NO_REPLAY");},
      requestReport:async()=>{},verifyStopped:async()=>{},verifyReport:async()=>{},now:()=>NOW});
    assert.equal(other.reconcile(),1);release();await pending;
    assert.equal(f.recovery.get("work").stage,"UNKNOWN");
  }finally{f.store.close();}
});

test("bounded episodes respect cooldown/cap and do not block unrelated workstreams",async()=>{
  const f=fixture();try{
    await f.reportAndVerify();await f.recovery.advance("work");
    f.sample(NOW+3500,{connectionWarning:true,assistantBusy:true,stopControlVerified:true});
    f.sample(NOW+4500,{connectionWarning:true,assistantBusy:true,stopControlVerified:true});
    assert.equal(f.begin(),null);f.clock(NOW+6000);assert.ok(f.begin());
    f.recovery.transition("work","DONE","TEST_COMPLETED");
    assert.equal(f.begin(),null);
    f.store.create({id:"other",name:"Other",projectKey:"project",repository:"owner/repo"},NOW);
    assert.equal(f.state.pending("other"),null);
  }finally{f.store.close();}
});

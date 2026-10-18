import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkstreamStore} from "../local/store.js";
import {AutopilotState} from "../local/autopilot-state.js";
import {inputs,observation,NOW} from "../test-support/autopilot-fixture.js";

function setup(path=":memory:"){
  const store=new WorkstreamStore(path); let now=NOW;
  if(!store.get("work"))store.create({id:"work",name:"Test",projectKey:"project",repository:"owner/repo",trackKey:"track"},NOW-5000);
  const state=new AutopilotState(store,{now:()=>now});
  const context=inputs();
  const ready=()=>{state.evaluate("work",observation({observedAt:NOW-1000}),context);return state.evaluate("work",observation(),context);};
  return {store,state,context,ready,clock:n=>{now=n;}};
}

test("observations, decisions and one intent are persisted before any executor side effect",()=>{
  const f=setup();try{
    const decision=f.ready(); assert.equal(decision.nextAction,"CONTINUE");
    const reservation=f.state.reserve("work",decision.actionFingerprint,f.context);
    assert.ok(reservation.operationId);assert.equal(f.state.reserve("work",decision.actionFingerprint,f.context),null);
    assert.equal(f.store.events().filter(e=>e.kind==="autopilot_intent").length,1);
    f.state.settle(reservation.operationId,"submitted","command-1");
    f.clock(NOW+1000);
    const repeated=f.state.evaluate("work",observation({observedAt:NOW+1000}),f.context);
    assert.equal(f.state.reserve("work",repeated.actionFingerprint,f.context),null);
    f.store.db.prepare("UPDATE workstreams SET task_revision=2 WHERE id='work'").run();
    f.context.scope.taskRevision=2;f.clock(NOW+3000);
    f.state.evaluate("work",observation({observedAt:NOW+2000}),f.context);
    const renewed=f.state.evaluate("work",observation({observedAt:NOW+3000}),f.context);
    assert.equal(renewed.nextAction,"NO_ACTION");assert.equal(renewed.reasonCode,"RESPONSE_ALREADY_CONSUMED");
    assert.equal(f.state.reserve("work",renewed.actionFingerprint,f.context),null);
    assert.equal(f.store.get("work").state,"OBSERVING");
  }finally{f.store.close();}
});

test("reserve rechecks STOP, human wait, scope, freshness and stale action fingerprint",()=>{
  for(const mutate of [f=>f.store.setStopped(true,NOW),f=>f.store.db.prepare("UPDATE workstreams SET state='WAIT_HUMAN' WHERE id='work'").run(),
    f=>{f.context.scope.expiresAt=NOW;},f=>{f.context.scope.messageHash="d".repeat(64);},f=>f.clock(NOW+20_000)]){
    const f=setup();try{const decision=f.ready(); mutate(f);assert.equal(f.state.reserve("work",decision.actionFingerprint,f.context),null);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM autopilot_response_claims").get().n,0);}finally{f.store.close();}
  }
});

test("restart after intent reservation remains UNKNOWN and never replays",()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-state-")),path=join(dir,"state.sqlite3");
  let f;
  try{
    f=setup(path);const decision=f.ready();const reservation=f.state.reserve("work",decision.actionFingerprint,f.context);
    f.store.close();f=setup(path);
    assert.equal(f.state.reconcile(),1);assert.equal(f.state.reconcile(),0);
    assert.equal(f.state.pending("work").status,"unknown");
    assert.equal(f.state.reserve("work",decision.actionFingerprint,f.context),null);
    assert.throws(()=>f.state.settle(reservation.operationId,"submitted","late-ack"),/ALREADY_SETTLED/);
  }finally{f?.store.close();rmSync(dir,{recursive:true,force:true});}
});

test("two SQLite handles compete for one response reservation",()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-compete-")),path=join(dir,"state.sqlite3");
  const a=setup(path),b=setup(path);
  try{const decision=a.ready();assert.ok(a.state.reserve("work",decision.actionFingerprint,a.context));
    assert.equal(b.state.reserve("work",decision.actionFingerprint,b.context),null);
  }finally{a.store.close();b.store.close();rmSync(dir,{recursive:true,force:true});}
});

test("raw IPC fields do not reach SQLite/events and older snapshots cannot replace latest",()=>{
  const f=setup();try{
    const input={...observation(),rawText:"PRIVATE_BODY",url:"https://private.invalid",reasonCode:"PRIVATE_ERROR"};
    f.state.evaluate("work",input,f.context);
    assert.doesNotMatch(f.state.latest("work").snapshot,/PRIVATE_|https:/);
    assert.equal(f.state.evaluate("work",observation({observedAt:NOW-1}),f.context).reasonCode,"NON_MONOTONIC_OBSERVATION");
    assert.equal(f.state.latest("work").observed_at,NOW);
    assert.doesNotMatch(JSON.stringify(f.store.events()),/PRIVATE_|https:/);
  }finally{f.store.close();}
});

test("unknown existing chat command blocks a new response even after approval renewal",()=>{
  const f=setup();try{
    f.store.db.exec("CREATE TABLE chat_continuation_commands(id TEXT,workstream_id TEXT,state TEXT)");
    f.store.db.prepare("INSERT INTO chat_continuation_commands VALUES('old','work','unknown')").run();
    assert.equal(f.ready().reasonCode,"UNRECONCILED_OPERATION");
  }finally{f.store.close();}
});

test("workstream isolation and additive tables preserve old workstreams and enrollment",()=>{
  const f=setup();try{
    f.store.create({id:"other",name:"Other",projectKey:"project",repository:"owner/repo"},NOW);
    const before=f.store.get("other");const decision=f.ready();f.state.reserve("work",decision.actionFingerprint,f.context);
    assert.throws(()=>f.store.deleteWorkstream("work","Test",NOW),/AUTOPILOT_IN_FLIGHT/);
    assert.deepEqual(f.store.get("other"),before);assert.equal(f.state.pending("other"),null);
    assert.equal(f.state.latest("other"),null);
    assert.equal(f.store.deleteWorkstream("other","Other",NOW).deleted,true);
    assert.ok(f.state.latest("work"));
  }finally{f.store.close();}
});

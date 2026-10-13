import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkstreamStore } from "../local/store.js";
import { ExecutionLoop } from "../local/execution-loop.js";
import {
  DeterministicMockAdapter, executionRequest, expectedMockProof,
  verifyMockResult
} from "../local/execution-adapter.js";

function setup(options={}){
  const directory=mkdtempSync(join(tmpdir(),"autopilot-executor-"));
  const path=join(directory,"plans.sqlite3");
  let store=new WorkstreamStore(path),now=100_000;
  store.create({id:"build",name:"Builder",projectKey:"build",repository:"owner/repo"},1000);
  store.configure("build",{mode:"simulation"},1000);
  store.arm("build",1000);
  const wt={targets:{list:()=>options.bound?[{workstreamId:"build"}]:[]}};
  const gh={targets:{list:()=>[]}};
  const gate={one:()=>({decision:options.reviewed?"REVIEWED":"UNKNOWN"})};
  const make=(adapter=options.adapter)=>new ExecutionLoop(store,{
    gate,watchtower:wt,github:gh,now:()=>now,...(adapter?{adapter}:{})
  });
  let loop=make();
  return {
    get store(){return store},get loop(){return loop},
    wt,gh,gate,make,setClock:at=>{now=at},
    reopen(){
      store.close();store=new WorkstreamStore(path);
      loop=make();
      return {store,loop};
    },
    close(){store.close();rmSync(directory,{recursive:true,force:true});}
  };
}
function create(loop){
  return loop.create({workstreamId:"build",title:"Single approved mock phase",
    instruction:"Produce a simulated, verifiable proof without external side effects",
    expectedMarker:"SIMULATED_PASS"});
}

test("adapter contract separates accept from inspected proof",async()=>{
  const x=setup();
  try{
    const plan=create(x.loop);
    const op={operationId:"operation-1",workstreamId:"build",taskRevision:1};
    const request=executionRequest(x.store.get("build"),x.loop.raw(plan.id),op);
    const adapter=new DeterministicMockAdapter();
    const receipt=await adapter.submit(request);
    assert.equal(receipt.accepted,true);
    const evidence=await adapter.inspect(receipt,request);
    assert.equal(verifyMockResult(request,receipt,evidence).verified,true);
    assert.equal(evidence.proof,expectedMockProof(request));
    assert.equal(verifyMockResult(request,receipt,{...evidence,proof:"fake"}).verified,false);
    assert.equal(verifyMockResult(request,{...receipt,operationId:"wrong"},evidence).verified,false);
  }finally{x.close()}
});

test("unready workstream, invalid scope and unauthorized adapter are rejected",()=>{
  const x=setup();
  try{
    assert.throws(()=>new ExecutionLoop(x.store,{
      gate:x.gate,watchtower:x.wt,github:x.gh,
      adapter:{id:"chatgpt-ui",capabilities:{contractVersion:1,sideEffects:true}}
    }),/no-side-effect/);
    assert.throws(()=>x.loop.create({workstreamId:"build",title:"T",instruction:"I",expectedMarker:"x"}),/INVALID/);
    x.store.configure("build",{paused:true},100000);
    assert.throws(()=>create(x.loop),/PAUSED/);
    x.store.configure("build",{paused:false,mode:"observe"},100001);
    assert.throws(()=>create(x.loop),/NOT_READY/);
  }finally{x.close()}
});

test("approval is separate from plan creation, and accepted is never completed",async()=>{
  const x=setup();
  try{
    const plan=create(x.loop);
    assert.equal(plan.status,"draft");
    await assert.rejects(x.loop.dispatch(plan.id),/PLAN_APPROVAL/);
    const approval=x.loop.approve(plan.id);
    assert.equal(approval.status,"approved");
    assert.equal(x.store.get("build").state,"READY");
    const sent=await x.loop.dispatch(plan.id);
    assert.equal(sent.status,"waiting");
    assert.equal(sent.operationId!==null,true);
    assert.equal(sent.verifiedSimulation,false);
    assert.equal(sent.phaseComplete,false);
    assert.equal(x.store.get("build").state,"WAIT_EXTERNAL");
    assert.equal(x.store.operations()[0].status,"accepted");
    const verified=await x.loop.inspect(plan.id);
    assert.equal(verified.status,"verified");
    assert.equal(verified.resultReason,"SIMULATED_PROOF_VERIFIED");
    assert.equal(verified.verifiedSimulation,true);
    assert.equal(verified.phaseComplete,false);
    assert.equal(x.store.get("build").state,"COMPLETE");
    assert.equal(x.store.operations()[0].status,"completed");
  }finally{x.close()}
});

test("same task revision cannot be double planned, approved or submitted",async()=>{
  const x=setup();
  try{
    const plan=create(x.loop);
    assert.throws(()=>create(x.loop),/ALREADY_PLANNED/);
    x.loop.approve(plan.id);
    assert.throws(()=>x.loop.approve(plan.id),/APPROVAL_NOT_ALLOWED/);
    await x.loop.dispatch(plan.id);
    await assert.rejects(x.loop.dispatch(plan.id),/APPROVAL_MISSING/);
    assert.equal(x.store.operations().length,1);
    assert.equal(x.loop.hasAny("build"),true);
  }finally{x.close()}
});

test("approval expires before any side-effect even if task is still READY",async()=>{
  const x=setup();
  try{
    const plan=create(x.loop);
    x.loop.approve(plan.id);
    x.setClock(100_000+10*60_000+1);
    await assert.rejects(x.loop.dispatch(plan.id),/APPROVAL_MISSING_OR_EXPIRED/);
    assert.equal(x.store.operations().length,0);
  }finally{x.close()}
});

test("global stop, individual pause and changed task revision forbid dispatch",async()=>{
  const x=setup();
  try{
    const p=create(x.loop);
    x.loop.approve(p.id);
    x.store.setStopped(true,100_100);
    await assert.rejects(x.loop.dispatch(p.id),/GLOBAL_STOP/);
    x.store.setStopped(false,100_101);
    x.store.configure("build",{paused:true},100_102);
    await assert.rejects(x.loop.dispatch(p.id),/PAUSED/);
    x.store.configure("build",{paused:false},100_103);
    x.store.db.prepare("UPDATE workstreams SET task_revision=2 WHERE id='build'").run();
    await assert.rejects(x.loop.dispatch(p.id),/TASK_REVISION_CHANGED/);
    assert.equal(x.store.operations().length,0);
  }finally{x.close()}
});

test("CI-bound workstream cannot be planned or executed unless decision gate is reviewed",async()=>{
  const x=setup({bound:true});
  try{
    assert.throws(()=>create(x.loop),/CI_PR_EVIDENCE_REQUIRES_REVIEW/);
  }finally{x.close()}
  const y=setup({bound:true,reviewed:true});
  try{
    const plan=create(y.loop);
    y.loop.approve(plan.id);
    assert.equal((await y.loop.dispatch(plan.id)).status,"waiting");
  }finally{y.close()}
});

test("adapter remains pending until independent inspection returns a proof",async()=>{
  class LateMock extends DeterministicMockAdapter {
    constructor(){super();this.polls=0;}
    async inspect(receipt,request){
      this.polls++;
      if(this.polls===1)return {...await super.inspect(receipt,request),status:"pending"};
      return super.inspect(receipt,request);
    }
  }
  const mock=new LateMock(),x=setup({adapter:mock});
  try{
    const p=create(x.loop);x.loop.approve(p.id);
    await x.loop.dispatch(p.id);
    const first=await x.loop.inspect(p.id);
    assert.equal(first.status,"waiting");
    assert.equal(x.store.get("build").state,"WAIT_EXTERNAL");
    assert.equal((await x.loop.inspect(p.id)).status,"verified");
    assert.equal(mock.polls,2);
  }finally{x.close()}
});

test("failed mock result blocks workstream; cannot be rewritten as verified",async()=>{
  const x=setup({adapter:new DeterministicMockAdapter({outcome:"failed"})});
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    assert.equal((await x.loop.inspect(p.id)).status,"failed");
    assert.equal(x.store.get("build").state,"BLOCKED");
    await assert.rejects(x.loop.inspect(p.id),/NO_INSPECTABLE_RECEIPT/);
  }finally{x.close()}
});

test("forged result with correct receipt but false proof fails verification",async()=>{
  class Forged extends DeterministicMockAdapter {
    async inspect(receipt,request){
      return {...await super.inspect(receipt,request),proof:"forged"};
    }
  }
  const x=setup({adapter:new Forged()});
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    const result=await x.loop.inspect(p.id);
    assert.equal(result.status,"failed");
    assert.equal(result.resultReason,"MOCK_PROOF_NOT_VERIFIED");
    assert.equal(x.store.get("build").state,"BLOCKED");
  }finally{x.close()}
});

test("unknown submit acknowledgement is not retried and requires reconciliation",async()=>{
  class LostAck extends DeterministicMockAdapter{
    constructor(){super();this.calls=0;}
    async submit(request){this.calls++;await super.submit(request);throw Error("lost network acknowledgement");}
  }
  const adapter=new LostAck(),x=setup({adapter});
  try{
    const p=create(x.loop);x.loop.approve(p.id);
    const result=await x.loop.dispatch(p.id);
    assert.equal(result.status,"unknown");
    assert.equal(result.resultReason,"SUBMIT_OUTCOME_AMBIGUOUS_NO_RETRY");
    assert.equal(x.store.get("build").state,"UNKNOWN");
    await assert.rejects(x.loop.dispatch(p.id),/APPROVAL/);
    assert.equal(adapter.calls,1);
    assert.equal(x.store.operations().length,1);
  }finally{x.close()}
});

test("inspection failures cannot claim completion or trigger a resend",async()=>{
  class LostInspection extends DeterministicMockAdapter{
    async inspect(){throw Error("unreachable external service");}
  }
  const x=setup({adapter:new LostInspection()});
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    assert.equal((await x.loop.inspect(p.id)).status,"unknown");
    assert.equal(x.store.get("build").state,"UNKNOWN");
    assert.equal(x.store.operations().length,1);
  }finally{x.close()}
});

test("accepted receipts survive clean process restart and can be inspected without re-submit",async()=>{
  const x=setup();
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    const reopened=x.reopen();
    assert.equal(reopened.loop.reconcileOnStartup(),0);
    assert.equal(reopened.store.get("build").state,"WAIT_EXTERNAL");
    assert.equal((await reopened.loop.inspect(p.id)).status,"verified");
    assert.equal(reopened.store.operations().length,1);
  }finally{x.close()}
});

test("crash during a reserved dispatch transitions to UNKNOWN without automatic resend",()=>{
  const x=setup();
  try{
    const p=create(x.loop);x.loop.approve(p.id);
    const operation=x.store.claimDue("build",100_100);
    x.store.db.prepare(
      "UPDATE execution_plans SET status='running',operation_id=? WHERE id=?"
    ).run(operation.operationId,p.id);
    const reopened=x.reopen();
    assert.equal(reopened.store.recoverInFlight(200_000),1);
    assert.equal(reopened.loop.reconcileOnStartup(),1);
    assert.equal(reopened.loop.snapshot(p.id).status,"unknown");
    assert.equal(reopened.store.get("build").state,"UNKNOWN");
    assert.equal(reopened.store.operations().length,1);
    const abandoned=reopened.loop.abandon(p.id);
    assert.equal(abandoned.status,"unknown");
    assert.equal(reopened.store.get("build").active_operation_id,null);
    assert.equal(reopened.store.operations()[0].status,"abandoned");
  }finally{x.close()}
});

test("approved revisions can be completed once, and new revisions require new plans",async()=>{
  const x=setup();
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    await x.loop.inspect(p.id);
    x.store.arm("build",101_000);
    assert.equal(x.store.get("build").task_revision,2);
    const next=create(x.loop);
    assert.notEqual(next.fingerprint,p.fingerprint);
    assert.equal(next.taskRevision,2);
    assert.equal(next.status,"draft");
    assert.equal(x.store.operations().length,1);
  }finally{x.close()}
});

test("operator abandonment keeps an accepted receipt UNKNOWN, never claims finished",async()=>{
  const x=setup();
  try{
    const p=create(x.loop);x.loop.approve(p.id);await x.loop.dispatch(p.id);
    const r=x.loop.abandon(p.id);
    assert.equal(r.status,"unknown");
    assert.equal(x.store.operations()[0].status,"abandoned");
    assert.equal(x.store.get("build").state,"UNKNOWN");
    await assert.rejects(x.loop.inspect(p.id),/NO_INSPECTABLE_RECEIPT/);
  }finally{x.close()}
});

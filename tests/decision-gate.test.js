import test from "node:test";
import assert from "node:assert/strict";
import { WorkstreamStore } from "../local/store.js";
import { LocalScheduler } from "../local/scheduler.js";
import { decideGate, DecisionGate, GITHUB_MAX_AGE_MS, WATCHTOWER_MAX_AGE_MS } from "../local/decision-gate.js";

const HEAD = "a".repeat(40);
const NOW = 1_000_000;
const workstream = (override = {}) => ({
  id:"build",project_key:"build",repository:"owner/repo",
  track_key:"ops",enabled:true,paused:false,state:"OBSERVING",
  task_revision:1,active_operation_id:null,...override
});
const watchTarget = override => ({
  workstreamId:"build",repositoryId:8,runId:1001,attempt:2,
  headSha:HEAD,configuredAt:NOW-2_000,...override
});
const githubTarget = override => ({
  workstreamId:"build",prNumber:21,headSha:HEAD,configuredAt:NOW-2_000,...override
});
const watchResult = override => ({
  workstreamId:"build",repositoryId:8,repository:"owner/repo",workTrackKey:"ops",responsibilityKind:"project-wide",runId:1001,attempt:2,headSha:HEAD,
  ciState:"SUCCESS",evidenceState:"FRESH",decision:"VERIFY_GITHUB",
  reason:"CI_SUCCESS_REQUIRES_PR_CHECKS_AND_APPROVALS",
  safeToAdvance:false,...override
});
const githubResult = override => ({
  workstreamId:"build",repository:"owner/repo",prNumber:21,headSha:HEAD,
  checks:[{name:"CI",state:"SUCCESS"}],
  state:"MERGED_CONFIRMED",merged:true,requiredChecksVerified:true,
  reason:"REQUIRED_CHECKS_PASSED",safeToAdvance:false,...override
});
function inputs(opts={}){
  return {
    workstream:workstream(opts.workstream),globalStopped:opts.globalStopped===true,
    now:opts.now??NOW,review:opts.review??null,
    watchtower:{
      status:"connected",contractVersion:"1.0",checkedAt:NOW-900,
      errorCode:null,targets:[watchTarget()],results:[watchResult()],
      ...opts.watchtower
    },
    github:{
      status:"observed",checkedAt:NOW-500,errorCode:null,
      targets:[githubTarget()],results:[githubResult()],...opts.github
    }
  };
}
test("exact fresh CI plus verified merged GitHub PR still requires a human phase review",()=>{
  const result=decideGate(inputs());
  assert.equal(result.decision,"WAIT_HUMAN");
  assert.equal(result.reason,"PHASE_ACCEPTANCE_REQUIRES_HUMAN_REVIEW");
  assert.match(result.evidenceHash,/^[a-f0-9]{64}$/);
  assert.equal(result.executionAllowed,false);
  assert.equal(result.phaseComplete,false);
  assert.equal(result.operatorReviewed,false);
});
test("global emergency stop and per-workstream pause dominate even verified evidence",()=>{
  assert.equal(decideGate(inputs({globalStopped:true})).reason,"GLOBAL_EMERGENCY_STOP");
  assert.equal(decideGate(inputs({workstream:{paused:true}})).decision,"PAUSED");
  assert.equal(decideGate(inputs({workstream:{enabled:false}})).decision,"PAUSED");
});
test("ongoing or failed local work cannot be revived by a cached GitHub success",()=>{
  for(const state of ["RUNNING","WAIT_EXTERNAL","WAIT_HUMAN"]){
    const result=decideGate(inputs({workstream:{state,active_operation_id:"old-op"}}));
    assert.equal(result.decision,"WAIT_EXTERNAL");
  }
  for(const state of ["BLOCKED","UNKNOWN"]){
    assert.equal(decideGate(inputs({workstream:{state}})).decision,"BLOCKED");
  }
  assert.equal(decideGate(inputs({workstream:{state:"COMPLETE"}})).decision,"COMPLETE");
});
test("missing binding, wrong sha, or unavailable source is UNKNOWN and blocks",()=>{
  const cases=[
    inputs({watchtower:{targets:[]}}),
    inputs({github:{targets:[]}}),
    inputs({github:{targets:[githubTarget({headSha:"b".repeat(40)})]}}),
    inputs({watchtower:{status:"unavailable"}}),
    inputs({github:{status:"not_checked"}}),
    inputs({watchtower:{contractVersion:"2.0"}})
  ];
  for(const fixture of cases){
    const result=decideGate(fixture);
    assert.equal(result.decision,"UNKNOWN");
    assert.equal(result.executionAllowed,false);
  }
});
test("stale observations, observations older than changed binding, future clocks block",()=>{
  const cases=[
    inputs({now:NOW+WATCHTOWER_MAX_AGE_MS+2_000}),
    inputs({github:{checkedAt:NOW-GITHUB_MAX_AGE_MS-1}}),
    inputs({watchtower:{checkedAt:NOW-5_000,targets:[watchTarget({configuredAt:NOW-4_000})]}}),
    inputs({github:{checkedAt:NOW-5_000,targets:[githubTarget({configuredAt:NOW-3_000})]}}),
    inputs({watchtower:{checkedAt:NOW+10_000}}),
    inputs({github:{checkedAt:null}})
  ];
  for(const fixture of cases){
    assert.equal(decideGate(fixture).reason,"OBSERVATION_STALE_OR_PRECEDES_BINDING");
  }
});
test("duplicate, missing or cross-target results cannot qualify as authoritative",()=>{
  const cases=[
    inputs({watchtower:{results:[]}}),
    inputs({github:{results:[]}}),
    inputs({watchtower:{results:[watchResult(),watchResult()]}}),
    inputs({watchtower:{results:[watchResult({runId:222})]}}),
    inputs({github:{results:[githubResult({headSha:"b".repeat(40)})]}}),
    inputs({github:{results:[githubResult({safeToAdvance:true})]}})
  ];
  for(const fixture of cases)assert.equal(decideGate(fixture).decision,"UNKNOWN");
});
test("another Repository or Work Track cannot inherit a successful CI/PR decision",()=>{
  for(const change of [
    {watchtower:{results:[watchResult({repositoryId:99})]}},
    {watchtower:{results:[watchResult({repository:"other/repo"})]}},
    {watchtower:{results:[watchResult({workTrackKey:"frontend"})]}},
    {github:{results:[githubResult({repository:"other/repo"})]}}
  ]){
    assert.equal(decideGate(inputs(change)).reason,"REPOSITORY_OR_TRACK_EVIDENCE_MISMATCH");
  }
});
test("materially changed required-check evidence invalidates operator review fingerprint",()=>{
  const x=setup();
  try{
    assert.equal(x.gate.review("build").decision,"REVIEWED");
    x.g.results=[githubResult({checks:[{name:"CI",state:"SUCCESS"},{name:"lint",state:"SUCCESS"}]})];
    assert.equal(x.gate.one("build").decision,"WAIT_HUMAN");
    assert.equal(x.gate.one("build").operatorReviewed,false);
  }finally{x.close()}
});

test("queued, running, failed, stale, or conflicting CI vetoes merged GitHub green",()=>{
  for(const decision of ["WAIT_EXTERNAL","BLOCKED","UNKNOWN"]){
    const result=decideGate(inputs({watchtower:{
      results:[watchResult({decision,ciState:decision==="WAIT_EXTERNAL"?"QUEUED":"FAILURE"})]
    }}));
    assert.equal(result.decision,decision);
    assert.equal(result.executionAllowed,false);
  }
});
test("unmerged PR waits, failure blocks, unknown required checks stays unknown",()=>{
  assert.equal(decideGate(inputs({github:{results:[githubResult({
    state:"CHECKS_PASSED_NOT_MERGED",merged:false
  })]}})).reason,"PR_NOT_MERGED");
  assert.equal(decideGate(inputs({github:{results:[githubResult({
    state:"FAILURE",merged:false,requiredChecksVerified:false
  })]}})).decision,"BLOCKED");
  assert.equal(decideGate(inputs({github:{results:[githubResult({
    state:"UNKNOWN",merged:false,requiredChecksVerified:false
  })]}})).decision,"UNKNOWN");
});
function setup(){
  const store=new WorkstreamStore();
  store.create({id:"build",name:"Build",projectKey:"build",repository:"owner/repo",trackKey:"ops"},1000);
  let now=NOW;
  const w={...inputs().watchtower},g={...inputs().github};
  const wt={current:()=>w,targets:{list:()=>w.targets}};
  const gh={current:()=>g,targets:{list:()=>g.targets}};
  const gate=new DecisionGate(store,{watchtower:wt,github:gh,now:()=>now});
  return {store,w,g,gate,setNow:value=>{now=value},close:()=>store.close()};
}
test("operator review is explicitly recorded and bound to exact evidence, not permission to execute",()=>{
  const x=setup();
  try{
    assert.equal(x.gate.one("build").decision,"WAIT_HUMAN");
    const review=x.gate.review("build");
    assert.equal(review.decision,"REVIEWED");
    assert.equal(review.operatorReviewed,true);
    assert.equal(review.executionAllowed,false);
    assert.equal(review.phaseComplete,false);
    assert.equal(x.store.events()[0].kind,"decision_gate_review");
    x.setNow(NOW+16*60_000);
    assert.equal(x.gate.one("build").decision,"UNKNOWN"); // source snapshots must refresh before review expiry
  }finally{x.close()}
});
test("review cannot bypass paused, unverified or ambiguous evidence",()=>{
  const x=setup();
  try{
    x.store.configure("build",{paused:true},NOW);
    assert.throws(()=>x.gate.review("build"),/검증/);
    x.store.configure("build",{paused:false},NOW);
    x.g.results=[githubResult({state:"UNKNOWN",requiredChecksVerified:false})];
    assert.throws(()=>x.gate.review("build"),/검증/);
  }finally{x.close()}
});
test("new task revision or new evidence target invalidates prior operator review",()=>{
  const x=setup();
  try{
    x.gate.review("build");
    x.store.arm("build",NOW); // initial arm preserves revision
    assert.equal(x.gate.one("build").decision,"REVIEWED");
    // A changed Run attempt must not be satisfied by prior manual review.
    x.w.targets=[watchTarget({attempt:3})];
    x.w.results=[watchResult({attempt:3})];
    assert.equal(x.gate.one("build").decision,"WAIT_HUMAN");
    // Restoring older target does not make the changed review authorize execution.
    x.w.targets=[watchTarget({attempt:2})];
    x.w.results=[watchResult()];
    assert.equal(x.gate.one("build").decision,"REVIEWED");
    // Task revision changes always invalidate earlier review.
    x.store.db.prepare("UPDATE workstreams SET task_revision=2 WHERE id='build'").run();
    assert.equal(x.gate.one("build").decision,"WAIT_HUMAN");
  }finally{x.close()}
});
test("gate audit logs only transitions and records repeated states after an intervening change",()=>{
  const x=setup();
  try{
    x.gate.recordCurrent();
    x.gate.recordCurrent();
    assert.equal(x.gate.recentHistory().length,1);
    x.w.status="unavailable";
    x.gate.recordCurrent();
    assert.equal(x.gate.recentHistory().length,2);
    x.w.status="connected";
    x.gate.recordCurrent();
    assert.equal(x.gate.recentHistory().length,3);
    assert.equal(x.gate.recentHistory()[0].decision,"WAIT_HUMAN");
  }finally{x.close()}
});
test("gate only restricts mock scheduler, never claims external execution",async()=>{
  const x=setup();
  try{
    x.store.configure("build",{mode:"simulation"},NOW);
    x.store.arm("build",NOW);
    const scheduler=new LocalScheduler(x.store,{
      now:()=>NOW,
      authorizeClaim:item=>x.gate.one(item.id).decision==="REVIEWED"
    });
    assert.deepEqual(await scheduler.tick(),[]);
    assert.equal(x.store.operations().length,0);
    x.gate.review("build");
    const results=await scheduler.tick();
    assert.equal(results[0].kind,"simulated-dispatch");
    assert.equal(x.store.operations().length,1);
    assert.equal(x.gate.one("build").decision,"WAIT_EXTERNAL");
    assert.deepEqual(await scheduler.tick(),[]);
  }finally{x.close()}
});

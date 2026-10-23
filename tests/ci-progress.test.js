import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {projectChecks,assessCiProgress,CiProgressObserver} from "../local/ci-progress.js";

const NOW=1_800_000,SHA="a".repeat(40),ALT="b".repeat(40);
const stream=(id="saju")=>({id,repository:"owner/myeongha",project_key:"myeongha",
  track_key:id,task_revision:1});
const target=(id="saju",headSha=SHA)=>({workstreamId:id,prNumber:2495,headSha,configuredAt:NOW-50000});
const runTarget=(id="saju",headSha=SHA)=>({workstreamId:id,repositoryId:42,runId:90,
  attempt:2,headSha,configuredAt:NOW-50000});
const required=(name,state="SUCCESS")=>({name,state});
const observed=(name,state="SUCCESS",appId=15368,id=1)=>({name,state,appId,id});
function scene({id="saju",integrated=false,stage="preflight",wtPatch={},ghPatch={},targetPatch={},
  checks=[required("CI Verify"),required("Governance Verify")],items=[
    observed("CI Verify"),observed("Governance Verify","SUCCESS",15368,2)]}={}){
  const ghTarget={...target(id),...targetPatch};
  const wtTarget=runTarget(id);
  return {workstream:stream(id),stage,now:NOW,
    watchtower:{status:"connected",contractVersion:"1.0",checkedAt:NOW-1000,
      targets:[wtTarget],results:[{workstreamId:id,repository:"owner/myeongha",
        repositoryId:42,runId:90,attempt:2,headSha:SHA,workTrackKey:id,
        ciState:"SUCCESS",evidenceState:"FRESH",decision:"VERIFY_GITHUB",safeToAdvance:false,
        ...wtPatch}]},
    github:{status:"observed",checkedAt:NOW-1000,
      targets:[ghTarget],results:[{workstreamId:id,repository:"owner/myeongha",
        headSha:SHA,prNumber:2495,runVerified:true,runId:90,attempt:2,runCiState:"SUCCESS",
        state:"CHECKS_PASSED_NOT_MERGED",checks,observedChecks:items,
        checkCoverageComplete:true,safeToAdvance:false,...ghPatch}]}
  };
}

test("preflight GREEN is advisory, never a merge or roadmap authorization",()=>{
  const result=assessCiProgress(scene());
  assert.equal(result.state,"GREEN");
  assert.equal(result.action,"VERIFY_MERGE_AND_APPROVAL");
  assert.equal(result.integrationState,"NOT_REQUESTED");
  assert.equal(result.safeToAdvance,false);
  assert.equal(result.verified,true);
  assert.match(result.evidenceHash,/^[a-f0-9]{64}$/);
});
test("integration work can share the general CI workflow without borrowing ordinary GREEN",()=>{
  const items=[observed("CI Verify"),observed("CI Integration Verify","PENDING",15368,3)];
  const pending=assessCiProgress(scene({stage:"integration",items}));
  assert.equal(pending.ordinaryState,"GREEN");
  assert.equal(pending.integrationState,"PENDING");
  assert.equal(pending.state,"PENDING");
  assert.equal(pending.action,"WAIT_CI");
  const passed=assessCiProgress(scene({stage:"integration",items:[
    items[0],{...items[1],state:"SUCCESS"}]}));
  assert.equal(passed.state,"GREEN");
  const failed=assessCiProgress(scene({stage:"integration",items:[
    items[0],{...items[1],state:"FAILURE"}]}));
  assert.equal(failed.state,"RED");
  assert.equal(failed.action,"REPAIR_REVIEW");
});
test("a triggered integration failure vetoes ordinary GREEN even before stage selection",()=>{
  const result=assessCiProgress(scene({items:[observed("CI Verify"),
    observed("CI Integration Verify","FAILURE",15368,4)]}));
  assert.equal(result.state,"RED");
  assert.equal(result.integrationRequired,true);
  assert.equal(result.action,"REPAIR_REVIEW");
});
test("integration never passes when it is required but has not started",()=>{
  const result=assessCiProgress(scene({stage:"integration"}));
  assert.equal(result.state,"PENDING");
  assert.equal(result.integrationState,"NOT_STARTED");
  assert.equal(result.safeToAdvance,false);
});
test("integration check required by ruleset cannot be skipped even in preflight stage",()=>{
  const result=assessCiProgress(scene({checks:[
    required("CI Verify"),required("CI Integration Verify")]}));
  assert.equal(result.integrationRequired,true);
  assert.equal(result.state,"PENDING");
});
test("Saju 16-shard checks can be required without a MyeongHa integration context",()=>{
  const checks=[required("CI Verify"),...Array.from({length:16},(_,i)=>required("CI Tests ("+(i+1)+"/16)"))];
  const result=assessCiProgress(scene({id:"saju-engine",checks}));
  assert.equal(result.state,"GREEN");
  assert.equal(result.integrationState,"NOT_REQUESTED");
  assert.equal(result.ordinaryChecks.length,17);
});
test("each CI scope is bound to its own repository, PR, SHA, attempt and work track",()=>{
  const bad=[
    {...scene(),workstream:stream("other")},
    scene({targetPatch:{headSha:ALT}}),
    scene({wtPatch:{attempt:3}}),
    scene({wtPatch:{workTrackKey:"chat"}}),
    scene({ghPatch:{prNumber:2496}}),
    scene({ghPatch:{runId:91}}),
    scene({ghPatch:{runCiState:"RUNNING"}}),
    scene({ghPatch:{headSha:ALT}}),
    scene({wtPatch:{repository:"owner/saju"}})
  ];
  for(const args of bad)assert.equal(assessCiProgress(args).state,"UNKNOWN");
});
test("old, duplicated, missing or incomplete observations never become GREEN",()=>{
  const cases=[
    {...scene(),github:{...scene().github,checkedAt:NOW-300000}},
    {...scene(),watchtower:{...scene().watchtower,status:"unavailable"}},
    {...scene(),watchtower:{...scene().watchtower,checkedAt:NOW-100000}},
    {...scene(),github:{...scene().github,results:[]}},
    {...scene(),github:{...scene().github,results:[...scene().github.results,...scene().github.results]}},
    scene({ghPatch:{checkCoverageComplete:false}}),
    scene({ghPatch:{state:"UNKNOWN"}}),
    scene({wtPatch:{evidenceState:"STALE"}}),
    {...scene(),watchtower:{...scene().watchtower,targets:[]}}
  ];
  for(const args of cases)assert.equal(assessCiProgress(args).state,"UNKNOWN");
});
test("a failed watched Run cannot be promoted by unrelated required green checks",()=>{
  const result=assessCiProgress(scene({wtPatch:{decision:"BLOCKED",ciState:"FAILURE"},
    ghPatch:{runCiState:"FAILURE"}}));
  assert.equal(result.state,"UNKNOWN");
  assert.equal(result.reason,"WATCHTOWER_RUN_NOT_SUCCESSFUL");
});
test("ordinary errors result in RED, pending in PENDING, cancelled not in SUCCESS",()=>{
  for(const [state,expected] of [["FAILURE","RED"],["PENDING","PENDING"],
    ["UNKNOWN","UNKNOWN"],["CANCELLED","UNKNOWN"]]){
    const s=scene({checks:[required("CI Verify",state)]});
    assert.equal(assessCiProgress(s).state,expected);
  }
});
test("a missing required-check set is not an implicit all-green result",()=>{
  const result=assessCiProgress(scene({checks:[]}));
  assert.equal(result.state,"UNKNOWN");
});
test("check projection rejects truncated, malformed or ambiguous entries",()=>{
  assert.equal(projectChecks({total_count:3,check_runs:[]}).complete,false);
  assert.equal(projectChecks({total_count:1,check_runs:[{id:1,name:"CI"}]}).complete,false);
  const p=projectChecks({total_count:3,check_runs:[
    {id:1,name:"CI",app:{id:5},status:"completed",conclusion:"failure"},
    {id:2,name:"CI",app:{id:5},status:"completed",conclusion:"success"},
    {id:3,name:"CI",app:{id:6},status:"in_progress",conclusion:null}]});
  assert.equal(p.complete,true);
  assert.equal(p.checks.length,2);
  assert.deepEqual(p.checks.map(x=>x.state).sort(),["PENDING","SUCCESS"]);
});
test("stage targets are isolated, persistent and do not modify approvals or stop siblings",()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"saju",name:"Saju",projectKey:"myeongha",repository:"owner/myeongha"},NOW);
    store.create({id:"chat",name:"Chat",projectKey:"myeongha",repository:"owner/myeongha"},NOW);
    const observer=new CiProgressObserver(store,{watchtower:{current:()=>scene().watchtower},
      github:{current:()=>scene().github},now:()=>NOW});
    assert.equal(observer.targets.get("saju").stage,"preflight");
    observer.targets.set("saju",{stage:"integration",integrationCheck:"CI Integration Verify"},NOW);
    assert.equal(observer.targets.get("saju").stage,"integration");
    assert.equal(observer.targets.get("chat").stage,"preflight");
    assert.equal(store.get("saju").paused,false);
    assert.equal(store.get("chat").paused,false);
    assert.throws(()=>observer.targets.set("chat",{stage:"merge"}),/INVALID_CI_STAGE/);
    assert.throws(()=>observer.targets.set("chat",{stage:"integration",integrationCheck:"x\nHeader"}),/INVALID_CI_STAGE/);
    const observedSnapshot=observer.current();
    assert.equal(observedSnapshot.results.length,2);
    assert.equal(observedSnapshot.targets.length,2);
  } finally {store.close();}
});

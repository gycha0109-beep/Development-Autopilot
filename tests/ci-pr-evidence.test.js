import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {assessPrRun,CiPrEvidenceObserver} from "../local/ci-pr-evidence.js";
import {CiProgressObserver} from "../local/ci-progress.js";

const NOW=Date.parse("2026-10-23T06:00:00.000Z");
const HEAD="a".repeat(40),RUN_SHA="b".repeat(40),OLD_SHA="c".repeat(40);
const target={repository:"owner/myeongha",repositoryId:5,prNumber:2499,headSha:HEAD};
const run=(patch={})=>({ciKind:"integration",workflowPath:".github/workflows/ci-integration.yml",
  runId:777,repository:target.repository,repositoryId:target.repositoryId,prNumber:target.prNumber,
  integrationCandidateHeadSha:HEAD,headSha:RUN_SHA,runAttempt:2,latestKnownAttempt:2,
  integrationCandidateBaseSha:null,integrationBaselineVerified:false,
  workTrackKey:"saju-engine",workTrackActive:true,attributionConflict:false,
  prIdentityConflict:false,prIdentitySource:"github_and_integration_title",ciKindSource:"workflow_path",
  ciState:"SUCCESS",decisionState:"SUCCESS",evidenceState:"FRESH",
  targetVerified:true,safeToAdvance:false,repositoryEnabled:true,
  observedAt:new Date(NOW-1000).toISOString(),createdAt:new Date(NOW-15000).toISOString(),
  ...patch});
const general=(patch={})=>run({ciKind:"general",workflowPath:".github/workflows/ci.yml",
  runId:555,headSha:HEAD,integrationCandidateHeadSha:null,
  createdAt:new Date(NOW-12000).toISOString(),...patch});

test("integration workflow Run SHA and PR candidate SHA are distinct, with no guessed baseline",()=>{
  const result=assessPrRun(run(),target,NOW);
  assert.equal(result.state,"UNKNOWN");
  assert.equal(result.reason,"INTEGRATION_BASELINE_UNVERIFIED");
  assert.equal(result.runSha,RUN_SHA);
  assert.equal(result.candidateSha,HEAD);
  assert.equal(result.integrationBaselineVerified,false);
  assert.equal(result.safeToAdvance,false);
});
test("verified exact integration run can be queued, failed or complete but not auto-authorize",()=>{
  assert.equal(assessPrRun(run({ciState:"RUNNING",decisionState:"RUNNING"}),target,NOW).state,"PENDING");
  assert.equal(assessPrRun(run({ciState:"FAILURE",decisionState:"FAILURE"}),target,NOW).state,"RED");
  assert.equal(assessPrRun(run({integrationBaselineVerified:true,integrationCandidateBaseSha:OLD_SHA}),
    target,NOW).state,"GREEN");
});
test("PR candidate mismatch, wrong identity, old attempts and stale observations fail closed",()=>{
  for(const bad of [
    {prNumber:2498},{repository:"owner/saju"},{repositoryId:7},
    {integrationCandidateHeadSha:OLD_SHA},{prIdentityConflict:true},
    {targetVerified:false},{latestKnownAttempt:3},{safeToAdvance:true},
    {evidenceState:"STALE"},{decisionState:"CONFLICT"},
    {observedAt:"garbage"},{observedAt:new Date(NOW-100000).toISOString()}
  ])assert.equal(assessPrRun(run(bad),target,NOW).state,"UNKNOWN");
  assert.equal(assessPrRun(general({headSha:OLD_SHA}),target,NOW).state,"UNKNOWN");
});
function fixture({runs=[general(),run()],mutate=null,legacy=false}={}){
  const store=new WorkstreamStore();
  store.create({id:"saju-engine",name:"Saju Engine",projectKey:"myeongha",repository:target.repository,
    trackKey:"saju-engine"},NOW-200000);
  const wtTarget={workstreamId:"saju-engine",repositoryId:5,runId:555,attempt:2,
    headSha:HEAD,configuredAt:NOW-90000};
  const ghTarget={workstreamId:"saju-engine",prNumber:2499,headSha:HEAD,configuredAt:NOW-90000};
  const calls=[];
  const client={
    async runs(args){calls.push({method:"runs",...args});return{completeCoverage:false,runs:legacy?
      runs.map(x=>({runId:x.runId,headSha:x.headSha})):runs};},
    async run(args){calls.push({method:"run",...args});
      const match=runs.find(x=>x.runId===args.runId);
      return mutate?mutate(match,args):match;
    }
  };
  const watchtower={client,current:()=>({status:"connected",contractVersion:"1.0",
    checkedAt:NOW-1000,targets:[wtTarget],
    results:[{workstreamId:"saju-engine",repository:target.repository,repositoryId:5,
      runId:555,headSha:HEAD,attempt:2,workTrackKey:"saju-engine",safeToAdvance:false,
      decision:"VERIFY_GITHUB",ciState:"SUCCESS",evidenceState:"FRESH"}]})};
  const github={current:()=>({status:"observed",checkedAt:NOW-1000,targets:[ghTarget],
    results:[{workstreamId:"saju-engine",repository:target.repository,
      prNumber:2499,headSha:HEAD,runVerified:true,runId:555,attempt:2,
      runCiState:"SUCCESS",state:"CHECKS_PASSED_NOT_MERGED",
      checks:[{name:"CI Verify",state:"SUCCESS"}],
      observedChecks:[{name:"CI Verify",state:"SUCCESS"}],
      checkCoverageComplete:true,safeToAdvance:false}]})};
  return {store,watchtower,github,calls};
}
test("PR-scoped observer queries exact repository/PR and verifies the integration run with RUN SHA",async()=>{
  const f=fixture();try{
    const observer=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const evidence=await observer.refresh();
    assert.equal(evidence.results.length,1);
    assert.equal(evidence.results[0].status,"observed");
    assert.deepEqual(evidence.results[0].runs.map(x=>x.kind).sort(),["general","integration"]);
    assert.equal(evidence.results[0].runs.find(x=>x.kind==="integration").state,"UNKNOWN");
    assert.ok(f.calls.some(x=>x.method==="runs"&&x.prNumber===2499&&x.repositoryId===5));
    assert.ok(f.calls.some(x=>x.method==="run"&&x.runId===777&&x.headSha===RUN_SHA&&
      x.prNumber===2499&&x.attempt===2));
  }finally{f.store.close();}
});
test("new integration Run evidence overrules an old same-SHA ordinary green",async()=>{
  const f=fixture();try{
    const observer=new CiProgressObserver(f.store,{watchtower:f.watchtower,github:f.github,now:()=>NOW});
    await observer.refreshPrEvidence();
    const result=observer.current().results[0];
    assert.equal(result.integrationRequired,true);
    assert.equal(result.integrationState,"UNKNOWN");
    assert.equal(result.state,"UNKNOWN");
    assert.equal(result.reason,"INTEGRATION_BASELINE_UNVERIFIED");
    assert.equal(result.safeToAdvance,false);
    assert.equal(result.observedIntegrationRun.runSha,RUN_SHA);
  }finally{f.store.close();}
});
test("an actual linked integration failure is RED even when the PR's normal checks were GREEN",async()=>{
  const f=fixture({runs:[general(),run({ciState:"FAILURE",decisionState:"FAILURE"})]});
  try{
    const observer=new CiProgressObserver(f.store,{watchtower:f.watchtower,github:f.github,now:()=>NOW});
    await observer.refreshPrEvidence();
    const result=observer.current().results[0];
    assert.equal(result.state,"RED");
    assert.equal(result.reason,"INTEGRATION_CI_FAILED");
    assert.equal(result.observedIntegrationRun.runId,777);
  }finally{f.store.close();}
});
test("a PR association supplied by a legacy bridge is never silently treated as verified",async()=>{
  const f=fixture({legacy:true});try{
    const observer=new CiProgressObserver(f.store,{watchtower:f.watchtower,github:f.github,now:()=>NOW});
    observer.targets.set("saju-engine",{stage:"integration"},NOW-2000);
    await observer.refreshPrEvidence();
    const snapshot=observer.current();
    assert.equal(snapshot.prEvidence.results[0].status,"unknown");
    assert.equal(snapshot.prEvidence.results[0].reason,"PR_SCOPED_BRIDGE_UNSUPPORTED");
    assert.equal(snapshot.results[0].state,"UNKNOWN");
  }finally{f.store.close();}
});
test("a project-wide integration Run may have no Work Track, but a conflicting Track is rejected",async()=>{
  const noTrack=fixture({runs:[general(),run({workTrackKey:null})]});
  try{
    const observer=new CiPrEvidenceObserver({...noTrack,now:()=>NOW});
    const snapshot=await observer.refresh();
    assert.equal(snapshot.results[0].runs.find(x=>x.kind==="integration").reason,
      "INTEGRATION_BASELINE_UNVERIFIED");
  }finally{noTrack.store.close();}
  const conflicting=fixture({runs:[general(),run({workTrackKey:"other"})]});
  try{
    const observer=new CiPrEvidenceObserver({...conflicting,now:()=>NOW});
    const snapshot=await observer.refresh();
    assert.equal(snapshot.results[0].runs.find(x=>x.kind==="integration").reason,
      "WORK_TRACK_MISMATCH");
  }finally{conflicting.store.close();}
});
test("a run changed between list and exact lookup is UNKNOWN, not an older green",async()=>{
  const f=fixture({mutate:(item,args)=>args.runId===777?{...item,runAttempt:3}:item});
  try{
    const observer=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const evidence=await observer.refresh();
    const integration=evidence.results[0].runs.find(r=>r.kind==="integration");
    assert.equal(integration.state,"UNKNOWN");
    assert.equal(integration.reason,"RUN_CHANGED_BETWEEN_READS");
  }finally{f.store.close();}
});
test("a different candidate SHA between list and exact PR lookup is UNKNOWN",async()=>{
  const f=fixture({mutate:(item,args)=>args.runId===777?
    {...item,integrationCandidateHeadSha:OLD_SHA}:item});
  try{
    const observer=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const snapshot=await observer.refresh();
    assert.equal(snapshot.results[0].runs.find(x=>x.kind==="integration").reason,
      "RUN_CHANGED_BETWEEN_READS");
  }finally{f.store.close();}
});
test("no observed integration Run means NOT_OBSERVED rather than GREEN when stage needs it",async()=>{
  const f=fixture({runs:[general()]});try{
    const observer=new CiProgressObserver(f.store,{watchtower:f.watchtower,github:f.github,now:()=>NOW});
    observer.targets.set("saju-engine",{stage:"integration"},NOW-2000);
    await observer.refreshPrEvidence();
    const result=observer.current().results[0];
    assert.equal(result.state,"PENDING");
    assert.equal(result.reason,"INTEGRATION_RUN_NOT_OBSERVED");
  }finally{f.store.close();}
});

const ancillaryRun=(patch={})=>run({
  ciKind:"other",ciKindSource:"workflow_path",workflowId:93,
  workflowPath:".github/workflows/pie-prospective.yml",
  workflowName:"PIE Prospective Shadow",prIdentitySource:"github_pull_requests",
  integrationCandidateHeadSha:null,headSha:HEAD,runAttempt:1,latestKnownAttempt:1,
  runId:39906837903,createdAt:new Date(NOW-1000).toISOString(),
  historicalDisposition:"NOT_APPLICABLE",supersededByRunId:null,
  conclusion:"success",...patch
});
const cancelledPie=()=>ancillaryRun({
  runId:39906779844,createdAt:new Date(NOW-20000).toISOString(),
  ciState:"OTHER_TERMINAL",decisionState:"OTHER_TERMINAL",
  conclusion:"cancelled",historicalDisposition:"SUPERSEDED",
  supersededByRunId:39906837903
});
test("Saju-like cancelled PIE history is superseded by a newer exact-SHA PIE, without auto-advance",async()=>{
  const f=fixture({runs:[general(),cancelledPie(),ancillaryRun()]});
  try{
    const observer=new CiProgressObserver(f.store,
      {watchtower:f.watchtower,github:f.github,now:()=>NOW});
    await observer.refreshPrEvidence();
    const snapshot=observer.current();
    const item=snapshot.prEvidence.results[0];
    assert.equal(item.ancillary.length,1);
    const pie=item.ancillary[0];
    assert.equal(pie.workflowName,"PIE Prospective Shadow");
    assert.equal(pie.state,"GREEN");
    assert.equal(pie.runId,39906837903);
    assert.equal(pie.supersededCount,1);
    assert.equal(pie.lineageState,"SUPERSEDED");
    assert.deepEqual(pie.supersededRunIds,[39906779844]);
    assert.equal(pie.safeToAdvance,false);
    assert.equal(snapshot.results[0].state,"GREEN"); // ordinary CI, independent of PIE
    assert.equal(snapshot.results[0].safeToAdvance,false);
    assert.ok(f.calls.some(x=>x.method==="run"&&x.runId===39906837903&&
      x.headSha===HEAD&&x.prNumber===2499));
  }finally{f.store.close();}
});
test("a newer cancelled PIE never borrows an older successful Run",async()=>{
  const cancelledNew=ancillaryRun({runId:39906837903,conclusion:"cancelled",
    ciState:"OTHER_TERMINAL",decisionState:"OTHER_TERMINAL",
    historicalDisposition:"UNRESOLVED"});
  const oldGreen=ancillaryRun({runId:39906779844,
    createdAt:new Date(NOW-20000).toISOString()});
  const f=fixture({runs:[general(),oldGreen,cancelledNew]});
  try{
    const obs=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const e=await obs.refresh();
    assert.equal(e.results[0].ancillary[0].state,"UNKNOWN");
    assert.equal(e.results[0].ancillary[0].supersededCount,0);
  }finally{f.store.close();}
});
test("cross PR or candidate SHA cannot substitute for the current cancelled PIE",async()=>{
  const candidates=[
    ancillaryRun({prNumber:2500}),ancillaryRun({headSha:OLD_SHA}),
    ancillaryRun({workflowId:94,workflowPath:".github/workflows/other.yml"})
  ];
  const f=fixture({runs:[general(),cancelledPie(),...candidates]});
  try{
    const obs=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const e=await obs.refresh();
    assert.equal(e.results[0].ancillary.length,1);
    assert.equal(e.results[0].ancillary[0].runId,39906779844);
    assert.equal(e.results[0].ancillary[0].state,"UNKNOWN");
  }finally{f.store.close();}
});
test("old bridge without historical annotations cannot report proven PIE supersession",async()=>{
  const withoutMetadata=cancelledPie();
  delete withoutMetadata.historicalDisposition;
  delete withoutMetadata.supersededByRunId;
  const f=fixture({runs:[general(),withoutMetadata,ancillaryRun()]});
  try{
    const obs=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const e=await obs.refresh();
    assert.equal(e.results[0].ancillary[0].state,"GREEN");
    assert.equal(e.results[0].ancillary[0].lineageState,"UNVERIFIED");
    assert.equal(e.results[0].ancillary[0].supersededCount,0);
    assert.equal(e.results[0].ancillary[0].safeToAdvance,false);
  }finally{f.store.close();}
});
test("a PIE whose latest Run changes between list and exact read is UNKNOWN",async()=>{
  const f=fixture({runs:[general(),cancelledPie(),ancillaryRun()],
    mutate:(item,args)=>args.runId===39906837903?{...item,runAttempt:3}:item});
  try{
    const obs=new CiPrEvidenceObserver({...f,now:()=>NOW});
    const e=await obs.refresh();
    assert.equal(e.results[0].ancillary[0].state,"UNKNOWN");
    assert.equal(e.results[0].ancillary[0].reason,"RUN_CHANGED_BETWEEN_READS");
    assert.equal(e.results[0].ancillary[0].safeToAdvance,false);
  }finally{f.store.close();}
});

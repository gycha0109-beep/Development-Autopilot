import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {decideGate,DecisionGate} from "../local/decision-gate.js";
import {ciResumeCandidates,ciFollowupStatus} from "../local/ci-resume.js";

const HEAD="a".repeat(40),NOW=2000000;
const stream={id:"ci",repository:"owner/repo",project_key:"build",
  track_key:"ops",enabled:true,paused:false,state:"OBSERVING",
  task_revision:1,active_operation_id:null};
const target={workstreamId:"ci",repositoryId:2,runId:193,attempt:2,
  headSha:HEAD,configuredAt:NOW-4000};
const gtarget={workstreamId:"ci",prNumber:42,headSha:HEAD,configuredAt:NOW-4000};
const ci={workstreamId:"ci",source:"github_actions_direct",repository:"owner/repo",
  runId:193,attempt:2,headSha:HEAD,prNumber:42,ciState:"SUCCESS",
  decision:"VERIFY_GITHUB",safeToAdvance:false,observedAt:new Date(NOW-1000).toISOString()};
const gh={workstreamId:"ci",repository:"owner/repo",prNumber:42,headSha:HEAD,
  checks:[{name:"CI",state:"SUCCESS"}],state:"MERGED_CONFIRMED",merged:true,
  requiredChecksVerified:true,safeToAdvance:false};
const fixture=(overrides={})=>({
  workstream:{...stream,...overrides.workstream},now:overrides.now??NOW,
  globalStopped:overrides.globalStopped??false,review:overrides.review??null,
  watchtower:{status:"unavailable",targets:[{...target}],results:[],
    ...(overrides.watchtower||{})},
  directCore:{status:"observed",checkedAt:NOW-900,errorCode:null,
    results:[{...ci}],...(overrides.directCore||{})},
  github:{status:"observed",checkedAt:NOW-800,errorCode:null,
    targets:[{...gtarget}],results:[{...gh}],...(overrides.github||{})}
});
test("headless gate needs no WatchTower process and still requires human approval",()=>{
  const x=decideGate(fixture());
  assert.equal(x.decision,"WAIT_HUMAN");
  assert.equal(x.source,"headless_github_actions");
  assert.equal(x.executionAllowed,false);
  assert.match(x.evidenceHash,/^[a-f0-9]{64}$/);
});
test("headless gate fails closed for wrong attempt, SHA, stale and incomplete evidence",()=>{
  const tests=[
    fixture({directCore:{results:[{...ci,attempt:1}]}}),
    fixture({directCore:{results:[{...ci,headSha:"b".repeat(40)}]}}),
    fixture({directCore:{results:[{...ci,source:"untrusted"}]}}),
    fixture({directCore:{checkedAt:NOW-95000}}),
    fixture({directCore:{results:[{...ci,decision:"UNKNOWN"}]}}),
    fixture({github:{results:[{...gh,state:"UNKNOWN",requiredChecksVerified:false}]}}),
    fixture({github:{results:[{...gh,state:"MERGED_CONFIRMED",checks:[{name:"CI",state:"UNKNOWN"}]}]}}),
    fixture({github:{targets:[{...gtarget,headSha:"b".repeat(40)}]}}),
    fixture({github:{status:"unavailable"}})
  ];
  for(const x of tests)assert.equal(decideGate(x).decision,"UNKNOWN");
});
test("headless failure blocks; queued waits; merge waits; global stop always wins",()=>{
  assert.equal(decideGate(fixture({directCore:{results:[{...ci,decision:"BLOCKED",ciState:"FAILURE"}]}})).decision,"BLOCKED");
  assert.equal(decideGate(fixture({directCore:{results:[{...ci,decision:"WAIT_EXTERNAL",ciState:"RUNNING"}]}})).decision,"WAIT_EXTERNAL");
  assert.equal(decideGate(fixture({github:{results:[{...gh,state:"CHECKS_PASSED_NOT_MERGED",merged:false}]}})).decision,"WAIT_EXTERNAL");
  assert.equal(decideGate(fixture({globalStopped:true})).reason,"GLOBAL_EMERGENCY_STOP");
});
test("headless approval is bound to exact evidence and never authorizes direct execution",()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"ci",name:"CI",projectKey:"build",repository:"owner/repo",trackKey:"ops"},100);
    let stopped=false;
    const x=fixture();
    const watchtower={current:()=>x.watchtower,targets:{list:()=>x.watchtower.targets}};
    const directCore={current:()=>x.directCore};
    const github={current:()=>x.github,targets:{list:()=>x.github.targets}};
    const originalIsStopped=store.isStopped.bind(store);
    store.isStopped=()=>stopped;
    const gate=new DecisionGate(store,{watchtower,directCore,github,now:()=>NOW});
    assert.equal(gate.one("ci").decision,"WAIT_HUMAN");
    const approved=gate.review("ci");
    assert.equal(approved.decision,"REVIEWED");
    assert.equal(approved.executionAllowed,false);
    assert.equal(ciResumeCandidates({store,watchtower,directCore,github,gate,now:NOW}).length,1);
    assert.equal(ciFollowupStatus({workstreamId:"ci",watchtower,directCore,github,gate}).action,"APPROVED_RESUME");
    x.directCore.results=[{...ci,attempt:3}];
    assert.equal(gate.one("ci").decision,"UNKNOWN");
    assert.equal(ciResumeCandidates({store,watchtower,directCore,github,gate,now:NOW}).length,0);
    x.directCore.results=[{...ci}];
    stopped=true;
    assert.equal(gate.one("ci").decision,"PAUSED");
    assert.equal(ciResumeCandidates({store,watchtower,directCore,github,gate,now:NOW}).length,0);
    store.isStopped=originalIsStopped;
  }finally{store.close();}
});

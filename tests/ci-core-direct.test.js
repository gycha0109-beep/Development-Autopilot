import test from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
const MOCK_EXE=resolve("ci-core-inspect.exe");
import {CoreDirectClient,CoreDirectObserver,CoreDirectError,decideDirectCore} from "../local/ci-core-direct.js";

const H="a".repeat(40);
const target={workstreamId:"w1",repository:"owner/repo",prNumber:7,headSha:H,
  runId:11,attempt:2};
function observation(overrides={}){
  return {
    source:"github_actions_direct",observedAt:new Date().toISOString(),
    repository:target.repository,prNumber:target.prNumber,expectedHeadSha:H,
    currentPrHeadSha:H,runId:11,runAttempt:2,workflowPath:".github/workflows/ci.yml",
    ciKind:"general",workflowRunHeadSha:H,integrationBaselineVerified:false,
    prIdentitySource:"github_pull_requests",targetIdentityState:"MATCH",
    targetVerified:true,status:"completed",conclusion:"success",
    ciState:"SUCCESS",decisionState:"SUCCESS",requiredChecksVerified:false,
    completeCoverage:false,safeToAdvance:false,...overrides
  };
}
test("successful exact run is only independent Github verification, never approval",()=>{
  const result=decideDirectCore(observation(),target);
  assert.equal(result.decision,"VERIFY_GITHUB");
  assert.equal(result.safeToAdvance,false);
  assert.equal(result.ciState,"SUCCESS");
});
test("head, attempt, repository and source mismatch fail closed",()=>{
  for(const invalid of [
    {currentPrHeadSha:"b".repeat(40)},
    {runAttempt:3},
    {repository:"wrong/repo"},
    {targetIdentityState:"PR_HEAD_OR_REPOSITORY_MISMATCH"},
    {targetVerified:false},
    {prIdentitySource:"integration_title_candidate_only"},
    {workflowRunHeadSha:"b".repeat(40)},
    {safeToAdvance:true},
    {completeCoverage:true},
    {requiredChecksVerified:true},
    {observedAt:new Date(Date.now()-180000).toISOString()},
    {decisionState:"UNKNOWN"}
  ]){
    assert.equal(decideDirectCore(observation(invalid),target).decision,"UNKNOWN",
      JSON.stringify(invalid));
  }
});
test("integration success remains unknown even with matching candidate title",()=>{
  assert.equal(decideDirectCore(observation({ciKind:"integration",
    prIdentitySource:"integration_title_candidate_only"}),target).decision,"UNKNOWN");
  assert.equal(decideDirectCore(observation({ciKind:"integration"}),target).decision,"UNKNOWN");
});
test("queued and failed observations do not promote success",()=>{
  const queued=decideDirectCore(observation({ciState:"QUEUED",decisionState:"QUEUED"}),target);
  assert.equal(queued.decision,"WAIT_EXTERNAL");
  assert.equal(queued.safeToAdvance,false);
  const failed=decideDirectCore(observation({ciState:"FAILURE",decisionState:"FAILURE"}),target);
  assert.equal(failed.decision,"BLOCKED");
  assert.equal(failed.safeToAdvance,false);
});
test("client constructs argument-vector only and rejects malformed arguments before launching",async()=>{
  const calls=[];
  const client=new CoreDirectClient({platform:"win32",binaryPath:MOCK_EXE,
    exec:async(path,args,options)=>{
      calls.push({path,args,options});
      return {stdout:JSON.stringify({contractVersion:"ci-core-inspect/0.1",data:observation()})};
    }});
  assert.equal(client.configured,true);
  const data=await client.inspect(target);
  assert.equal(data.runId,11);
  assert.deepEqual(calls[0].args,["--repository","owner/repo","--pr","7",
    "--head-sha",H,"--run-id","11","--attempt","2"]);
  assert.equal(calls[0].options.shell,false);
  assert.equal(calls[0].options.windowsHide,true);
  await assert.rejects(client.inspect({...target,repository:"owner/repo;echo"}),error=>error.code==="INVALID_TARGET");
  assert.equal(calls.length,1);
});
test("safe rate-limit and authorization codes survive child-process failure",async()=>{
  for(const code of ["GITHUB_UNAUTHORIZED","GITHUB_FORBIDDEN","GITHUB_RATE_LIMITED",
    "GITHUB_THROTTLED","GITHUB_NOT_FOUND","GITHUB_TRANSPORT_UNAVAILABLE",
    "GITHUB_RESPONSE_INVALID"]){
    const client=new CoreDirectClient({platform:"win32",binaryPath:MOCK_EXE,
      exec:async()=>{const e=new Error("Never expose stderr or credential content");
        e.stdout=JSON.stringify({contractVersion:"ci-core-inspect/0.1",error:{code}});
        e.stderr="sensitive-material";throw e;}});
    await assert.rejects(client.inspect(target),error=>error.code===code&&
      !error.message.includes("sensitive"));
  }
});
test("missing client, missing token, CLI failure and malformed payload are sanitized",async()=>{
  let client=new CoreDirectClient({platform:"linux",binaryPath:"/tmp/ci-core-inspect.exe",
    exec:async()=>{throw Error("never")}});
  await assert.rejects(client.inspect(target),error=>error.code==="CORE_NOT_CONFIGURED");
  client=new CoreDirectClient({platform:"win32",binaryPath:MOCK_EXE,
    exec:async()=>{const error=new Error("secret must not surface");error.stdout=JSON.stringify({
      contractVersion:"ci-core-inspect/0.1",error:{code:"CREDENTIAL_UNAVAILABLE"}
    });throw error;}});
  await assert.rejects(client.inspect(target),error=>error.code==="CREDENTIAL_UNAVAILABLE"&&
    !error.message.includes("secret"));
  client=new CoreDirectClient({platform:"win32",binaryPath:MOCK_EXE,
    exec:async()=>({stdout:"not json"})});
  await assert.rejects(client.inspect(target),error=>error.code==="CORE_INVALID_RESPONSE");
});
function fakeDeps(n=1){
  const workstreams=Array.from({length:n},(_,i)=>({id:"w"+i,repository:"owner/repo"}));
  const wt=workstreams.map((x,i)=>({workstreamId:x.id,headSha:H,runId:11+i,
    attempt:2,repositoryId:1}));
  const gh=workstreams.map(x=>({workstreamId:x.id,headSha:H,prNumber:7}));
  return {store:{list:()=>workstreams},watchtower:{targets:{list:()=>wt}},
    github:{targets:{list:()=>gh}},wt,gh};
}
test("direct observer works with Watchtower bridge offline, but remains advisory",async()=>{
  const {store,watchtower,github}=fakeDeps(1);
  let calls=0;
  const client={configured:true,inspect:async(t)=>{calls++;return observation({runId:t.runId})}};
  const observer=new CoreDirectObserver(store,{watchtower,github,client});
  const first=await observer.refresh();
  assert.equal(first.status,"observed");
  assert.equal(first.results[0].decision,"VERIFY_GITHUB");
  assert.equal(first.safeToAdvance,false);
  await observer.refresh();
  assert.equal(calls,1);
});
test("missing targets and different SHA do not launch inspector",async()=>{
  const {store,watchtower,github,wt,gh}=fakeDeps(1);
  gh[0].headSha="b".repeat(40);
  let calls=0;
  const observer=new CoreDirectObserver(store,{watchtower,github,
    client:{configured:true,inspect:async()=>{calls++;return observation();}}});
  const snap=await observer.refresh();
  assert.equal(snap.results[0].reason,"DIRECT_TARGET_BINDING_MISMATCH");
  assert.equal(calls,0);
});
test("GitHub 403 and throttling stop further API calls until cooldown expires",async()=>{
  const {store,watchtower,github}=fakeDeps(3);
  let now=Date.now(),calls=0;
  const client={configured:true,inspect:async()=>{calls++;
    throw new CoreDirectError("GITHUB_RATE_LIMITED");}};
  const observer=new CoreDirectObserver(store,{watchtower,github,client,now:()=>now});
  let snapshot=await observer.refresh();
  assert.equal(calls,1);
  assert.equal(snapshot.rateBudget.attempted,1);
  assert.equal(snapshot.results[0].reason,"GITHUB_RATE_LIMITED");
  assert.equal(snapshot.results[1].reason,"DIRECT_AUTH_BACKOFF");
  assert.ok(snapshot.authBackoffUntil>now);
  snapshot=await observer.refresh({force:true});
  assert.equal(calls,1);
  now+=15*60_000+1;
  snapshot=await observer.refresh({force:true});
  assert.equal(calls,2);
  assert.equal(snapshot.safeToAdvance,false);
});
test("20 monitored sessions use bounded rotating GitHub API budget",async()=>{
  const {store,watchtower,github}=fakeDeps(20);
  let calls=0;
  const client={configured:true,inspect:async(t)=>{calls++;return observation({runId:t.runId});}};
  const observer=new CoreDirectObserver(store,{watchtower,github,client});
  const a=await observer.refresh();
  assert.equal(a.rateBudget.attempted,8);
  assert.equal(a.results.filter(x=>x.reason==="DIRECT_RATE_BUDGET").length,12);
  const b=await observer.refresh({force:true});
  assert.equal(b.rateBudget.attempted,8);
  assert.equal(calls,16);
  assert.equal(b.safeToAdvance,false);
});

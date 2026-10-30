import test from "node:test";
import assert from "node:assert/strict";
import {
  WatchtowerClient,WatchtowerError,matchingRepository,decideWatchtowerRun
} from "../local/watchtower-client.js";
import { WorkstreamStore } from "../local/store.js";
import { WatchtowerObserver } from "../local/watchtower-observer.js";

const sha="a".repeat(40);
const observedAt=new Date(500_000).toISOString();
const repositoryId=12;
const target={repositoryId,repository:"owner/repo",trackKey:"ops",runId:77,headSha:sha,attempt:2};
const registry={
  projects:[{id:3,key:"project",name:"Project",active:true}],
  repositories:[{id:12,projectId:3,name:"owner/repo",enabled:true,
    lastSuccessfulPollAt:observedAt,pollErrorCode:null}],
  tracks:[{id:9,projectId:3,canonicalTrackKey:"ops",name:"Ops",active:true}]
};
function run(overrides={}){
  return {
    runId:77,repositoryId:12,repository:"owner/repo",repositoryEnabled:true,
    headSha:sha,runAttempt:2,latestKnownAttempt:2,
    targetVerified:true,safeToAdvance:false,workTrackKey:"ops",workTrackActive:true,
    evidenceState:"FRESH",ciState:"SUCCESS",decisionState:"SUCCESS",
    responsibilityKind:"project-wide",attributionConflict:false,observedAt,...overrides
  };
}
function response(data,status=200){
  return new Response(JSON.stringify(data),{
    status,headers:{"content-type":"application/json"}
  });
}

test("Watchtower client enforces authenticated v1 contract and exact run scope",async()=>{
  const calls=[];
  const client=new WatchtowerClient({
    getToken:async()=>"f".repeat(64),
    fetchImpl:async (url,opts)=>{
      calls.push({url,method:opts.method,authorization:opts.headers.Authorization,origin:opts.headers.Origin});
      const parsed=new URL(url);
      if(parsed.pathname==="/v1/health")return response({contractVersion:"1.0",
        data:{bridge:"connected",version:"1.0"}});
      if(parsed.pathname==="/v1/registry")return response({contractVersion:"1.0",data:registry});
      if(parsed.pathname==="/v1/runs/77"){
        assert.equal(parsed.searchParams.get("repository_id"),"12");
        assert.equal(parsed.searchParams.get("head_sha"),sha);
        assert.equal(parsed.searchParams.get("attempt"),"2");
        return response({contractVersion:"1.0",data:{run:run()}});
      }
      throw Error("unexpected");
    }
  });
  assert.equal((await client.health()).connected,true);
  assert.equal((await client.registry()).repositories.length,1);
  assert.equal((await client.run({repositoryId:12,runId:77,headSha:sha,attempt:2})).runId,77);
  assert.equal(calls.length,3);
  assert.equal(calls[0].method,"GET");
  assert.equal(calls[0].authorization,"Bearer "+"f".repeat(64));
  assert.equal(calls[0].origin,undefined);
  assert.match(calls[2].url,/127\.0\.0\.1:48765\/v1\/runs\/77/);
});

test("network failure, version drift, unauthorized and wrong SHA fail closed",async()=>{
  const mk=handler=>new WatchtowerClient({getToken:async()=>"f".repeat(64),fetchImpl:handler});
  await assert.rejects(mk(async()=>{throw Error("refused");}).health(),
    e=>e.code==="WATCHTOWER_UNAVAILABLE");
  await assert.rejects(mk(async()=>response({contractVersion:"2.0",data:{}})).health(),
    e=>e.code==="CONTRACT_MISMATCH");
  await assert.rejects(mk(async()=>response({contractVersion:"1.0",error:{code:"UNAUTHORIZED"}},401)).health(),
    e=>e.code==="UNAUTHORIZED");
  await assert.rejects(mk(async()=>response({contractVersion:"1.0",error:{code:"HEAD_SHA_MISMATCH"}},409))
    .run({repositoryId:12,runId:77,headSha:sha,attempt:2}),
    e=>e.code==="HEAD_SHA_MISMATCH");
});
test("token retrieval failures show only a safe error code, not credential contents",async()=>{
  const client=new WatchtowerClient({
    getToken:async()=>{throw Error("secret-do-not-show");},
    fetchImpl:()=>{throw Error("fetch must not run");}
  });
  await assert.rejects(client.health(),e=>
    e.code==="CREDENTIAL_UNAVAILABLE"&&!e.message.includes("secret-do-not-show"));
});
test("repository mapping requires exactly one enabled repo in expected project",()=>{
  assert.equal(matchingRepository(registry,"owner/repo","project").repository.id,12);
  assert.equal(matchingRepository(registry,"owner/repo","PROJECT").repository.id,12);
  assert.equal(matchingRepository(registry,"owner/other","project").reason,"REPOSITORY_NOT_REGISTERED");
  assert.equal(matchingRepository(registry,"owner/repo","wrong").matched,false);
  const duplicate={...registry,repositories:[...registry.repositories,{...registry.repositories[0],id:13}]};
  assert.equal(matchingRepository(duplicate,"owner/repo","project").reason,"AMBIGUOUS_REPOSITORY");
});
test("success NEVER directly authorizes advance; it requires independently verified GitHub",()=>{
  assert.deepEqual(decideWatchtowerRun(run(),target,500_000),{
    decision:"VERIFY_GITHUB",reason:"CI_SUCCESS_REQUIRES_PR_CHECKS_AND_APPROVALS",safeToAdvance:false
  });
});
test("queued and running exact runs wait, failed runs block, cancelled cannot advance",()=>{
  assert.equal(decideWatchtowerRun(run({ciState:"QUEUED",decisionState:"QUEUED"}),target,500_000).decision,"WAIT_EXTERNAL");
  assert.equal(decideWatchtowerRun(run({ciState:"RUNNING",decisionState:"RUNNING"}),target,500_000).decision,"WAIT_EXTERNAL");
  assert.equal(decideWatchtowerRun(run({ciState:"FAILURE",decisionState:"FAILURE"}),target,500_000).decision,"BLOCKED");
  assert.equal(decideWatchtowerRun(run({ciState:"OTHER_TERMINAL",decisionState:"OTHER_TERMINAL"}),target,500_000).decision,"BLOCKED");
});
test("stale, conflicting, wrong-Track, wrong-SHA and prior-attempt GREEN all fail closed",()=>{
  const cases=[
    [run({evidenceState:"STALE",decisionState:"STALE"}),"UNTRUSTED_EVIDENCE"],
    [run({evidenceState:"POLL_ERROR",decisionState:"POLL_ERROR"}),"UNTRUSTED_EVIDENCE"],
    [run({decisionState:"CONFLICT",attributionConflict:true}),"TRACK_CONFLICT"],
    [run({workTrackKey:"frontend"}),"WORK_TRACK_MISMATCH"],
    [run({runAttempt:1,latestKnownAttempt:2}),"HEAD_OR_ATTEMPT_UNVERIFIED"],
    [run({headSha:"b".repeat(40)}),"HEAD_OR_ATTEMPT_UNVERIFIED"],
    [run({runId:78}),"TARGET_IDENTITY_MISMATCH"],
    [run({safeToAdvance:true}),"BRIDGE_CONTRACT_VIOLATION"],
    [run({decisionState:"SUCCESS",ciState:"FAILURE"}),"INCONSISTENT_CI_STATE"],
    [run({pollErrorCode:"GITHUB_RATE_LIMIT"}),"POLL_ERROR"],
    [run({workTrackActive:false}),"INACTIVE_WORK_TRACK"],
    [run({observedAt:new Date(100).toISOString()}),"RESPONSE_OBSERVATION_STALE"]
  ];
  for(const [payload,expected] of cases){
    const decision=decideWatchtowerRun(payload,target,500_000);
    assert.equal(decision.reason,expected,JSON.stringify(payload));
    assert.equal(decision.safeToAdvance,false);
  }
});
test("observational registry + exact run is displayed without mutating scheduler workstream",async()=>{
  const store=new WorkstreamStore();
  try {
    store.create({id:"one",name:"Ops",projectKey:"project",repository:"owner/repo",trackKey:"ops"},1000);
    const observer=new WatchtowerObserver(store,{
      now:()=>500_000,
      client:{
        health:async()=>({connected:true,contractVersion:"1.0"}),
        registry:async()=>registry,
        run:async()=>run()
      }
    });
    observer.targets.set("one",{repositoryId:12,runId:77,headSha:sha,attempt:2},1001);
    const before=store.mustGet("one").state;
    const snapshot=await observer.refresh();
    assert.equal(snapshot.status,"connected");
    assert.equal(snapshot.results[0].decision,"VERIFY_GITHUB");
    assert.equal(store.get("one").state,before);
    assert.equal(store.operations().length,0);
  }finally { store.close(); }
});
test("missing track, mismatched registry, bridge unavailable return UNKNOWN without execution",async()=>{
  const store=new WorkstreamStore();
  try {
    store.create({id:"one",name:"Ops",projectKey:"project",repository:"owner/repo",trackKey:"ops"},1000);
    const observer=new WatchtowerObserver(store,{
      now:()=>500_000,
      client:{
        health:async()=>({connected:true,contractVersion:"1.0"}),
        registry:async()=>({...registry,tracks:[]}),
        run:async()=>{throw Error("should not call for missing Track");}
      }
    });
    observer.targets.set("one",{repositoryId:12,runId:77,headSha:sha,attempt:2},1001);
    assert.equal((await observer.refresh()).results[0].reason,"TRACK_NOT_REGISTERED_OR_INACTIVE");
    observer.client.health=async()=>{throw new WatchtowerError("WATCHTOWER_UNAVAILABLE");};
    const result=await observer.refresh();
    assert.equal(result.status,"unavailable");
    assert.equal(result.errorCode,"WATCHTOWER_UNAVAILABLE");
    assert.equal(result.results[0].decision,"UNKNOWN");
    assert.equal(store.operations().length,0);
  }finally{store.close();}
});
test("invalid target identifiers cannot be stored or guessed; explicit clear is audited",()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"one",name:"Ops",projectKey:"project",repository:"owner/repo"},1000);
    const observer=new WatchtowerObserver(store);
    for(const target of [
      {repositoryId:0,runId:7,headSha:sha,attempt:1},
      {repositoryId:12,runId:7,headSha:"short",attempt:1},
      {repositoryId:12,runId:7,headSha:sha,attempt:0}
    ]){
      assert.throws(()=>observer.targets.set("one",target,2000),/ID|SHA|Attempt/);
    }
    assert.equal(observer.targets.list().length,0);
    observer.targets.set("one",{repositoryId:12,runId:77,headSha:sha,attempt:2},2000);
    observer.targets.clear("one",3000);
    assert.equal(observer.targets.list().length,0);
    assert.equal(store.events()[0].kind,"watchtower_target_clear");
  }finally{store.close();}
});


test("a target configured while a Watchtower refresh is pending is rechecked before manual refresh returns",async()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"one",name:"Ops",projectKey:"project",repository:"owner/repo",trackKey:"ops"},1000);
    let resume;
    const barrier=new Promise(resolve=>{resume=resolve;});
    let healthCalls=0;
    const observer=new WatchtowerObserver(store,{
      now:()=>500_000,
      client:{
        health:async()=>{healthCalls++;await barrier;return {connected:true,contractVersion:"1.0"};},
        registry:async()=>registry,
        run:async()=>run()
      }
    });
    const startup=observer.refresh();
    observer.targets.set("one",{repositoryId:12,runId:77,headSha:sha,attempt:2},1001);
    const manual=observer.refresh();
    resume();
    await startup;
    const result=await manual;
    assert.equal(result.results.length,1);
    assert.equal(result.results[0].decision,"VERIFY_GITHUB");
    assert.equal(healthCalls,2);
    assert.equal(store.operations().length,0);
  }finally{store.close();}
});

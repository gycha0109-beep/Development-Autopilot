import test from "node:test";
import assert from "node:assert/strict";
import { WorkstreamStore } from "../local/store.js";
import { GitHubObserver } from "../local/github-observer.js";
import {
  GitHubVerifier,GitHubFactError,checkGitHubTarget,decideGitHubFacts,GitHubCLI
} from "../local/github-verifier.js";

const SHA="a".repeat(40);
const repository="owner/repo";
const target={repository,prNumber:18,headSha:SHA};
function pr({merged=false,sha=SHA,state=merged?"closed":"open",base="main"}={}){
  return {
    number:18,merged,state,head:{sha,repo:{full_name:repository}},
    base:{ref:base,repo:{full_name:repository}}
  };
}
const checks={total_count:1,check_runs:[
  {id:1,name:"CI",status:"completed",conclusion:"success",app:{id:7}}
]};
const statuses={statuses:[]};
const protection={contexts:["CI"],checks:[]};
function fake({pull=pr(),check=checks,protectionData=protection,ruleData=[]}={}){
  let calls=0;
  return {
    client:{
      get:async path=>{
        if(path.endsWith("/pulls/18")){calls++;return pull;}
        if(path.includes("/check-runs"))return check;
        if(path.endsWith("/status"))return statuses;
        if(path.includes("/required_status_checks"))return protectionData;
        if(path.includes("/rules/branches/"))return ruleData;
        throw Error("unexpected "+path);
      }
    },
    pullCalls:()=>calls
  };
}
test("GitHub read-only verifier validates exact SHA and required checks but never auto-authorizes",async()=>{
  const f=fake();
  const result=await new GitHubVerifier({client:f.client}).verify(target);
  assert.equal(result.state,"CHECKS_PASSED_NOT_MERGED");
  assert.equal(result.requiredChecksVerified,true);
  assert.equal(result.merged,false);
  assert.equal(result.safeToAdvance,false);
  assert.equal(f.pullCalls(),2);
});
test("merged PR is a verified fact, not a phase completion authorization",async()=>{
  const result=await new GitHubVerifier({client:fake({pull:pr({merged:true})}).client}).verify(target);
  assert.equal(result.state,"MERGED_CONFIRMED");
  assert.equal(result.merged,true);
  assert.equal(result.safeToAdvance,false);
});
test("a missing ruleset or branch protection cannot be interpreted as all checks passing",async()=>{
  const result=await new GitHubVerifier({client:fake({protectionData:null}).client}).verify(target);
  assert.equal(result.state,"UNKNOWN");
  assert.equal(result.reason,"REQUIRED_CHECKS_UNVERIFIED");
  assert.equal(result.requiredChecksVerified,false);
});
test("unpaginated or truncated check runs fail closed",async()=>{
  const result=await new GitHubVerifier({
    client:fake({check:{total_count:101,check_runs:[checks.check_runs[0]]}}).client
  }).verify(target);
  assert.equal(result.reason,"INCOMPLETE_CHECK_COVERAGE");
  assert.equal(result.safeToAdvance,false);
});
test("changed HEAD SHA or different PR cannot inherit older success",async()=>{
  const result=await new GitHubVerifier({client:fake({pull:pr({sha:"b".repeat(40)})}).client})
    .verify(target);
  assert.equal(result.reason,"PR_HEAD_SHA_DRIFT");
  assert.equal(result.safeToAdvance,false);
  assert.equal(result.requiredChecksVerified,false);
});
test("required failure blocks; queued required checks remain WAIT_EXTERNAL",()=>{
  const failed={total_count:1,check_runs:[
    {id:2,name:"CI",status:"completed",conclusion:"failure",app:{id:7}}
  ]};
  const pending={total_count:1,check_runs:[
    {id:3,name:"CI",status:"in_progress",conclusion:null,app:{id:7}}
  ]};
  assert.equal(decideGitHubFacts(target,pr(),pr(),failed,statuses,protection,[]).state,"FAILURE");
  assert.equal(decideGitHubFacts(target,pr(),pr(),pending,statuses,protection,[]).state,"WAIT_EXTERNAL");
});
test("multiple check providers sharing one required name are not silently interchanged",()=>{
  const ambiguous={total_count:2,check_runs:[
    {id:2,name:"CI",status:"completed",conclusion:"success",app:{id:7}},
    {id:3,name:"CI",status:"completed",conclusion:"success",app:{id:8}}
  ]};
  const result=decideGitHubFacts(target,pr(),pr(),ambiguous,statuses,protection,[]);
  assert.equal(result.reason,"AMBIGUOUS_CHECK_PROVIDERS");
  assert.equal(result.safeToAdvance,false);
});
test("branch changed between two PR reads causes fail-closed result",()=>{
  const b=pr(),a=pr({base:"develop"});
  assert.equal(decideGitHubFacts(target,b,a,checks,statuses,protection,[]).reason,
    "PR_CHANGED_DURING_VERIFICATION");
});
test("misformatted targets cannot trigger GitHub calls",async()=>{
  assert.throws(()=>checkGitHubTarget({repository:"bad",prNumber:1,headSha:SHA}),/Repository/);
  assert.throws(()=>checkGitHubTarget({repository,prNumber:-1,headSha:SHA}),/PR/);
  assert.throws(()=>checkGitHubTarget({repository,prNumber:1,headSha:"a"}),/SHA/);
});
test("CLI wrapper only issues read-only REST calls; stderr is never surfaced",async()=>{
  let args;
  const cli=new GitHubCLI({exec:async (_bin,a)=>{
    args=a;return {stdout:JSON.stringify({ok:true})};
  }});
  assert.deepEqual(await cli.get("/repos/owner/repo/pulls/18"),{ok:true});
  assert.ok(args.includes("GET"));
  assert.equal(args.includes("POST"),false);
  await assert.rejects(new GitHubCLI({exec:async()=>{throw Error("PAT secret");}})
    .get("/repos/owner/repo/pulls/18"),
    err=>err.code==="GITHUB_UNAVAILABLE"&&!err.message.includes("PAT secret"));
});
test("GitHub observer persists target and refuses Watchtower/GitHub Head SHA mismatch",async()=>{
  const store=new WorkstreamStore();
  try{
    store.create({id:"one",name:"Ops",projectKey:"ops",repository},1000);
    const watchtower={targets:{list:()=>[{workstreamId:"one",headSha:"b".repeat(40)}]}};
    let calls=0;
    const observer=new GitHubObserver(store,{
      watchtower,
      verifier:{verify:async()=>{calls++;return {state:"MERGED_CONFIRMED",safeToAdvance:false};}},
      now:()=>500000
    });
    observer.targets.set("one",18,SHA,2000);
    assert.equal(observer.targets.list().length,1);
    let snap=await observer.refresh();
    assert.equal(snap.results[0].reason,"WATCHTOWER_GITHUB_HEAD_MISMATCH");
    assert.equal(calls,0);
    assert.equal(store.operations().length,0);
    observer.targets.clear("one",3000);
    assert.equal(observer.targets.list().length,0);
  }finally{store.close();}
});

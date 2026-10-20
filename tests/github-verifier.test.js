import test from "node:test";
import assert from "node:assert/strict";
import { WorkstreamStore } from "../local/store.js";
import { GitHubObserver } from "../local/github-observer.js";
import {
  GitHubVerifier,GitHubFactError,checkGitHubTarget,decideGitHubFacts,GitHubCLI,verifyGitHubRun
} from "../local/github-verifier.js";

const SHA="a".repeat(40);
const repository="owner/repo";
const target={repository,prNumber:18,headSha:SHA};
const runTarget={...target,runId:77,attempt:2};
const workflowRun=patch=>({id:77,repository:{full_name:repository},head_sha:SHA,run_attempt:2,
  pull_requests:[{number:18,head:{sha:SHA}}],status:"completed",conclusion:"success",...patch});
function pr({merged=false,sha=SHA,state=merged?"closed":"open",base="main"}={}){
  return {
    number:18,merged,state,head:{sha,ref:"feature",repo:{full_name:repository}},
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

test("exact GitHub Run/Attempt is read twice and corroborated against the configured PR",async()=>{
  const f=fake({pull:pr({merged:true})});let reads=0;
  const client={get:async path=>path.endsWith("/actions/runs/77")?
    (reads++,workflowRun()):f.client.get(path)};
  const facts=await new GitHubVerifier({client}).verify(runTarget);
  assert.equal(reads,2);assert.equal(facts.runVerified,true);
  assert.equal(facts.runId,77);assert.equal(facts.attempt,2);assert.equal(facts.runCiState,"SUCCESS");
  assert.equal(facts.state,"MERGED_CONFIRMED");assert.equal(facts.safeToAdvance,false);
});

test("a green check cannot authorize an unrelated run, prior attempt or missing PR association",()=>{
  for(const patch of [{id:78},{repository:{full_name:"owner/other"}},{head_sha:"b".repeat(40)},
    {run_attempt:3},{pull_requests:[]},{pull_requests:[{number:19,head:{sha:SHA}}]},
    {pull_requests:[{number:18,head:{sha:"b".repeat(40)}}]}]){
    assert.equal(verifyGitHubRun(runTarget,workflowRun(patch),workflowRun(patch)).runVerified,false);
  }
  assert.equal(verifyGitHubRun(runTarget,workflowRun(),workflowRun({run_attempt:3})).runReason,
    "GITHUB_RUN_ATTEMPT_CHANGED");
  assert.equal(verifyGitHubRun(runTarget,workflowRun({status:"in_progress",conclusion:null}),workflowRun()).runReason,
    "GITHUB_RUN_CHANGED_DURING_VERIFICATION");
});

test("live run retries during verification discard otherwise successful PR facts",async()=>{
  const f=fake({pull:pr({merged:true})});let reads=0;
  const client={get:async path=>path.endsWith("/actions/runs/77")?
    workflowRun({run_attempt:++reads===1?2:3}):f.client.get(path)};
  const result=await new GitHubVerifier({client}).verify(runTarget);
  assert.equal(result.state,"UNKNOWN");assert.equal(result.reason,"GITHUB_RUN_ATTEMPT_CHANGED");
  assert.equal(result.requiredChecksVerified,false);assert.equal(result.safeToAdvance,false);
});

test("run IDs and attempts must be positive safe integers supplied together",()=>{
  for(const patch of [{runId:77},{attempt:2},{runId:0,attempt:2},{runId:77,attempt:0}])
    assert.throws(()=>checkGitHubTarget({...target,...patch}),e=>e.code==="INVALID_TARGET");
});

test("closed PR omitted by a Run needs official commit association and exact unchanged head branch",async()=>{
  const pull=pr({merged:true}),f=fake({pull});let associationReads=0;
  const emptyRun=workflowRun({pull_requests:[],head_branch:"feature"});
  const client={get:async path=>{
    if(path.endsWith("/actions/runs/77"))return emptyRun;
    if(path.endsWith("/pulls?per_page=100")){associationReads++;return [pull];}
    return f.client.get(path);
  }};
  const facts=await new GitHubVerifier({client}).verify(runTarget);
  assert.equal(associationReads,1);assert.equal(facts.runVerified,true);
  assert.equal(facts.runPrSource,"commit_pull_association");assert.equal(facts.state,"MERGED_CONFIRMED");
  assert.equal(facts.safeToAdvance,false);
  for(const patch of [{commitPulls:[]},{commitPulls:[{...pull,number:19}]},
    {commitPulls:[pull,pull]},{prAfter:{...pull,head:{...pull.head,ref:"other"}}}]){
    const proof={prBefore:pull,prAfter:pull,commitPulls:[pull],...patch};
    assert.equal(verifyGitHubRun(runTarget,emptyRun,emptyRun,proof).runVerified,false);
  }
  const other=workflowRun({pull_requests:[],head_branch:"unrelated"});
  assert.equal(verifyGitHubRun(runTarget,other,other,{prBefore:pull,prAfter:pull,commitPulls:[pull]}).runReason,
    "GITHUB_RUN_PR_BRANCH_MISMATCH");
});

test("base-branch push association requires the exact verified merge commit, not just a matching SHA",()=>{
  const run=workflowRun({pull_requests:[],head_branch:"main"}),pull=pr({merged:true});
  const proof={prBefore:pull,prAfter:pull,commitPulls:[pull]};
  assert.equal(verifyGitHubRun(runTarget,run,run,proof).runVerified,false);
  proof.prBefore={...pull,merge_commit_sha:SHA};proof.prAfter={...pull,merge_commit_sha:SHA};
  assert.equal(verifyGitHubRun(runTarget,run,run,proof).runVerified,true);
  proof.prBefore={...proof.prBefore,merged:false};
  assert.equal(verifyGitHubRun(runTarget,run,run,proof).runVerified,false);
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

test("unprotected branch requires two explicit metadata/Rules reads and two categorized 404s",async()=>{
  const f=fake({pull:pr({merged:true})});let branches=0,protections=0,rules=0;
  const client={get:async path=>{
    if(path.endsWith("/required_status_checks")){protections++;throw new GitHubFactError("GITHUB_NOT_FOUND");}
    if(path.includes("/rules/branches/")){rules++;return [];}
    if(path.endsWith("/branches/main")){branches++;return {name:"main",protected:false};}
    return f.client.get(path);
  }};
  const result=await new GitHubVerifier({client}).verify(target);
  assert.equal(result.state,"MERGED_CONFIRMED");assert.equal(result.requiredChecksVerified,true);
  assert.equal(result.requiredPolicySource,"EXPLICITLY_UNPROTECTED_BRANCH_AND_EMPTY_RULES");
  assert.equal(result.safeToAdvance,false);assert.equal(branches,2);assert.equal(protections,2);assert.equal(rules,2);
});

test("404, auth failure, missing/changing protection and missing/changing Rules never imply no requirements",async()=>{
  for(const mode of ["unauthorized","metadata-missing","protected","metadata-changed","rules-missing","rules-changed","second-protection-error"]){
    const f=fake({pull:pr({merged:true})});let branches=0,protections=0,rules=0;
    const client={get:async path=>{
      if(path.endsWith("/required_status_checks")){
        protections++;
        throw new GitHubFactError(mode==="unauthorized"||(mode==="second-protection-error"&&protections===2)?
          "GITHUB_UNAVAILABLE":"GITHUB_NOT_FOUND");
      }
      if(path.includes("/rules/branches/")){
        rules++;if(mode==="rules-missing")throw Error("unavailable");
        return mode==="rules-changed"&&rules===2?[{type:"required_workflows"}]:[];
      }
      if(path.endsWith("/branches/main")){
        branches++;if(mode==="metadata-missing")throw Error("unavailable");
        return {name:"main",protected:mode==="protected"||(mode==="metadata-changed"&&branches===2)};
      }
      return f.client.get(path);
    }};
    const result=await new GitHubVerifier({client}).verify(target);
    assert.equal(result.state,"UNKNOWN",mode);assert.equal(result.requiredChecksVerified,false,mode);
  }
});

test("CLI categorizes REST 404 without surfacing raw error output",async()=>{
  const client=new GitHubCLI({exec:async()=>{throw Object.assign(Error("secret-stderr"),{
    stdout:JSON.stringify({status:"404",message:"do-not-log"})});}});
  await assert.rejects(client.get("/repos/owner/repo/branches/main/protection/required_status_checks"),
    error=>error.code==="GITHUB_NOT_FOUND"&&!error.message.includes("do-not-log"));
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

test("GitHub observer forwards exact Run/Attempt and refreshes when a concurrent Watchtower binding changes",async()=>{
  const store=new WorkstreamStore();try{
    store.create({id:"one",name:"Ops",projectKey:"ops",repository},1000);
    let watch={workstreamId:"one",headSha:SHA,runId:77,attempt:2};
    let release;const blocked=new Promise(resolve=>{release=resolve;});const seen=[];
    const observer=new GitHubObserver(store,{watchtower:{targets:{list:()=>[watch]}},
      verifier:{verify:async input=>{seen.push(input);if(seen.length===1)await blocked;
        return {state:"UNKNOWN",reason:"TEST",safeToAdvance:false};}},now:()=>500000});
    observer.targets.set("one",18,SHA,2000);
    const first=observer.refresh();
    watch={...watch,attempt:3};const second=observer.refresh();release();
    await first;await second;
    assert.deepEqual(seen.map(s=>[s.runId,s.attempt]),[[77,2],[77,3]]);
    assert.ok(seen.every(s=>s.repository===repository&&s.prNumber===18&&s.headSha===SHA));
  }finally{store.close();}
});

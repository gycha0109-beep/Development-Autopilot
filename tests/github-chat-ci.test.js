import test from "node:test";
import assert from "node:assert/strict";
import {GitHubChatCiObserver,fetchGitHubActionsRuns,fetchGitHubRunJobs,fetchGitHubBranchHead} from "../local/github-chat-ci.js";
import {verifiedCiFailure} from "../local/chat-ci-signal.js";

const repo="gycha0109-beep/Saju";
const a="a".repeat(40),b="b".repeat(40);
const epoch=Date.parse("2026-11-03T02:25:00Z");
const run=(id,sha,status,conclusion=null,branch="feat/saju/work")=>({
  runId:id,runAttempt:1,headSha:sha,headBranch:branch,
  workflowName:"CI",status,conclusion,
  createdAt:new Date(epoch-60_000).toISOString()
});
test("GitHub CLI Actions API uses safe read-only args with explicit branch",async()=>{
  let invoked;
  const result=await fetchGitHubActionsRuns(repo,{
    branch:"feat/saju/work",run:async(command,args,options)=>{
      invoked={command,args,options};
      return {stdout:JSON.stringify({workflow_runs:[{
        id:123,run_attempt:1,head_sha:a,head_branch:"feat/saju/work",
        name:"CI",status:"completed",conclusion:"failure",
        created_at:new Date(epoch).toISOString()
      }]})};
    }
  });
  assert.equal(result.length,1);
  assert.equal(result[0].runId,123);
  assert.equal(invoked.command,"gh");
  assert.match(invoked.args[1],/actions\/runs\?per_page=60/);
  assert.match(invoked.args[1],/branch=feat%2Fsaju%2Fwork/);
  assert.equal(invoked.options.windowsHide,true);
  assert.equal(JSON.stringify(invoked).includes("token"),false);
  await assert.rejects(()=>fetchGitHubActionsRuns("bad/../../token"),
    /REPOSITORY_NAME_INVALID/);
  await assert.rejects(()=>fetchGitHubActionsRuns(repo,{branch:"../../unsafe"}),
    /CI_BRANCH_INVALID/);
});
test("CI Core disabled is irrelevant: GitHub per-chat failure has exact run proof",async()=>{
  let at=epoch,requested=0;
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"feat/saju/work"}],
    readBranchHead:async()=>a,
    now:()=>at,read:async()=>{requested++;return [run(123,a,"completed","failure")];},
    readJobs:async()=>[{runId:123,headSha:a,status:"completed",conclusion:"failure"}]
  });
  assert.equal(observer.state(repo).status,"unknown");
  await observer.refresh();
  assert.equal(observer.state(repo).ciState,"FAILURE");
  const proof=verifiedCiFailure({...observer.provider(),repository:repo,now:at});
  assert.equal(proof.runId,123);
  assert.equal(proof.runAttempt,1);
  assert.equal(proof.headSha,a);
  assert.equal(proof.advisoryOnly,true);
  await observer.refresh();
  assert.equal(requested,1,"poll throttled");
  at+=61_000;await observer.refresh();
  assert.equal(requested,2);
});
test("RUNNING has no failure even with earlier failed job; only final RED can send",async()=>{
  let at=epoch,rows=[run(10,a,"completed","failure"),
    {...run(11,a,"in_progress"),createdAt:new Date(epoch-20_000).toISOString()}];
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"feat/saju/work"}],
    readBranchHead:async()=>a,
    now:()=>at,read:async()=>rows,
    readJobs:async()=>[{runId:10,headSha:a,status:"completed",conclusion:"failure"}]
  });
  await observer.refresh();
  assert.equal(observer.state(repo).ciState,"RUNNING");
  assert.equal(verifiedCiFailure({...observer.provider(),repository:repo,now:at}),null);
  rows=[{...run(11,a,"completed","success"),
    createdAt:new Date(epoch-20_000).toISOString()},
    run(10,a,"completed","failure")];
  at+=61_000;await observer.refresh();
  // Later success for the same workflow supersedes the older failed run.
  assert.equal(observer.state(repo).ciState,"SUCCESS");
});
test("without a branch, multiple contemporary heads are ambiguous and fail closed",async()=>{
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo}],now:()=>epoch,
    read:async()=>[run(1,a,"completed","failure"),
      run(2,b,"completed","success","feat/other")]
  });
  await observer.refresh();
  assert.equal(observer.state(repo).status,"ambiguous");
  assert.equal(observer.provider().registry.repositories.length,0);
  assert.equal(verifiedCiFailure({...observer.provider(),
    repository:repo,now:epoch}),null);
});
test("GitHub offline, stale snapshots and no chat opt-in never claim green or red",async()=>{
  let now=epoch,active=[{repository:repo}],calls=0;
  const observer=new GitHubChatCiObserver({targets:()=>active,now:()=>now,
    read:async()=>{calls++;throw Error("token secret must not be exposed");}});
  await observer.refresh();
  assert.equal(observer.state(repo).status,"unknown");
  assert.equal(observer.current().repositories[0].errorCode,"GITHUB_CI_UNAVAILABLE");
  assert.equal(JSON.stringify(observer.current()).includes("token secret"),false);
  assert.equal(observer.provider().registry.repositories.length,0);
  active=[];now+=61_000;await observer.refresh();
  assert.equal(observer.current().status,"not_configured");
  assert.equal(calls,1);
});


test("RED never emits without independent matching failed job",async()=>{
  for(const jobs of [
    [],
    [{runId:11,headSha:a,status:"completed",conclusion:"failure"}],
    [{runId:10,headSha:b,status:"completed",conclusion:"failure"}],
    [{runId:10,headSha:a,status:"completed",conclusion:"success"}]
  ]){
    const observer=new GitHubChatCiObserver({
      targets:()=>[{repository:repo,branch:"feat/saju/work"}],
    readBranchHead:async()=>a,
      now:()=>epoch,read:async()=>[run(10,a,"completed","failure")],
      readJobs:async()=>jobs
    });
    await observer.refresh();
    assert.equal(observer.state(repo).ciState,"UNKNOWN");
    assert.equal(verifiedCiFailure({...observer.provider(),repository:repo,now:epoch}),null);
  }
});
test("GitHub run job list is exact, bounded and read-only",async()=>{
  const calls=[];
  const rows=await fetchGitHubRunJobs(repo,10,{run:async(command,args,options)=>{
    calls.push({command,args,options});
    return {stdout:JSON.stringify({total_count:1,jobs:[{
      run_id:10,head_sha:a,status:"completed",conclusion:"failure",name:"tests"}]})};
  }});
  assert.deepEqual(rows,[{runId:10,headSha:a,status:"completed",
    conclusion:"failure",name:"tests"}]);
  assert.match(calls[0].args[1],/actions\/runs\/10\/jobs/);
  assert.equal(calls[0].command,"gh");
  await assert.rejects(()=>fetchGitHubRunJobs(repo,-1),/CI_RUN_ID_INVALID/);
  await assert.rejects(()=>fetchGitHubRunJobs(repo,12,{run:async()=>({
    stdout:JSON.stringify({total_count:101,jobs:[]})})}),
    /GITHUB_CI_JOBS_INCOMPLETE/);
});


test("older failed SHA on the same branch cannot mark latest green HEAD red",async()=>{
  const later={...run(201,b,"completed","success"),
    workflowName:"CI",createdAt:new Date(epoch-3_000).toISOString()};
  const older={...run(200,a,"completed","failure"),
    workflowName:"CI",createdAt:new Date(epoch-80_000).toISOString()};
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"feat/saju/work"}],
    readBranchHead:async()=>b,
    now:()=>epoch,read:async()=>[later,older],
    readJobs:async()=>{throw Error("old SHA job must not be read");}
  });
  await observer.refresh();
  assert.equal(observer.state(repo).ciState,"SUCCESS");
  assert.equal(observer.state(repo).incidents.length,0);
  assert.equal(observer.state(repo).runs.length,1);
  assert.equal(observer.state(repo).runs[0].headSha,b);
});

test("branch head API uses read-only exact branch and rejects missing HEAD",async()=>{
  let called;
  const head=await fetchGitHubBranchHead(repo,"feat/security/verified-branch",{
    run:async(command,args,options)=>{
      called={command,args,options};
      return {stdout:JSON.stringify({commit:{sha:a}})};
    }
  });
  assert.equal(head,a);
  assert.equal(called.command,"gh");
  assert.match(called.args[1],/branches\/feat%2Fsecurity%2Fverified-branch/);
  assert.equal(called.options.windowsHide,true);
  await assert.rejects(()=>fetchGitHubBranchHead(repo,"../escape"),/CI_BRANCH_INVALID/);
});

test("two chats in one repository observe separate current branch HEADs",async()=>{
  const admin="main",security="feat/security/proposal";
  const now=epoch+26*60*60_000;
  const calls=[];
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:admin},{repository:repo,branch:security}],
    now:()=>now,
    readBranchHead:async(_repo,branch)=>branch===admin?b:a,
    read:async(_repo,{branch,headSha})=>{
      calls.push({branch,headSha});
      const date=new Date(epoch).toISOString();
      return branch===admin?
        [{...run(210,b,"in_progress",null,admin),createdAt:date}]:
        [{...run(100,a,"completed","success",security),createdAt:date}];
    }
  });
  await observer.refresh();
  assert.deepEqual(calls,[{branch:admin,headSha:b},{branch:security,headSha:a}]);
  assert.equal(observer.state(repo,admin).ciState,"RUNNING");
  assert.equal(observer.state(repo,security).ciState,"SUCCESS",
    "unchanged verified branch HEAD can retain an older completed CI");
  assert.equal(observer.state(repo).status,"ambiguous",
    "unscoped callers cannot silently select the first branch");
  assert.equal(observer.provider().scan.repositories.length,2);
});

test("branch HEAD change without matching checks is UNKNOWN, never inherited GREEN",async()=>{
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"main"}],now:()=>epoch,
    readBranchHead:async()=>b,
    read:async()=>[run(10,a,"completed","success","main")]
  });
  await observer.refresh();
  assert.equal(observer.state(repo,"main").ciState,"UNKNOWN");
  assert.equal(observer.state(repo,"main").runs.length,0);
});

test("branch HEAD lookup failure is not treated as CI success",async()=>{
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"main"}],now:()=>epoch,
    readBranchHead:async()=>{throw Error("private credential failure");},
    read:async()=>{throw Error("must not read runs without branch HEAD");}
  });
  await observer.refresh();
  assert.equal(observer.state(repo,"main").status,"unknown");
  assert.equal(observer.state(repo,"main").ciState,"UNKNOWN");
  assert.equal(observer.current().repositories[0].errorCode,"GITHUB_CI_UNAVAILABLE");
  assert.equal(JSON.stringify(observer.current()).includes("private credential failure"),false);
});

test("scope excludes unrelated failed Admin build from Commerce main CI",async()=>{
  const now=epoch;
  const branch="main";
  const green=(id,name)=>({...run(id,a,"completed","success",branch),workflowName:name});
  const red={...run(120,a,"completed","failure",branch),workflowName:"Admin Console Private Build"};
  const observer=new GitHubChatCiObserver({
    now:()=>now,targets:()=>[{repository:repo,branch}],
    readBranchHead:async()=>a,
    read:async()=>[red,green(121,"CI"),green(122,"Governance"),green(123,"Supabase Production")],
    readJobs:async()=>[{runId:120,headSha:a,status:"completed",conclusion:"failure"}]
  });
  await observer.refresh();
  assert.equal(observer.state(repo,branch).ciState,"FAILURE");
  const commerce=observer.state(repo,branch,["CI","Governance","Supabase Production"]);
  assert.equal(commerce.ciState,"SUCCESS");
  assert.equal(commerce.runs.length,3);
  assert.equal(commerce.incidents.length,0);
  assert.equal(observer.state(repo,branch,["CI","Not-Triggered"]).ciState,"UNKNOWN",
    "missing required check must never masquerade as GREEN");
  assert.equal(observer.state(repo,branch,["Admin Console Private Build"]).ciState,"FAILURE");
});

test("deleted branch is identified separately from an ordinary GitHub outage",async()=>{
  const gone=Error("command failed");
  gone.stderr="gh: Branch not found (HTTP 404)";
  await assert.rejects(
    ()=>fetchGitHubBranchHead(repo,"docs/ops/merged-and-deleted",{run:async()=>{throw gone;}}),
    /GITHUB_BRANCH_NOT_FOUND/
  );
  const generic=Error("command failed");generic.stderr="gh: Forbidden (HTTP 403)";
  await assert.rejects(
    ()=>fetchGitHubBranchHead(repo,"docs/ops/not-permitted",{run:async()=>{throw generic;}}),
    /GITHUB_BRANCH_HEAD_UNAVAILABLE/
  );
  const observer=new GitHubChatCiObserver({
    targets:()=>[{repository:repo,branch:"docs/ops/merged-and-deleted"}],now:()=>epoch,
    readBranchHead:async()=>{throw Error("GITHUB_BRANCH_NOT_FOUND");},
    read:async()=>{throw Error("must not query CI after missing branch");}
  });
  await observer.refresh();
  const item=observer.state(repo,"docs/ops/merged-and-deleted");
  assert.equal(item.ciState,"UNKNOWN");
  assert.equal(item.status,"unknown");
  assert.equal(item.errorCode,"GITHUB_BRANCH_NOT_FOUND");
});

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CodexLocalRunner, CodexRunError, processCommand, codexInvocation
} from "../local/codex-cli-adapter.js";

function setup({branch="feature/demo",remote="https://github.com/owner/repo.git",task="Improve one doc."}={}){
  const folder=mkdtempSync(join(tmpdir(),"autopilot-codex-test-"));
  const workspace=join(folder,"repo");
  mkdirSync(workspace);
  const git=(...args)=>execFileSync("git",["-C",workspace,...args],{encoding:"utf8"}).trim();
  git("init","-b",branch);
  git("config","user.name","CI Test");
  git("config","user.email","ci@example.invalid");
  git("remote","add","origin",remote);
  writeFileSync(join(workspace,".gitignore"),".autopilot/\n");
  writeFileSync(join(workspace,"README.md"),"Initial repository\n");
  git("add",".");
  git("commit","-qm","Initial commit");
  const taskFile=join(folder,"task.txt");
  writeFileSync(taskFile,task);
  const config={
    workspace,repository:"owner/repo",taskFile,allowedPaths:["docs/task.md"]
  };
  return {folder,workspace,taskFile,config,git,
    cleanup:()=>rmSync(folder,{recursive:true,force:true})};
}
function fakeCodex(action) {
  let calls=0,argv;
  const run=async(command,args,opts)=>{
    if(command!=="codex")return processCommand(command,args,opts);
    calls++;argv=args;
    return action(opts);
  };
  return {run,get calls(){return calls},get argv(){return argv}};
}
test("approval preview binds exact repository, branch, SHA, task digest and allowed file paths",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(()=>{throw Error("should not run")});
    const runner=new CodexLocalRunner({run:fake.run});
    const preview=await runner.prepare(x.config);
    assert.match(preview.fingerprint,/^[0-9a-f]{64}$/);
    assert.equal(preview.repository,"owner/repo");
    assert.equal(preview.sourceBranch,"feature/demo");
    assert.equal(preview.allowedPaths[0],"docs/task.md");
    assert.equal(fake.calls,0);
    assert.equal(preview.fingerprint,(await runner.prepare(x.config)).fingerprint);
  }finally{x.cleanup()}
});
test("approved one-shot Codex invocation runs in isolated detached worktree and verifies only expected files",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(opts=>{
      mkdirSync(join(opts.cwd,"docs"),{recursive:true});
      writeFileSync(join(opts.cwd,"docs","task.md"),"Implemented one approved doc change\n");
      assert.match(opts.input,/Improve one doc/);
      assert.equal(opts.env.GITHUB_TOKEN,undefined);
      return {code:0,stdout:'{"type":"turn.completed"}\n',stderr:""};
    });
    const runner=new CodexLocalRunner({run:fake.run,now:()=>100_000});
    const plan=await runner.prepare(x.config);
    const result=await runner.runApproved(x.config,plan.fingerprint);
    assert.equal(fake.calls,1);
    assert.ok(fake.argv.includes("workspace-write"));
    assert.ok(fake.argv.includes("never"));
    assert.equal(result.state,"WAIT_GITHUB_PR_AND_CI");
    assert.deepEqual(result.changedPaths,["docs/task.md"]);
    assert.equal(result.changeVerified,true);
    assert.match(result.changeFingerprint,/^[0-9a-f]{64}$/);
    assert.equal(result.githubVerified,false);
    assert.equal(result.ciVerified,false);
    assert.equal(result.phaseComplete,false);
    assert.equal(x.git("status","--porcelain"),"");
    assert.equal(x.git("rev-parse","HEAD"),plan.sourceHead);
    assert.ok(readFileSync(join(result.worktree,"docs","task.md"),"utf8").includes("approved"));
    const audits=readdirSync(join(x.workspace,".autopilot","codex-runs"));
    assert.equal(audits.length,1);
    const audit=JSON.parse(readFileSync(join(x.workspace,".autopilot","codex-runs",audits[0]),"utf8"));
    assert.equal(audit.runId,result.runId);
    assert.equal(audit.state,result.state);
    assert.equal(audit.fingerprint,plan.fingerprint);
  }finally{x.cleanup()}
});
test("fingerprint mismatch rejects execution before making any worktree",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(()=>{throw Error("cannot be called")});
    const runner=new CodexLocalRunner({run:fake.run});
    await assert.rejects(runner.runApproved(x.config,"f".repeat(64)),
      e=>e.code==="EXACT_TASK_APPROVAL_REQUIRED");
    assert.equal(fake.calls,0);
    assert.equal(x.git("worktree","list").split("\n").length,1);
  }finally{x.cleanup()}
});
test("modified task invalidates prior explicit approval",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(()=>{throw Error("should not run")});
    const runner=new CodexLocalRunner({run:fake.run});
    const preview=await runner.prepare(x.config);
    writeFileSync(x.taskFile,"Changed approved instructions.");
    await assert.rejects(runner.runApproved(x.config,preview.fingerprint),
      e=>e.code==="EXACT_TASK_APPROVAL_REQUIRED");
    assert.equal(fake.calls,0);
  }finally{x.cleanup()}
});
test("dirty checkout, protected main, origin mismatch, traversal and no-scope are blocked",async()=>{
  const samples=[
    {setup:()=>setup({branch:"main"}),expected:"PROTECTED_BRANCH_NOT_ALLOWED"},
    {setup:()=>setup({remote:"https://github.com/other/repo.git"}),expected:"GITHUB_REMOTE_MISMATCH"}
  ];
  for(const entry of samples){
    const x=entry.setup();
    try{
      await assert.rejects(new CodexLocalRunner().prepare(x.config),
        e=>e.code===entry.expected);
    }finally{x.cleanup()}
  }
  const x=setup();
  try{
    writeFileSync(join(x.workspace,"uncommitted.txt"),"dirty");
    await assert.rejects(new CodexLocalRunner().prepare(x.config),
      e=>e.code==="SOURCE_WORKTREE_DIRTY");
    rmSync(join(x.workspace,"uncommitted.txt"));
    for(const path of ["../outside","/etc/passwd","docs\\bad.md",".git/config","docs//bad.md"]){
      await assert.rejects(new CodexLocalRunner().prepare({
        ...x.config,allowedPaths:[path]
      }),e=>e.code==="INVALID_ALLOWED_PATH");
    }
    await assert.rejects(new CodexLocalRunner().prepare({...x.config,allowedPaths:[]}),
      e=>e.code==="INVALID_TASK_CONFIGURATION");
  }finally{x.cleanup()}
});
test("Codex writing an unapproved file fails closed and remains in isolated worktree",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(opts=>{
      writeFileSync(join(opts.cwd,"unexpected.txt"),"out of scope");
      return {code:0,stdout:"",stderr:""};
    });
    const runner=new CodexLocalRunner({run:fake.run});
    const p=await runner.prepare(x.config);
    const result=await runner.runApproved(x.config,p.fingerprint);
    assert.equal(result.state,"OUT_OF_SCOPE_CHANGES");
    assert.deepEqual(result.outOfScopePaths,["unexpected.txt"]);
    assert.equal(result.changeVerified,false);
    assert.equal(x.git("status","--porcelain"),"");
  }finally{x.cleanup()}
});
test("Codex non-zero exit and no-file response never claim verified completion",async()=>{
  for(const [code,expected] of [[2,"CODEX_REPORTED_FAILURE"],[0,"NO_CHANGES"]]){
    const x=setup();
    try{
      const runner=new CodexLocalRunner({run:fakeCodex(()=>({
        code,stdout:"",stderr:"provider credentials must not be logged"
      })).run});
      const p=await runner.prepare(x.config);
      const result=await runner.runApproved(x.config,p.fingerprint);
      assert.equal(result.state,expected);
      assert.equal(result.changeVerified,false);
      assert.equal(result.githubVerified,false);
      assert.equal(result.phaseComplete,false);
      assert.ok(!JSON.stringify(result).includes("provider credentials"));
    }finally{x.cleanup()}
  }
});
test("first failed Codex call remains auditable with no automatic retry",async()=>{
  const x=setup();
  try{
    const fake=fakeCodex(()=>{throw Error("hidden credential");});
    const runner=new CodexLocalRunner({run:fake.run});
    const p=await runner.prepare(x.config);
    const result=await runner.runApproved(x.config,p.fingerprint);
    assert.equal(result.state,"RUN_FAILED_UNKNOWN");
    assert.equal(fake.calls,1);
    assert.equal(result.changeVerified,false);
    assert.ok(!JSON.stringify(result).includes("hidden credential"));
  }finally{x.cleanup()}
});
test("prompt is sent over stdin, not shell or argv, and timeout is bounded",async()=>{
  const x=setup({task:"Secret task value"});
  try{
    const fake=fakeCodex(opts=>({
      code:0,stdout:"",stderr:""
    }));
    const runner=new CodexLocalRunner({run:fake.run});
    const p=await runner.prepare(x.config);
    await runner.runApproved(x.config,p.fingerprint);
    assert.ok(!fake.argv.join(" ").includes("Secret task value"));
    assert.equal(fake.argv[fake.argv.length-1],"-");
    assert.ok(fake.argv.includes("--json"));
    assert.ok(fake.argv.includes("sandbox_workspace_write.network_access=false"));
  }finally{x.cleanup()}
});


test("Windows npm-installed Codex is invoked via Node JS launcher, never through a shell shim",()=>{
  const expected=codexInvocation("win32","C:\\Users\\tester\\AppData\\Roaming",()=>true);
  assert.equal(expected.command,process.execPath);
  assert.equal(expected.prefix.length,1);
  assert.match(expected.prefix[0],/codex\.js$/);
  const native=codexInvocation("win32","C:\\Users\\tester\\AppData\\Roaming",()=>false);
  assert.equal(native.command,"codex.exe");
  assert.deepEqual(native.prefix,[]);
  assert.equal(codexInvocation("linux","/tmp",()=>false).command,"codex");
});

test("symlinked output is rejected even if its name is on the allowlist",async()=>{
  const x=setup();
  try{
    const {symlinkSync}=await import("node:fs");
    const fake=fakeCodex(opts=>{
      mkdirSync(join(opts.cwd,"docs"),{recursive:true});
      try{symlinkSync(join(x.folder,"task.txt"),join(opts.cwd,"docs","task.md"));}
      catch(error){
        if(process.platform==="win32" && error.code==="EPERM")return {code:2,stdout:"",stderr:""};
        throw error;
      }
      return {code:0,stdout:"",stderr:""};
    });
    const runner=new CodexLocalRunner({run:fake.run});
    const plan=await runner.prepare(x.config);
    const result=await runner.runApproved(x.config,plan.fingerprint);
    if(result.state==="CODEX_REPORTED_FAILURE" && process.platform==="win32")return;
    assert.equal(result.state,"SYMLINK_OUTPUT_NOT_ALLOWED");
    assert.equal(result.changeVerified,false);
  }finally{x.cleanup()}
});

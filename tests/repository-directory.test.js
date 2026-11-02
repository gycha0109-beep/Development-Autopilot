import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";
import {
  RepositoryDirectory,normalizeRepository,listAccessibleGitHubRepos
} from "../local/repository-directory.js";

const ext="abcdefghijklmnopabcdefghijklmnop";
function setup(discover=async()=>({items:[],truncated:false})){
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId:ext,sessionKey:"chat",urlHash:"a".repeat(64),
      status:"connected"}],links:[]})};
  const macros=new ChatMacroController(store,{bridge,now:()=>1_000_000});
  const directory=new RepositoryDirectory(store,{discover,now:()=>1_000_000});
  macros.setRepositoryDirectory(directory);
  return {store,macros,directory,close:()=>store.close()};
}
test("manual repositories work without GitHub, CI Core, or any Workstream",async()=>{
  const x=setup(async()=>{throw Error("network unreachable");});
  try{
    assert.deepEqual(x.macros.view(ext).repositories,[]);
    assert.equal(x.directory.register({repository:"owner/repo"}).registered,true);
    assert.equal(x.directory.register({repository:"owner/repo"}).registered,true);
    assert.equal(x.directory.list().length,1);
    assert.equal((await x.directory.refresh()).githubStatus,"unavailable");
    assert.deepEqual(x.macros.view(ext).repositories,["owner/repo"]);
    assert.equal(x.directory.state({status:"not_configured"}).repositories[0].ciMonitored,false);
    const linked=x.macros.configure(ext,{sessionKey:"chat",enabled:true,
      mode:"manual",intervalMinutes:2,repository:"owner/repo"});
    assert.equal(linked.repository,"owner/repo");
    assert.equal(x.store.list().length,0);
  }finally{x.close();}
});
test("known Workstream repository is listed without CI Core or GitHub",()=>{
  const x=setup();
  try{
    x.store.create({name:"Existing",projectKey:"example",
      repository:"existing/project",mode:"observe"},1_000_000);
    assert.deepEqual(x.directory.list().map(x=>x.name),["existing/project"]);
    assert.equal(x.directory.list()[0].source,"workstream");
    assert.equal(x.directory.state().repositories[0].ciMonitored,false);
  }finally{x.close();}
});
test("GitHub discovery merges with local/manual and marks monitoring separately",async()=>{
  let calls=0;
  const x=setup(async()=>{calls++;return {items:[
    {repository:"owner/repo",visibility:"private"},
    {repository:"another/lib",visibility:"public"}
  ],truncated:false};});
  try{
    x.directory.register({repository:"owner/repo"});
    const first=await x.directory.refresh();
    assert.equal(first.githubStatus,"connected");
    assert.equal(first.repositories.length,2);
    assert.equal(first.repositories.find(x=>x.name==="owner/repo").source,"manual");
    assert.equal(first.repositories.find(x=>x.name==="owner/repo").visibility,"private");
    assert.equal(first.repositories.every(x=>x.ciMonitored===false),true);
    assert.equal(x.directory.state({status:"connected",
      repositories:[{name:"owner/repo"}]}).repositories.filter(x=>x.ciMonitored).length,1);
    await x.directory.refresh();
    assert.equal(calls,1); // Cached; explicit refresh bypasses.
    await x.directory.refresh({force:true});
    assert.equal(calls,2);
  }finally{x.close();}
});
test("GitHub listing uses authenticated API pagination, never returns auth secrets",async()=>{
  const args=[];
  const fake=async(command,arguments_,options)=>{
    args.push({command,arguments_,options});
    return {stdout:JSON.stringify([{full_name:"owner/repo",private:true}])};
  };
  const result=await listAccessibleGitHubRepos({run:fake});
  assert.deepEqual(result,{items:[{repository:"owner/repo",visibility:"private"}],
    truncated:false});
  assert.equal(args[0].command,"gh");
  assert.ok(args[0].arguments_.includes("-H"));
  assert.equal(args[0].options.windowsHide,true);
  assert.equal(JSON.stringify(args).includes("token"),false);
});
test("invalid owner/repo never writes the directory or leaks error text",()=>{
  const x=setup();
  try{
    for(const text of ["", "repo", "../repo", "owner/..", "/repo",
      "owner/repo/extra", "owner/private?token=secret", " owner/repo"]){
      assert.throws(()=>normalizeRepository(text),/REPOSITORY_NAME_INVALID/);
      assert.throws(()=>x.directory.register({repository:text}),/REPOSITORY_NAME_INVALID/);
    }
    assert.equal(x.directory.list().length,0);
  }finally{x.close();}
});

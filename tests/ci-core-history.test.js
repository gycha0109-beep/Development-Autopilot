import test from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {CoreHistoryClient,CoreHistoryObserver,CoreHistoryError,validateHistorySnapshot}
  from "../local/ci-core-history.js";
const REPO={id:2,projectId:1,name:"owner/repo",enabled:true};
const EXE=resolve("ci-core-history.exe"),DB=resolve("watchtower-history.sqlite3");
const SHA="a".repeat(40);
function sampleRun(extra={}){
  return {repositoryId:2,repository:"owner/repo",projectId:1,projectKey:"alpha",
    runId:4,workflowId:5,workflowName:"CI",workflowPath:".github/workflows/ci.yml",
    ciKind:"general",headSha:SHA,runAttempt:1,latestKnownAttempt:2,
    status:"completed",conclusion:"success",ciState:"SUCCESS",
    resolutionStatus:"resolved",workTrackId:3,workTrackKey:"ops",
    assignmentSource:"manual",workTrackSource:"manual",
    attributionConflict:false,createdAt:"2026-11-01T00:00:00Z",
    updatedAt:"2026-11-01T00:04:00Z",lastSeenAt:"2026-11-01T00:04:00Z",
    historicalOnly:true,source:"watchtower_sqlite_history",safeToAdvance:false,...extra};
}
function data(extra={}){
  return {source:"watchtower_sqlite_history",observedAt:new Date().toISOString(),
    repositoryId:2,historicalOnly:true,completeCoverage:false,safeToAdvance:false,
    runs:[sampleRun()],...extra};
}
test("stored historical SUCCESS can never authorize an execution",()=>{
  const res=validateHistorySnapshot(data(),REPO);
  assert.equal(res.runs[0].ciState,"SUCCESS");
  assert.equal(res.runs[0].latestKnownAttempt,2);
  assert.equal(res.runs[0].safeToAdvance,false);
  assert.equal(res.safeToAdvance,false);
  assert.equal(res.historicalOnly,true);
});
test("reject stale, incomplete and mistaken current/attempt identity",()=>{
  const bad=[
    data({safeToAdvance:true}),data({historicalOnly:false}),data({completeCoverage:true}),
    data({repositoryId:99}),data({runs:[sampleRun({headSha:"b"})]}),
    data({runs:[sampleRun({latestKnownAttempt:0})]}),
    data({runs:[sampleRun({runAttempt:3})]}),
    data({runs:[sampleRun({repository:"wrong/repo"})]}),
    data({runs:[sampleRun({safeToAdvance:true})]}),
    data({runs:[sampleRun(),sampleRun()]}),
    data({observedAt:new Date(Date.now()-180000).toISOString()})
  ];
  for(const d of bad)assert.throws(()=>validateHistorySnapshot(d,REPO),CoreHistoryError);
});
test("argument-vector reader is bounded and credential-free",async()=>{
  const invoked=[];
  const client=new CoreHistoryClient({platform:"win32",binaryPath:EXE,dbPath:DB,limit:20,
    exec:async(exe,args,opts)=>{
      invoked.push({exe,args,opts});
      return {stdout:JSON.stringify({contractVersion:"ci-core-history/0.1",data:data()})};
    }});
  const r=await client.read(REPO);
  assert.equal(r.runs.length,1);
  assert.deepEqual(invoked[0].args,["--db",DB,"--repository-id","2","--limit","20"]);
  assert.equal(invoked[0].opts.shell,false);
  assert.equal(invoked[0].opts.windowsHide,true);
  await assert.rejects(client.read({...REPO,id:0}),x=>x.code==="INVALID_TARGET");
});
test("CLI errors do not leak child stderr, raw SQL or path contents",async()=>{
  const client=new CoreHistoryClient({platform:"win32",binaryPath:EXE,dbPath:DB,
    exec:async()=>{const e=new Error("sensitive database path");
      e.stdout=JSON.stringify({contractVersion:"ci-core-history/0.1",
        error:{code:"DATABASE_SCHEMA_UNSUPPORTED"}});
      e.stderr="sensitive raw SQL error";throw e;}});
  await assert.rejects(client.read(REPO),x=>x.code==="DATABASE_SCHEMA_UNSUPPORTED"&&
    !x.message.includes("sensitive"));
});
test("registry observed enables bounded read-only historical snapshots",async()=>{
  const registry={current:()=>({status:"observed",repositories:[REPO]})};
  let calls=0;
  const observer=new CoreHistoryObserver({registry,
    client:{configured:true,read:async()=>{calls++;return data();}}});
  let snapshot=await observer.refresh();
  assert.equal(snapshot.status,"observed");
  assert.equal(snapshot.repositories[0].runs.length,1);
  assert.equal(snapshot.safeToAdvance,false);
  assert.equal(snapshot.historicalOnly,true);
  await observer.refresh();
  assert.equal(calls,1);
});
test("missing registry prevents historical CLI execution",async()=>{
  let calls=0;
  const observer=new CoreHistoryObserver({registry:{current:()=>({status:"unavailable"})},
    client:{configured:true,read:async()=>{calls++;throw Error("must not read");}}});
  const out=await observer.refresh();
  assert.equal(out.status,"unavailable");
  assert.equal(calls,0);
  assert.equal(out.safeToAdvance,false);
});
test("5 repositories limit historical lookups to 4 each interval",async()=>{
  const repos=Array.from({length:5},(_,i)=>({id:i+1,projectId:1,name:"owner/repo"+i,enabled:true}));
  let calls=0;
  const observer=new CoreHistoryObserver({registry:{current:()=>({status:"observed",repositories:repos})},
    client:{configured:true,read:async r=>{calls++;return {runs:[]};}}});
  const out=await observer.refresh();
  assert.equal(out.checkedCount,4);
  assert.equal(calls,4);
  assert.equal(out.repositories.filter(x=>x.reason==="HISTORY_RATE_BUDGET").length,1);
  assert.equal(out.safeToAdvance,false);
});

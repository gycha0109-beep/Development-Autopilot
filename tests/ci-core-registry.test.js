import test from "node:test";
import assert from "node:assert/strict";
import {resolve} from "node:path";
import {CoreRegistryClient,CoreRegistryObserver,CoreRegistryError,validateCoreRegistry}
  from "../local/ci-core-registry.js";

const EXE=resolve("ci-core-registry.exe"),DB=resolve("fixture-watchtower.sqlite3");
function data(extra={}){
  return {source:"watchtower_existing_sqlite",observedAt:new Date().toISOString(),
    readOnly:true,completeCoverage:false,safeToAdvance:false,
    projects:[{id:1,key:"alpha",name:"Alpha",active:true}],
    repositories:[{id:2,projectId:1,name:"owner/repo",enabled:true,
      lastPollAttemptAt:null,lastSuccessfulPollAt:null,pollErrorCode:null}],
    tracks:[{id:3,projectId:1,canonicalTrackKey:"ops",name:"Operations",active:true}],
    ...extra};
}
test("registry reader passes an absolute path as argument vector only",async()=>{
  const calls=[];
  const client=new CoreRegistryClient({platform:"win32",binaryPath:EXE,dbPath:DB,
    exec:async(path,args,options)=>{
      calls.push({path,args,options});
      return {stdout:JSON.stringify({contractVersion:"ci-core-registry/0.1",data:data()})};
    }});
  const out=await client.read();
  assert.equal(out.readOnly,true);
  assert.equal(out.safeToAdvance,false);
  assert.equal(out.repositories[0].id,2);
  assert.deepEqual(calls[0].args,["--db",DB]);
  assert.equal(calls[0].options.shell,false);
  assert.equal(calls[0].options.windowsHide,true);
});
test("untrusted and stale registry snapshots fail closed",()=>{
  for(const bad of [
    {safeToAdvance:true},{readOnly:false},{completeCoverage:true},
    {observedAt:new Date(Date.now()-180000).toISOString()},
    {tracks:[{id:3,projectId:777,canonicalTrackKey:"ops",name:"Operations",active:true}]},
    {repositories:[{id:2,projectId:1,name:"bad repo",enabled:true,pollErrorCode:null}]},
    {projects:[{id:1,key:"alpha",name:"Alpha",active:true},{id:1,key:"duplicate",name:"Duplicate",active:true}]},
    {repositories:[{id:2,projectId:1,name:"owner/repo",enabled:true,pollErrorCode:"raw token text"}]}
  ]){
    assert.throws(()=>validateCoreRegistry(data(bad)),CoreRegistryError,JSON.stringify(bad));
  }
});
test("credential-free registry CLI error is sanitized and cannot trigger execution",async()=>{
  const client=new CoreRegistryClient({platform:"win32",binaryPath:EXE,dbPath:DB,
    exec:async()=>{
      const error=new Error("local database file path and credential must not be shown");
      error.stdout=JSON.stringify({contractVersion:"ci-core-registry/0.1",
        error:{code:"DATABASE_UNAVAILABLE"}});
      error.stderr="sensitive child process diagnostic";
      throw error;
    }});
  await assert.rejects(client.read(),error=>error.code==="DATABASE_UNAVAILABLE"&&
    !error.message.includes("credential"));
});
test("unknown child error codes never escape unfiltered",async()=>{
  const client=new CoreRegistryClient({platform:"win32",binaryPath:EXE,dbPath:DB,
    exec:async()=>{
      const e=new Error("sensitive value");
      e.stdout=JSON.stringify({error:{code:"HIDDEN_INTERNAL_SECRET"},contractVersion:"ci-core-registry/0.1"});
      throw e;
    }});
  await assert.rejects(client.read(),error=>error.code==="CORE_REGISTRY_UNAVAILABLE");
});
test("registry observer is read-only, cached, and never grants approval",async()=>{
  let calls=0;
  const obs=new CoreRegistryObserver({client:{configured:true,read:async()=>{calls++;return data();}}});
  const first=await obs.refresh();
  assert.equal(first.status,"observed");
  assert.equal(first.projects.length,1);
  assert.equal(first.repositories.length,1);
  assert.equal(first.tracks.length,1);
  assert.equal(first.safeToAdvance,false);
  assert.equal(first.completeCoverage,false);
  await obs.refresh();
  assert.equal(calls,1);
});
test("disabled registry remains inert even when refreshed",async()=>{
  const obs=new CoreRegistryObserver({client:{configured:false,read:async()=>{throw Error("must not run")}}});
  assert.equal((await obs.refresh()).status,"disabled");
  assert.equal(obs.current().safeToAdvance,false);
});

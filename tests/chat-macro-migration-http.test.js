import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const origin="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const post=(base,path,body,token=null)=>fetch(base+path,{
  method:"POST",headers:{Origin:token?origin:base,"Content-Type":"application/json",
    ...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
test("project migration tracks and safely rebinds a chat without creating Workstream",{
  timeout:20000},async()=>{
  const temp=mkdtempSync(join(tmpdir(),"autopilot-macro-migrate-"));
  const port=await new Promise(resolve=>{
    const s=createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p))});
  });
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,AUTOPILOT_PORT:String(port),
      AUTOPILOT_DB:join(temp,"db.sqlite3"),AUTOPILOT_TELEGRAM_ENABLED:"0"},
    stdio:"ignore"
  });
  try{
    let ready=false;for(let i=0;i<70;i++){
      try{if((await fetch(base+"/api/v1/snapshot")).ok){ready=true;break}}catch{}
      await new Promise(r=>setTimeout(r,80));
    }
    assert.equal(ready,true);
    const pairing=await post(base,"/api/v1/bridge/pairing/start",{});
    const code=(await pairing.json()).code;
    const paired=await fetch(base+"/api/v1/bridge/pair",{method:"POST",
      headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify({code})});
    const token=(await paired.json()).token;
    const req=async(path,body={})=>{
      const r=await post(base,"/api/v1/bridge/"+path,body,token);
      return {status:r.status,body:await r.json()};
    };
    const sessionKey="project-chat",hashA="a".repeat(64),hashB="b".repeat(64);
    const sync=async(hash)=>req("sync",{version:1,composerBuild:"composer-2026-10-15-r17",
      sessions:[{sessionKey,groupKey:"group",groupLabel:"Project",title:"Project 3",
        status:"connected",origin:"https://chatgpt.com",urlHash:hash}]});
    assert.equal((await sync(hashA)).status,200);
    const config=await req("macro-configure",{sessionKey,enabled:true,mode:"auto",
      repository:"owner/repo",intervalMinutes:1});
    assert.equal(config.status,200);
    const result=await sync(hashA);
    assert.equal(result.status,200);
    assert.deepEqual(result.body.migrationTargets,
      [{sessionKey,repository:"owner/repo",sourceKind:"chat-macro"}]);
    assert.deepEqual(result.body.generalMigrationTargets,
      [{sessionKey,sourceKind:"chat-macro-general"}]);
    const paused=await req("migration-pause",{sessionKey});
    assert.equal(paused.status,200);
    assert.equal(paused.body.macroSession,true);
    assert.equal((await req("macro-state")).body.sessions[0].status,"migrating");
    assert.equal((await sync(hashB)).status,200);
    assert.equal((await req("macro-state")).body.sessions[0].enabled,true);
    const resumed=await req("migration-resume",{sessionKey});
    assert.equal(resumed.status,200);
    assert.equal(resumed.body.resumed,true);
    const current=(await req("macro-state")).body.sessions[0];
    assert.equal(current.approvedUrlHash,hashB);
    assert.equal(current.status,"armed");
    assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).workstreams.length,0);
    const second=await req("migration-resume",{sessionKey});
    assert.equal(second.status,400);
    assert.equal((await req("macro-configure",{sessionKey,enabled:true,mode:"auto",
      repository:"owner/repo",intervalMinutes:1})).status,200);
    const failure=await req("macro-migration-failure",{
      sessionKey,reason:"GENERIC_MIGRATION_NEEDS_ATTENTION"});
    assert.equal(failure.status,200);
    assert.equal(failure.body.accepted,true);
    const failedState=(await req("macro-state")).body;
    assert.equal(failedState.sessions[0].enabled,false);
    assert.equal(failedState.alerts.length,1);
  }finally{
    child.kill();if(child.exitCode===null)await once(child,"exit");
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

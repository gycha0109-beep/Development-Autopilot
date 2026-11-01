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
    ...(token?{Authorization:"Bearer "+token}:{})},
  body:JSON.stringify(body)
});

test("standalone no-repository chat migrates through authenticated HTTP and preserves global stop",{
  timeout:20000
},async()=>{
  const temp=mkdtempSync(join(tmpdir(),"autopilot-generic-chat-http-"));
  const port=await new Promise(resolve=>{
    const server=createServer();
    server.listen(0,"127.0.0.1",()=>{
      const p=server.address().port;server.close(()=>resolve(p));
    });
  });
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,AUTOPILOT_PORT:String(port),
      AUTOPILOT_DB:join(temp,"isolated.sqlite3"),
      AUTOPILOT_TELEGRAM_ENABLED:"0",AUTOPILOT_MACRO_ALERTS_ENABLED:"0",
      AUTOPILOT_CI_ALERTS_ENABLED:"0"},stdio:"ignore"
  });
  try{
    let ready=false;
    for(let i=0;i<70;i++){
      try{if((await fetch(base+"/api/v1/snapshot")).ok){ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.equal(ready,true);
    const start=await post(base,"/api/v1/bridge/pairing/start",{});
    assert.equal(start.status,200);
    const code=(await start.json()).code;
    const paired=await fetch(base+"/api/v1/bridge/pair",{
      method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},
      body:JSON.stringify({code})
    });
    assert.equal(paired.status,200);
    const token=(await paired.json()).token;
    const req=async(route,body={})=>{
      const r=await post(base,"/api/v1/bridge/"+route,body,token);
      return {status:r.status,body:await r.json()};
    };
    const sessionKey="plain-chat",sourceHash="a".repeat(64),targetHash="b".repeat(64);
    const sync=hash=>req("sync",{version:1,
      composerBuild:"composer-2026-10-15-r17",
      sessions:[{sessionKey,groupKey:"",groupLabel:"Standalone",
        title:"Plain Chat",status:"connected",
        origin:"https://chatgpt.com",urlHash:hash}]});
    assert.equal((await sync(sourceHash)).status,200);
    const configured=await req("macro-configure",{
      sessionKey,enabled:true,mode:"auto",intervalMinutes:1
    });
    assert.equal(configured.status,200);
    assert.equal((await req("macro-state")).body.sessions[0].repository,null);
    const initial=await sync(sourceHash);
    assert.equal(initial.status,200);
    assert.deepEqual(initial.body.migrationTargets,[]);
    assert.deepEqual(initial.body.generalMigrationTargets,[{
      sessionKey,sourceKind:"chat-macro-general",migrationStatus:"armed"
    }]);
    assert.equal((await req("migration-pause",{sessionKey,generic:true})).status,200);
    const paused=(await req("macro-state")).body.sessions[0];
    assert.equal(paused.status,"migrating");
    assert.equal(paused.enabled,true);
    assert.equal((await sync(targetHash)).status,200);
    assert.deepEqual((await sync(targetHash)).body.generalMigrationTargets,[{
      sessionKey,sourceKind:"chat-macro-general",migrationStatus:"migrating"
    }]);
    const resumed=await req("migration-resume",{sessionKey,generic:true});
    assert.equal(resumed.status,200);
    assert.equal(resumed.body.resumed,true);
    const current=(await req("macro-state")).body.sessions[0];
    assert.equal(current.approvedUrlHash,targetHash);
    assert.equal(current.status,"armed");
    const snapshot=await (await fetch(base+"/api/v1/snapshot")).json();
    assert.equal(snapshot.workstreams.length,0);
    assert.equal(snapshot.chromeBridge.sessions[0].groupKey,"");
    assert.equal(snapshot.globalStopped,false);
    assert.equal((await req("migration-pause",{sessionKey,generic:true})).status,200);
    const fail=await req("macro-migration-failure",{
      sessionKey,reason:"GENERIC_MIGRATION_NEEDS_ATTENTION"
    });
    assert.equal(fail.status,200);
    assert.equal(fail.body.accepted,true);
    const afterFailure=(await req("macro-state")).body;
    assert.equal(afterFailure.sessions[0].enabled,false);
    assert.equal(afterFailure.alerts.length,1);
    assert.equal((await req("macro-migration-failure",{
      sessionKey,reason:"GENERIC_MIGRATION_NEEDS_ATTENTION"
    })).body.accepted,false);
    assert.equal((await req("macro-state")).body.alerts.length,1);
    const stop=await post(base,"/api/v1/control",{stopped:true});
    assert.equal(stop.status,200);
    assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).globalStopped,true);
    assert.equal((await req("macro-claim")).body.command,null);
    assert.equal((await req("macro-send",{sessionKey,macroKey:"general"})).status,400);
  }finally{
    child.kill();
    if(child.exitCode===null)await once(child,"exit");
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

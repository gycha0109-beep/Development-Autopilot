import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {WorkstreamStore} from "../local/store.js";

const extensionOrigin="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
test("authenticated Chrome popup can list/add/link repositories with CI Core absent",{
  timeout:25000
},async()=>{
  const temp=mkdtempSync(join(tmpdir(),"autopilot-independent-repositories-"));
  const db=join(temp,"db.sqlite3");
  const store=new WorkstreamStore(db);
  store.create({name:"Existing",projectKey:"existing",repository:"existing/work",
    mode:"observe"},1_000_000);
  store.close();
  const port=await new Promise(resolve=>{
    const sock=createServer();sock.listen(0,"127.0.0.1",()=>{
      const p=sock.address().port;sock.close(()=>resolve(p));
    });
  });
  const base="http://127.0.0.1:"+port;
  const server=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,AUTOPILOT_PORT:String(port),
      AUTOPILOT_DB:db,AUTOPILOT_TELEGRAM_ENABLED:"0",
      AUTOPILOT_CI_ALERTS_ENABLED:"0",AUTOPILOT_MACRO_ALERTS_ENABLED:"0"},
    stdio:"ignore"
  });
  try{
    let ready=false;
    for(let i=0;i<70;i++){
      try{if((await fetch(base+"/api/v1/snapshot")).ok){ready=true;break;}}
      catch{}
      await new Promise(r=>setTimeout(r,80));
    }
    assert.equal(ready,true);
    const request=async(path,payload={},token=null,origin=token?extensionOrigin:base)=>{
      const response=await fetch(base+path,{method:"POST",headers:{
        Origin:origin,"Content-Type":"application/json",
        ...(token?{Authorization:"Bearer "+token}:{})
      },body:JSON.stringify(payload)});
      return {status:response.status,body:await response.json()};
    };
    const pairStart=await request("/api/v1/bridge/pairing/start");
    const paired=await request("/api/v1/bridge/pair",{code:pairStart.body.code},
      null,extensionOrigin);
    assert.equal(paired.status,200);
    const token=paired.body.token;
    const api=(route,payload)=>request("/api/v1/bridge/"+route,payload,token);
    const initial=await api("macro-state");
    assert.equal(initial.status,200);
    assert.deepEqual(initial.body.repositories,["existing/work"]);
    assert.equal(initial.body.repositoryDirectory.ciStatus!=="connected",true);
    assert.equal(initial.body.repositoryDirectory.repositories[0].ciMonitored,false);
    assert.equal((await request("/api/v1/bridge/macro-repository-add",{
      repository:"owner/private"},null,extensionOrigin)).status,401);
    assert.equal((await api("macro-repository-add",{
      repository:"owner/private"})).status,200);
    assert.equal((await api("macro-repository-add",{
      repository:"owner/private"})).status,200);
    const listed=await api("macro-state");
    assert.deepEqual(listed.body.repositories,["existing/work","owner/private"]);
    assert.equal(listed.body.repositoryDirectory.repositories[1].source,"manual");
    assert.equal(listed.body.repositoryDirectory.repositories[1].visibility,"unknown");
    assert.equal((await api("macro-repository-add",{
      repository:"owner/repo/third"})).status,400);
    assert.equal((await api("macro-state")).body.repositories.length,2);
    const hash="a".repeat(64);
    assert.equal((await api("sync",{version:1,
      composerBuild:"composer-2026-10-15-r17",
      sessions:[{sessionKey:"plain-chat",groupKey:"",groupLabel:"",
        title:"Plain",status:"connected",origin:"https://chatgpt.com",
        urlHash:hash}]})).status,200);
    const configured=await api("macro-configure",{
      sessionKey:"plain-chat",enabled:true,mode:"auto",
      intervalMinutes:2,repository:"owner/private"
    });
    assert.equal(configured.status,200);
    assert.equal((await api("macro-state")).body.sessions[0].repository,"owner/private");
    assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).workstreams.length,1);
  }finally{
    server.kill();if(server.exitCode===null)await once(server,"exit");
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const ext="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const sha="b".repeat(64),reply="c".repeat(64);
const post=(base,path,body,origin=base,token)=>fetch(base+path,{
  method:"POST",headers:{Origin:origin,"Content-Type":"application/json",
    ...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
test("real localhost bridge automatically authorizes exactly one verified recovery stop",{
  timeout:22000},async()=>{
  const temp=mkdtempSync(join(tmpdir(),"autopilot-macro-recovery-"));
  const port=await new Promise(resolve=>{
    const s=createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>resolve(p))});
  });
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,AUTOPILOT_PORT:String(port),
      AUTOPILOT_DB:join(temp,"sqlite.db"),AUTOPILOT_TELEGRAM_ENABLED:"0",
      AUTOPILOT_CI_ALERTS_ENABLED:"0"},stdio:"ignore"
  });
  try{
    let ready=false;for(let i=0;i<90;i++){
      try{if((await fetch(base+"/api/v1/snapshot")).ok){ready=true;break}}catch{}
      await new Promise(done=>setTimeout(done,75));
    }
    assert.equal(ready,true);
    let result=await post(base,"/api/v1/bridge/pairing/start",{});
    const code=(await result.json()).code;
    result=await post(base,"/api/v1/bridge/pair",{code},ext);
    const token=(await result.json()).token;
    const request=async(path,payload)=>{
      const r=await post(base,"/api/v1/bridge/"+path,payload,ext,token);
      return {status:r.status,body:await r.json()};
    };
    const session="macro-network";
    result=await post(base,"/api/v1/bridge/sync",{version:1,
      composerBuild:"composer-2026-10-15-r17",
      sessions:[{sessionKey:session,groupKey:"group",title:"Network",
        status:"connected",groupLabel:"Network",origin:"https://chatgpt.com",
        urlHash:"a".repeat(64)}]},ext,token);
    assert.equal(result.status,200);
    const config=await request("macro-configure",{sessionKey:session,enabled:true,mode:"auto",intervalMinutes:1});
    assert.equal(config.status,200);
    const syn=await request("sync",{version:1,composerBuild:"composer-2026-10-15-r17",
      sessions:[{sessionKey:session,groupKey:"group",title:"Network",
        status:"connected",groupLabel:"Network",origin:"https://chatgpt.com",
        urlHash:"a".repeat(64)}]});
    const probe=syn.body.macroObservationRequests.find(x=>x.sessionKey===session);
    assert.ok(probe);
    const observation={schemaVersion:1,sourceVersion:"chat-observer-1",
      source:"chatgpt-dom",verified:true,observedAt:Date.now(),
      bindingFingerprint:sha,replyFingerprint:reply,connectionWarning:true,
      assistantBusy:true,stopControlVerified:true,composerHasDraft:false,
      humanActionCue:false,providerRestriction:false,uiAmbiguous:false,
      lengthWarning:false,otherWarning:false,ciWaitCue:false,scopeCompleteCue:false,
      contentComplete:false};
    const seen=await request("macro-observation",{requestId:probe.requestId,observation});
    assert.equal(seen.status,200);
    assert.equal(seen.body.recovery,"recovering");
    assert.equal(seen.body.recoveryAction.kind,"verified-disconnect-stop");
    const op=seen.body.recoveryAction.operationId;
    let auth=await request("macro-recovery-authorize",
      {operationId:op,sessionKey:session,bindingFingerprint:sha,observation});
    assert.equal(auth.body.authorized,true);
    auth=await request("macro-recovery-authorize",
      {operationId:op,sessionKey:session,bindingFingerprint:sha,observation});
    assert.equal(auth.body.authorized,false);
    const ack=await request("macro-recovery-ack",{operationId:op,outcome:"clicked"});
    assert.equal(ack.status,200);
    const duplicate=await request("macro-recovery-ack",{operationId:op,outcome:"clicked"});
    assert.equal(duplicate.status,400);
    const current=await request("macro-state",{});
    assert.equal(current.body.sessions[0].enabled,true);
    assert.equal(current.body.recoveries[0].operationState,undefined);
    // Global stop cannot authorize any effect even with a valid-looking retry request.
    const stopped=await post(base,"/api/v1/control",{stopped:true});
    assert.equal(stopped.status,200);
    auth=await request("macro-recovery-authorize",
      {operationId:op,sessionKey:session,bindingFingerprint:sha,observation});
    assert.equal(auth.body.authorized,false);
  }finally{
    child.kill();if(child.exitCode===null)await once(child,"exit");
    rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
});

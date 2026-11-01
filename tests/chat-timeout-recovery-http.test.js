import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const ext="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
async function server(t){
  const dir=mkdtempSync(join(tmpdir(),"chat-timeout-standalone-"));
  const port=await new Promise(ok=>{
    const s=createServer();s.listen(0,"127.0.0.1",()=>{
      const p=s.address().port;s.close(()=>ok(p));
    });
  });
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,
      AUTOPILOT_PORT:String(port),AUTOPILOT_DB:join(dir,"db.sqlite3"),
      AUTOPILOT_TELEGRAM_ENABLED:"0",AUTOPILOT_MACRO_ALERTS_ENABLED:"0",
      AUTOPILOT_CI_ALERTS_ENABLED:"0"},stdio:"ignore"
  });
  t.after(async()=>{
    child.kill();if(child.exitCode===null)await once(child,"exit");
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  for(let i=0;i<80;i++){
    try{if((await fetch(base+"/api/v1/snapshot")).ok)return base;}catch{}
    await new Promise(r=>setTimeout(r,80));
  }
  throw Error("SERVER_NOT_READY");
}
test("timeout UI queues fixed continuation immediately, never requests stop, without Workstream",{
  timeout:22000},async t=>{
  const base=await server(t);
  const request=async(route,body={},token=null,origin=token?ext:base)=>{
    const r=await fetch(base+route,{method:"POST",
      headers:{Origin:origin,"Content-Type":"application/json",
        ...(token?{Authorization:"Bearer "+token}:{})},body:JSON.stringify(body)});
    return {status:r.status,body:await r.json()};
  };
  const code=(await request("/api/v1/bridge/pairing/start")).body.code;
  const pair=await request("/api/v1/bridge/pair",{code},null,ext);
  assert.equal(pair.status,200);
  const token=pair.body.token;
  const post=(suffix,body)=>request("/api/v1/bridge/"+suffix,body,token);
  const sessionKey="timeout-chat",hash="a".repeat(64);
  const sync=()=>post("sync",{version:1,composerBuild:"composer-2026-10-15-r17",
    sessions:[{sessionKey,groupKey:"",groupLabel:"Standalone",status:"connected",
      title:"Recovery Chat",origin:"https://chatgpt.com",urlHash:hash}]});
  assert.equal((await sync()).status,200);
  assert.equal((await post("macro-configure",{
    sessionKey,enabled:true,mode:"auto",intervalMinutes:1})).status,200);
  let challenge=(await sync()).body.macroObservationRequests.find(x=>x.sessionKey===sessionKey);
  assert.ok(challenge);
  const obs={schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
    verified:true,observedAt:Date.now(),bindingFingerprint:"b".repeat(64),
    replyFingerprint:null,connectionWarning:true,connectionWarningKind:"send_timeout",
    recoveryWarningSafe:true,assistantBusy:false,stopControlVerified:false,
    composerHasDraft:false,contentComplete:false,uiAmbiguous:true,
    lengthWarning:false,otherWarning:false,humanActionCue:false,
    providerRestriction:false,ciWaitCue:false,scopeCompleteCue:false};
  const queued=await post("macro-observation",{
    requestId:challenge.requestId,observation:obs});
  assert.equal(queued.status,200);
  assert.equal(queued.body.queued,true);
  assert.equal(queued.body.macroKey,"network");
  assert.equal(queued.body.recoveryAction,undefined);
  const claimed=(await post("macro-claim",{})).body.command;
  assert.equal(claimed.message,"현황 파악하고 계속 진행");
  assert.equal(claimed.recoveryProof.kind,"send_timeout");
  assert.equal(claimed.observationProof,null);
  const ack=await post("macro-ack",{
    id:claimed.id,status:"blocked",reason:"RECOVERY_PRECONDITION_CHANGED"});
  assert.equal(ack.status,200);
  const state=(await post("macro-state")).body;
  assert.equal(state.sessions[0].enabled,true);
  assert.equal(state.sessions[0].reason,"RECOVERY_REOBSERVE");
  assert.equal(state.commands[0].state,"blocked");
  assert.equal((await (await fetch(base+"/api/v1/snapshot")).json()).workstreams.length,0);
  const stopped=await request("/api/v1/control",{stopped:true});
  assert.equal(stopped.status,200);
  challenge=(await sync()).body.macroObservationRequests.find(x=>x.sessionKey===sessionKey);
  assert.ok(challenge);
  const denied=await post("macro-observation",{
    requestId:challenge.requestId,observation:{...obs,observedAt:Date.now()}});
  assert.equal(denied.body.queued,false);
  assert.equal(denied.body.reason,"GLOBAL_STOP_ACTIVE");
  assert.equal((await post("macro-claim")).body.command,null);
});

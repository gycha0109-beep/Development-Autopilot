import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const extension="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const submit=(base,path,data,origin=base,token=null)=>fetch(base+path,{
  method:"POST",headers:{"Origin":origin,"Content-Type":"application/json",
    ...(token?{"Authorization":"Bearer "+token}:{})},body:JSON.stringify(data)});
async function setupServer(t){
  const dir=mkdtempSync(join(tmpdir(),"autopilot-macro-http-"));
  const port=await new Promise(resolve=>{
    const server=createServer();
    server.listen(0,"127.0.0.1",()=>{
      const p=server.address().port;server.close(()=>resolve(p));
    });
  });
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:process.cwd(),env:{...process.env,
      AUTOPILOT_DB:join(dir,"db.sqlite3"),AUTOPILOT_PORT:String(port),
      AUTOPILOT_CI_ALERTS_ENABLED:"0",AUTOPILOT_TELEGRAM_ENABLED:"0"},
    stdio:"ignore"
  });
  t.after(async()=>{
    child.kill();
    if(child.exitCode===null)await once(child,"exit");
    rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  });
  for(let i=0;i<100;i++){
    try{if((await fetch(base+"/api/v1/snapshot")).ok)return base;}
    catch{}
    await new Promise(resolve=>setTimeout(resolve,60));
  }
  throw Error("LOCAL_SERVER_NOT_READY");
}
test("chat-only macros do not create a Workstream, require paired extension and global STOP",{
  timeout:24000},async t=>{
  const base=await setupServer(t),URL="a".repeat(64);
  let response=await submit(base,"/api/v1/bridge/macro-state",{},extension);
  assert.equal(response.status,401);
  response=await submit(base,"/api/v1/bridge/macro-state",{},"https://untrusted.example");
  assert.equal(response.status,403);
  response=await submit(base,"/api/v1/bridge/pairing/start",{});
  const pairing=(await response.json()).code;
  response=await submit(base,"/api/v1/bridge/pair",{code:pairing},extension);
  const token=(await response.json()).token;
  const send=(path,payload={})=>submit(base,"/api/v1/bridge/"+path,payload,extension,token);
  response=await send("macro-configure",{sessionKey:"tab1",enabled:true,mode:"auto",intervalMinutes:1});
  assert.equal(response.status,400);
  response=await send("sync",{version:1,composerBuild:"composer-2026-10-15-r17",
    sessions:[{sessionKey:"tab1",groupKey:"group1",groupLabel:"Work",title:"Dev Chat",
      origin:"https://chatgpt.com",status:"connected",urlHash:URL}]});
  assert.equal(response.status,200);
  response=await send("macro-configure",{sessionKey:"tab1",enabled:true,mode:"auto",intervalMinutes:1});
  assert.equal(response.status,200);
  assert.equal((await response.json()).config.enabled,true);
  response=await send("macro-state");
  const state=await response.json();
  assert.equal(state.sessions.length,1);
  assert.equal(state.templates.general.length>10,true);
  response=await fetch(base+"/api/v1/snapshot");
  assert.equal((await response.json()).workstreams.length,0);
  response=await submit(base,"/api/v1/control",{stopped:true});
  assert.equal(response.status,200);
  response=await send("macro-send",{sessionKey:"tab1",macroKey:"general"});
  assert.equal(response.status,400);
  assert.match((await response.json()).error,/GLOBAL_STOP_ACTIVE/);
  response=await send("macro-claim");
  assert.equal((await response.json()).command,null);
  response=await submit(base,"/api/v1/control",{stopped:false});
  assert.equal(response.status,200);
  response=await send("macro-send",{sessionKey:"tab1",macroKey:"general"});
  assert.equal(response.status,200);
  const queued=(await response.json()).command;
  response=await send("macro-send",{sessionKey:"tab1",macroKey:"network"});
  assert.equal(response.status,400);
  response=await send("macro-claim");
  const claimed=(await response.json()).command;
  assert.equal(claimed.id,queued.id);
  assert.equal(claimed.observationProof,null);
  response=await send("macro-ack",{id:claimed.id,status:"sent",reason:"SUBMITTED"});
  assert.equal(response.status,200);
  response=await send("macro-claim");
  assert.equal((await response.json()).command,null);
  response=await fetch(base+"/api/v1/snapshot");
  assert.equal((await response.json()).workstreams.length,0);
  response=await send("macro-template",{macroKey:"general",prompt:"새로운 진행 문구"});
  assert.equal(response.status,200);
  assert.equal((await response.json()).template.prompt,"새로운 진행 문구");
  response=await send("macro-stop",{sessionKey:"tab1"});
  assert.equal((await response.json()).config.enabled,false);
  response=await send("macro-send",{sessionKey:"tab1",macroKey:"general"});
  assert.equal(response.status,400);
  response=await send("macro-configure",{sessionKey:"tab1",enabled:true,mode:"manual",intervalMinutes:1});
  assert.equal(response.status,200);
  response=await send("sync",{version:1,composerBuild:"composer-2026-10-15-r17",
    sessions:[{sessionKey:"tab1",groupKey:"group1",groupLabel:"Work",title:"Dev Chat",
      origin:"https://chatgpt.com",status:"connected",urlHash:"b".repeat(64)}]});
  assert.equal(response.status,200);
  response=await send("macro-state");
  assert.equal((await response.json()).sessions[0].enabled,false);
  response=await send("macro-configure",{sessionKey:"tab1",enabled:true,mode:"manual",intervalMinutes:1});
  assert.equal(response.status,200);
  response=await submit(base,"/api/v1/bridge/pairing/start",{});
  const nextCode=(await response.json()).code;
  response=await submit(base,"/api/v1/bridge/pair",{code:nextCode},extension);
  assert.equal(response.status,200);
  response=await submit(base,"/api/v1/snapshot",{dummy:true});
  assert.equal(response.status,404);
});

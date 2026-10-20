import { CHAT_COMPOSER_BUILD } from "../extension/chat-page.js";
import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
const extensionOrigin="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
async function openPort(){
  const s=createServer();return new Promise((resolve,reject)=>{
    s.once("error",reject);s.listen(0,"127.0.0.1",()=>{
      const p=s.address().port;s.close(()=>resolve(p));
    });
  });
}
async function ready(url,child){
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw Error("server exited");
    try{const r=await fetch(url+"/api/v1/snapshot");if(r.ok)return;}
    catch{}
    await new Promise(r=>setTimeout(r,85));
  }
  throw Error("server startup timeout");
}
function post(base,path,payload,origin=base,token){
  return fetch(base+path,{method:"POST",headers:{
    Origin:origin,"Content-Type":"application/json",
    ...(token?{Authorization:"Bearer "+token}:{})
  },body:JSON.stringify(payload)});
}

test("production HTTP observation needs same-origin permission and paired exact-client challenge",{timeout:15000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-observe-http-"));
  const p=await openPort(),base="http://127.0.0.1:"+p;
  const child=spawn(process.execPath,["local/server.js"],{cwd:fileURLToPath(new URL("../",import.meta.url)),
    env:{...process.env,AUTOPILOT_PORT:String(p),AUTOPILOT_DB:join(dir,"test.sqlite3")},stdio:"ignore"});
  try{
    await ready(base,child);
    assert.equal((await post(base,"/api/v1/workstreams",{id:"observed",name:"Observed",projectKey:"project",repository:"owner/repo"})).status,201);
    const code=(await (await post(base,"/api/v1/bridge/pairing/start",{})).json()).code;
    const token=(await (await post(base,"/api/v1/bridge/pair",{code},extensionOrigin)).json()).token;
    const sync=()=>post(base,"/api/v1/bridge/sync",{version:1,composerBuild:CHAT_COMPOSER_BUILD,sessions:[{
      sessionKey:"session",groupKey:"group",title:"test",origin:"https://chatgpt.com",status:"connected"}]},extensionOrigin,token);
    await sync();
    await post(base,"/api/v1/workstreams/observed/link-chrome",{extensionId:extensionOrigin.slice(19),sessionKey:"session"});
    const permission={workstreamId:"observed",observationPermitted:true};
    assert.equal((await post(base,"/api/v1/autopilot/observe",permission,"https://unrelated.invalid")).status,403);
    assert.equal((await post(base,"/api/v1/operator-inbox/command",{command:"resume"},"https://unrelated.invalid")).status,403);
    assert.equal((await post(base,"/api/v1/operator-inbox/command",{command:"resume"})).status,400);
    assert.equal((await post(base,"/api/v1/autopilot/observe",{workstreamId:"observed"})).status,400);
    assert.equal((await post(base,"/api/v1/autopilot/observe",permission)).status,200);
    const requests=(await (await sync()).json()).observationRequests;assert.equal(requests.length,1);
    const {observation}=await import("../test-support/autopilot-fixture.js");
    const payload={requestId:requests[0].requestId,observation:observation({text:"PRIVATE_TRANSCRIPT"})};
    assert.equal((await post(base,"/api/v1/bridge/observations",payload,extensionOrigin,"wrong-token")).status,401);
    assert.equal((await post(base,"/api/v1/bridge/observations",payload,extensionOrigin,token)).status,200);
    assert.equal((await post(base,"/api/v1/bridge/observations",payload,extensionOrigin,token)).status,400);
    const snapshot=await (await fetch(base+"/api/v1/snapshot")).json();
    assert.equal(snapshot.autopilot.scopes.find(s=>s.workstreamId==="observed").observation.verified,true);
    assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE_TRANSCRIPT/);
    assert.equal(snapshot.chatContinuation.commands.length,0);
  }finally{
    child.kill();await new Promise(resolve=>child.exitCode!==null?resolve():child.once("exit",resolve));
    rmSync(dir,{recursive:true,force:true});
  }
});
test("local Chrome continuation requires exact paired identity, approval and single receipt; unrelated origins cannot send",{
  timeout:35000
},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-chat-http-"));
  const p=await openPort(),base="http://127.0.0.1:"+p;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:fileURLToPath(new URL("../",import.meta.url)),
    env:{...process.env,AUTOPILOT_PORT:String(p),AUTOPILOT_DB:join(dir,"test.sqlite3")},
    stdio:["ignore","pipe","pipe"]
  });
  try{
    await ready(base,child);
    let r=await post(base,"/api/v1/workstreams",{
      id:"build",name:"BuildMap",projectKey:"build",repository:"owner/BuildMap"
    });
    assert.equal(r.status,201);
    r=await post(base,"/api/v1/chat-continuation/configure",{
      workstreamId:"build",enabled:true,mode:"manual",
      message:"확인하고 계속 진행",intervalMinutes:10,hours:8,maxMessages:3
    });
    assert.equal(r.status,400); // not paired

    const pairing=await post(base,"/api/v1/bridge/pairing/start",{});
    assert.equal(pairing.status,200);
    const code=(await pairing.json()).code;
    const paired=await post(base,"/api/v1/bridge/pair",{code},extensionOrigin);
    assert.equal(paired.status,200);
    const token=(await paired.json()).token;
    r=await post(base,"/api/v1/bridge/sync",{
      version:1,composerBuild:CHAT_COMPOSER_BUILD,sessions:[{
        sessionKey:"tab-one",groupKey:"group-one",groupLabel:"Project",
        title:"Existing conversation",origin:"https://chatgpt.com",status:"connected"
      }]
    },extensionOrigin,token);
    assert.equal(r.status,200);
    r=await post(base,"/api/v1/workstreams/build/link-chrome",{
      extensionId:extensionOrigin.slice("chrome-extension://".length),
      sessionKey:"tab-one"
    });
    assert.equal(r.status,200);
    r=await post(base,"/api/v1/chat-continuation/configure",{
      workstreamId:"build",enabled:true,mode:"manual",
      message:"확인하고 계속 진행",intervalMinutes:10,hours:8,maxMessages:3
    },"https://untrusted.test");
    assert.equal(r.status,403);
    r=await post(base,"/api/v1/chat-continuation/configure",{
      workstreamId:"build",enabled:true,mode:"manual",
      message:"확인하고 계속 진행",intervalMinutes:10,hours:8,maxMessages:3
    });
    assert.equal(r.status,200);
    r=await post(base,"/api/v1/chat-continuation/send-now",{workstreamId:"build"});
    assert.equal(r.status,200);
    const cmd=(await r.json()).command;
    assert.ok(cmd.id);

    r=await post(base,"/api/v1/bridge/commands",{},extensionOrigin,"not-valid");
    assert.equal(r.status,401);
    r=await post(base,"/api/v1/bridge/commands",{},"https://untrusted.test",token);
    assert.equal(r.status,403);
    r=await post(base,"/api/v1/bridge/commands",{},extensionOrigin,token);
    assert.equal(r.status,200);
    const claim=(await r.json()).command;
    assert.equal(claim.id,cmd.id);
    assert.equal(claim.message,"확인하고 계속 진행");
    assert.equal(claim.sessionKey,"tab-one");
    r=await post(base,"/api/v1/bridge/commands",{},extensionOrigin,token);
    assert.equal((await r.json()).command,null);

    r=await post(base,"/api/v1/bridge/ack",{
      id:cmd.id,status:"sent",reason:"SEND_BUTTON_CLICKED_UNVERIFIED"
    },extensionOrigin,token);
    assert.equal(r.status,200);
    assert.equal((await r.json()).state,"sent");
    r=await post(base,"/api/v1/bridge/ack",{
      id:cmd.id,status:"sent",reason:"SEND_BUTTON_CLICKED_UNVERIFIED"
    },extensionOrigin,token);
    assert.equal(r.status,400);
    r=await fetch(base+"/api/v1/snapshot");
    const snap=await r.json();
    const cfg=snap.chatContinuation.configs.find(c=>c.workstreamId==="build");
    assert.equal(cfg.sentCount,1);
    assert.equal(cfg.intervalMinutes,10);
    assert.equal(cfg.message,"확인하고 계속 진행");
    assert.ok(cfg.nextDueAt>=cfg.lastSentAt+10*60_000);
    assert.equal(cfg.enabled,true);
    assert.equal(cfg.statusReason,"MESSAGE_SUBMITTED_NOT_RESPONSE_VERIFIED");
    assert.equal(snap.chatContinuation.commands.length,1);
    assert.equal(snap.chatContinuation.commands[0].state,"sent");
    assert.equal(snap.chatContinuation.commands[0].message,undefined);
    r=await post(base,"/api/v1/chat-continuation/stop",{workstreamId:"build"});
    assert.equal(r.status,200);
    assert.equal((await r.json()).config.enabled,false);
    r=await post(base,"/api/v1/chat-continuation/send-now",{workstreamId:"build"});
    assert.equal(r.status,400);
  }finally{
    child.kill();
    await new Promise(resolve=>{
      if(child.exitCode!==null)return resolve();
      child.once("exit",resolve);
      setTimeout(resolve,2000).unref();
    });
    rmSync(dir,{recursive:true,force:true});
  }
});

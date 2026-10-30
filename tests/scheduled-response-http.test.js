import test from "node:test";
import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {createServer} from "node:net";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
const EXT="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ID="abcdefghijklmnopabcdefghijklmnop";
async function port(){
  const server=createServer();
  return new Promise(resolve=>server.listen(0,"127.0.0.1",()=>{
    const p=server.address().port;server.close(()=>resolve(p));
  }));
}
const post=(base,path,body,origin=base,token)=>fetch(base+path,{
  method:"POST",headers:{"Content-Type":"application/json",Origin:origin,
    ...(token?{Authorization:"Bearer "+token}:{})},
  body:JSON.stringify(body)
});
test("read-only completion challenges require exact paired extension, bound session and valid proof",{
  timeout:30000
},async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-response-http-"));
  const p=await port(),base="http://127.0.0.1:"+p;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:fileURLToPath(new URL("../",import.meta.url)),
    env:{...process.env,AUTOPILOT_PORT:String(p),AUTOPILOT_DB:join(dir,"test.sqlite3")},
    stdio:"ignore"
  });
  try{
    let live=false;
    for(let attempt=0;attempt<80;attempt++){
      try{live=(await fetch(base+"/api/v1/snapshot")).ok;if(live)break;}
      catch{}
      await new Promise(resolve=>setTimeout(resolve,80));
    }
    assert.equal(live,true);
    assert.equal((await post(base,"/api/v1/workstreams",{
      id:"pie",name:"PIE",projectKey:"pie",repository:"owner/pie"
    })).status,201);
    const code=(await (await post(base,"/api/v1/bridge/pairing/start",{})).json()).code;
    const token=(await (await post(base,"/api/v1/bridge/pair",{code},EXT)).json()).token;
    const sessions=[{sessionKey:"pie-tab",groupKey:"pie-group",groupLabel:"PIE",
      title:"PIE data",origin:"https://chatgpt.com",status:"connected"}];
    assert.equal((await post(base,"/api/v1/bridge/sync",{
      version:1,composerBuild:"composer-2026-10-15-r17",sessions
    },EXT,token)).status,200);
    assert.equal((await post(base,"/api/v1/workstreams/pie/link-chrome",{
      extensionId:ID,sessionKey:"pie-tab"
    })).status,200);
    assert.equal((await post(base,"/api/v1/chat-continuation/configure",{
      workstreamId:"pie",enabled:true,mode:"scheduled",
      message:"로드맵 따라서 계속 진행",intervalMinutes:10
    })).status,200);
    const sync=await post(base,"/api/v1/bridge/sync",{
      version:1,composerBuild:"composer-2026-10-15-r17",sessions
    },EXT,token);
    assert.equal(sync.status,200);
    const requests=(await sync.json()).observationRequests;
    assert.equal(requests.length,1);
    assert.equal(requests[0].sessionKey,"pie-tab");
    const challenge=requests[0].requestId;
    assert.equal((await post(base,"/api/v1/bridge/observations",{
      requestId:challenge,observation:{verified:true}
    },"https://malicious.example",token)).status,403);
    assert.equal((await post(base,"/api/v1/bridge/observations",{
      requestId:challenge,observation:{verified:true}
    },EXT,"wrong")).status,401);
    const result=await post(base,"/api/v1/bridge/observations",{
      requestId:challenge,observation:{verified:true}
    },EXT,token);
    assert.equal(result.status,200);
    assert.equal((await result.json()).accepted,false);
    assert.equal((await post(base,"/api/v1/bridge/observations",{
      requestId:challenge,observation:{verified:true}
    },EXT,token)).status,400);
    const state=await (await fetch(base+"/api/v1/snapshot")).json();
    assert.equal(state.chatContinuation.commands.length,0);
    assert.equal(state.chatContinuation.observations[0].ready,false);
  }finally{
    child.kill();
    await new Promise(resolve=>{
      if(child.exitCode!==null)return resolve();
      child.once("exit",resolve);setTimeout(resolve,2000).unref();
    });
    rmSync(dir,{recursive:true,force:true});
  }
});

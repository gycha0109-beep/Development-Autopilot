import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const chromeOrigin="chrome-extension://abcdefghijklmnopabcdefghijklmnop";
async function availablePort(){
  return new Promise((resolve,reject)=>{
    const s=createServer();s.once("error",reject);
    s.listen(0,"127.0.0.1",()=>{
      const port=s.address().port;s.close(()=>resolve(port));
    });
  });
}
async function awaitReady(base,child){
  for(let i=0;i<80;i++){
    if(child.exitCode!==null)throw Error("server exited");
    try{ const r=await fetch(base+"/api/v1/snapshot");if(r.ok)return; }
    catch{}
    await new Promise(resolve=>setTimeout(resolve,90));
  }
  throw Error("server startup timeout");
}
function send(base,path,body,origin,token){
  return fetch(base+path,{
    method:"POST",headers:{
      "Content-Type":"application/json","Origin":origin,
      ...(token?{Authorization:"Bearer "+token}:{})
    },body:JSON.stringify(body)
  });
}
test("paired Chrome extension can sync only registered sessions; other origins and invalid credentials are denied",
  {timeout:35000}, async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-bridge-http-"));
  const port=await availablePort();
  const base="http://127.0.0.1:"+port;
  const child=spawn(process.execPath,["local/server.js"],{
    cwd:fileURLToPath(new URL("../",import.meta.url)),
    env:{...process.env,AUTOPILOT_PORT:String(port),AUTOPILOT_DB:join(dir,"db.sqlite3")},
    stdio:["ignore","pipe","pipe"]
  });
  try{
    await awaitReady(base,child);
    const options=await fetch(base+"/api/v1/bridge/pair",{method:"OPTIONS",headers:{
      Origin:chromeOrigin,"Access-Control-Request-Method":"POST","Access-Control-Request-Headers":"content-type"
    }});
    assert.equal(options.status,204);
    assert.equal(options.headers.get("access-control-allow-origin"),chromeOrigin);
    const evilOptions=await fetch(base+"/api/v1/bridge/sync",{method:"OPTIONS",headers:{
      Origin:"https://evil.test","Access-Control-Request-Method":"POST"
    }});
    assert.equal(evilOptions.status,403);
    assert.equal(evilOptions.headers.get("access-control-allow-origin"),null);

    const evilStart=await send(base,"/api/v1/bridge/pairing/start",{},"https://evil.test");
    assert.equal(evilStart.status,403);
    const pairing=await send(base,"/api/v1/bridge/pairing/start",{},base);
    assert.equal(pairing.status,200);
    const code=(await pairing.json()).code;
    assert.match(code,/^[A-F0-9]{20}$/);

    const evilPair=await send(base,"/api/v1/bridge/pair",{code},"https://evil.test");
    assert.equal(evilPair.status,403);
    const unauthorized=await send(base,"/api/v1/bridge/sync",{version:1,sessions:[]},chromeOrigin);
    assert.equal(unauthorized.status,401);
    const wrong=await send(base,"/api/v1/bridge/pair",{code:"F".repeat(20)},chromeOrigin);
    assert.equal(wrong.status,403);
    const paired=await send(base,"/api/v1/bridge/pair",{code},chromeOrigin);
    assert.equal(paired.status,200);
    const token=(await paired.json()).token;
    assert.ok(token.length>=32);
    const rejected=await send(base,"/api/v1/bridge/sync",{version:1,sessions:[]},chromeOrigin,"invalid");
    assert.equal(rejected.status,401);
    const session={
      sessionKey:"session-one",groupKey:"group-one",groupLabel:"dev",
      title:"BuildMap",origin:"https://chatgpt.com",status:"connected"
    };
    const sync=await send(base,"/api/v1/bridge/sync",{version:1,sessions:[session]},chromeOrigin,token);
    assert.equal(sync.status,200);
    assert.equal((await sync.json()).accepted,1);
    const snapshot=await fetch(base+"/api/v1/snapshot");
    const state=await snapshot.json();
    assert.equal(state.chromeBridge.sessions.length,1);
    assert.equal(state.chromeBridge.sessions[0].status,"connected");
    assert.equal(state.integration.chrome,"connected");

    const create=await send(base,"/api/v1/workstreams",{
      id:"buildmap",name:"BuildMap",projectKey:"buildmap",repository:"owner/repo"
    },base);
    assert.equal(create.status,201);
    const link=await send(base,"/api/v1/workstreams/buildmap/link-chrome",{
      extensionId:chromeOrigin.slice("chrome-extension://".length),
      sessionKey:"session-one"
    },base);
    assert.equal(link.status,200);
    assert.equal((await link.json()).chromeBridge.links[0].status,"connected");

    const unauthorizedLink=await send(base,"/api/v1/workstreams/buildmap/link-chrome",{
      extensionId:chromeOrigin.slice("chrome-extension://".length),
      sessionKey:null
    },chromeOrigin,token);
    assert.equal(unauthorizedLink.status,403);
    const after=await(await fetch(base+"/api/v1/snapshot")).json();
    assert.equal(after.chromeBridge.links.length,1);
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

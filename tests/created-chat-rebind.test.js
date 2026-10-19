import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {WorkstreamStore} from "../local/store.js";
import {ChromeBridge,REQUIRED_COMPOSER_BUILD} from "../local/chrome-bridge.js";
import {ChromeEnrollment} from "../local/chrome-enrollment.js";
import {emptyRegistry} from "../extension/core.js";
import {bridgePayload} from "../extension/bridge-core.js";
import {discoverChatCandidates,enrollApprovedCandidate} from "../extension/remote-enrollment.js";
import {isCreatedChatRoute} from "../extension/chat-routes.js";

const extensionId="abcdefghijklmnopabcdefghijklmnop";
const hashUrl=async url=>createHash("sha256").update(url).digest("hex");
async function fixture(){
  const store=new WorkstreamStore(),bridge=new ChromeBridge(store),calls=[];
  const enrollment=new ChromeEnrollment(store,{bridge,
    beforeRebind:id=>calls.push(["before",id]),afterRebind:id=>calls.push(["after",id])});
  let now=1000,registry=emptyRegistry(),epoch="epoch",saves=0;
  let live={groups:[{id:44,windowId:7,title:"codex_test"}],
    tabs:[{id:19,windowId:7,groupId:44,title:"ChatGPT",url:"https://chatgpt.com/"}]};
  store.create({id:"work",name:"codex_test",projectKey:"codex_test",repository:"owner/repo"},now);
  bridge.pair("chrome-extension://"+extensionId,bridge.beginPairing(now).code,now);
  const sync=async()=>{
    bridge.sync(extensionId,{...bridgePayload(registry,live,epoch),composerBuild:REQUIRED_COMPOSER_BUILD},++now);
    enrollment.ingest(extensionId,{candidates:await discoverChatCandidates(registry,live,epoch,{hashUrl})},now);
  };
  const params={load:async()=>registry,snapshot:async()=>live,epoch:async()=>epoch,
    save:async r=>{registry=r;saves++;},hashUrl,now:()=>now};
  await sync();
  const first=enrollment.begin("work",extensionId,19,await hashUrl(live.tabs[0].url),++now);
  await enrollApprovedCandidate(enrollment.pending(extensionId,now)[0],params);
  await sync();enrollment.acknowledge(extensionId,{id:first.id,status:"applied",sessionKey:first.id},++now);
  const advance=async()=>{live={...live,tabs:[{...live.tabs[0],title:"Test",url:"https://chatgpt.com/c/created"}]};await sync();};
  return {store,bridge,enrollment,calls,params,first,sync,advance,
    get registry(){return registry;},get live(){return live;},get saves(){return saves;},get now(){return now;},
    setLive:value=>{live=value;},setEpoch:value=>{epoch=value;},setRegistry:value=>{registry=value;},
    begin:()=>enrollment.begin("work",extensionId,19,enrollment.getSnapshot(now).candidates[0].urlHash,++now)};
}

test("landing-page transition is restricted to a new conversation in the same project",()=>{
  assert.equal(isCreatedChatRoute("https://chatgpt.com/","https://chatgpt.com/c/new"),true);
  assert.equal(isCreatedChatRoute("https://chatgpt.com/g/g-p-one/project","https://chatgpt.com/g/g-p-one/c/new"),true);
  for(const [before,after] of [
    ["https://chatgpt.com/c/old","https://chatgpt.com/c/new"],
    ["https://chatgpt.com/","https://chatgpt.com/g/g-p-one/c/new"],
    ["https://chatgpt.com/g/g-p-one","https://chatgpt.com/g/g-p-two/c/new"],
    ["https://chatgpt.com/","https://chatgpt.com/c/new?model=x"],
    ["https://chatgpt.com/?model=x","https://chatgpt.com/c/new"],
    ["https://chatgpt.com/","https://other.test/c/new"]
  ])assert.equal(isCreatedChatRoute(before,after),false);
});

test("same-tab creation requires a new explicit intent, preserves session, and repeated delivery is idempotent",async()=>{
  const f=await fixture();try{
    const original=f.registry.sessions[0];
    await f.advance();
    assert.equal(f.bridge.getSnapshot(f.now).links[0].status,"url-changed");
    assert.equal(f.registry.sessions[0].url,"https://chatgpt.com/"); // discovery never changes registration
    const candidate=f.enrollment.getSnapshot(f.now).candidates[0];
    assert.equal(candidate.sessionKey,original.key);
    assert.equal(JSON.stringify(candidate).includes("https://"),false);
    const intent=f.begin(),request=f.enrollment.pending(extensionId,f.now)[0];
    assert.throws(()=>f.enrollment.acknowledge(extensionId,{id:intent.id,status:"applied",sessionKey:original.key,urlHash:request.urlHash},f.now),
      /REGISTERED_SESSION_NOT_CONFIRMED/);
    const applied=await enrollApprovedCandidate(request,f.params);
    assert.equal(applied.sessionKey,original.key);
    assert.equal(f.registry.sessions.length,1);assert.equal(f.registry.groups.length,1);
    assert.equal(f.registry.sessions[0].tabId,original.tabId);
    assert.equal(f.registry.sessions[0].groupKey,original.groupKey);
    const saves=f.saves;
    assert.equal((await enrollApprovedCandidate(request,f.params)).alreadyApplied,true);
    assert.equal(f.saves,saves);
    await f.sync();
    assert.throws(()=>f.enrollment.acknowledge(extensionId,{id:intent.id,status:"applied",sessionKey:original.key,urlHash:"f".repeat(64)},f.now),/SESSION_PROOF_MISMATCH/);
    const ack={id:intent.id,status:"applied",sessionKey:original.key,urlHash:request.urlHash};
    assert.equal(f.enrollment.acknowledge(extensionId,ack,f.now).status,"done");
    assert.equal(f.enrollment.acknowledge(extensionId,ack,f.now).alreadyConfirmed,true);
    assert.deepEqual(f.calls,[["before","work"],["after","work"]]);
    assert.equal(f.bridge.getSnapshot(f.now).links[0].sessionKey,original.key);
    assert.equal(f.enrollment.getSnapshot(f.now).candidates.length,0);
  }finally{f.store.close();}
});

test("changed epochs, groups, source fingerprints and navigation races cannot rebind",async()=>{
  for(const kind of ["epoch","group","source","race","paused","duplicate","expired"]){
    const f=await fixture();try{
      await f.advance();f.begin();const request=f.enrollment.pending(extensionId,f.now)[0];
      let params=f.params;
      if(kind==="epoch")f.setEpoch("different");
      if(kind==="group")f.setLive({...f.live,tabs:[{...f.live.tabs[0],groupId:45}]});
      if(kind==="source")request.previousUrlHash="f".repeat(64);
      if(kind==="expired")request.expiresAt=f.now-1;
      if(kind==="paused")f.setRegistry({...f.registry,sessions:f.registry.sessions.map(s=>({...s,paused:true}))});
      if(kind==="duplicate")f.setRegistry({...f.registry,sessions:[...f.registry.sessions,{...f.registry.sessions[0],key:"another"}]});
      if(kind==="race"){
        let reads=0;
        params={...params,snapshot:async()=>++reads===1?f.live:{...f.live,tabs:[{...f.live.tabs[0],url:"https://chatgpt.com/c/other"}]}};
      }
      const saves=f.saves;
      await assert.rejects(enrollApprovedCandidate(request,params),/ENROLLMENT_/);
      assert.equal(f.saves,saves);
    }finally{f.store.close();}
  }
});

test("server refuses another workstream, altered old URL, another tab, and unconfirmed legacy enrollment",async()=>{
  for(const kind of ["workstream","hash","tab","legacy"]){
    const f=await fixture();try{
      await f.advance();
      if(kind==="workstream")f.store.create({id:"other",name:"other",projectKey:"other",repository:"owner/repo"},f.now);
      if(kind==="hash")f.store.db.prepare("UPDATE chrome_discovery_candidates SET previous_url_hash=?").run("f".repeat(64));
      if(kind==="tab")f.store.db.prepare("UPDATE chrome_discovery_candidates SET tab_id=20").run();
      if(kind==="legacy")f.store.db.prepare("UPDATE chrome_enrollment_intents SET status='failed'").run();
      const c=f.enrollment.getSnapshot(f.now).candidates[0];
      assert.throws(()=>f.enrollment.begin(kind==="workstream"?"other":"work",extensionId,c.tabId,c.urlHash,f.now),/REBIND_NOT_ALLOWED/);
      assert.equal(f.registry.sessions[0].url,"https://chatgpt.com/");
      assert.equal(f.calls.length,0);
    }finally{f.store.close();}
  }
});

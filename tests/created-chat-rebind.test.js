import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {WorkstreamStore} from "../local/store.js";
import {ChromeBridge,REQUIRED_COMPOSER_BUILD} from "../local/chrome-bridge.js";
import {ChromeEnrollment} from "../local/chrome-enrollment.js";
import {emptyRegistry} from "../extension/core.js";
import {bridgePayload} from "../extension/bridge-core.js";
import {discoverChatCandidates,enrollApprovedCandidate} from "../extension/remote-enrollment.js";
import {isCreatedChatRoute,isSameExistingChatRoute} from "../extension/chat-routes.js";

const extensionId="abcdefghijklmnopabcdefghijklmnop";
const hashUrl=async url=>createHash("sha256").update(url).digest("hex");
async function fixture({url='https://chatgpt.com/'}={}){
  const store=new WorkstreamStore(),bridge=new ChromeBridge(store),calls=[];
  const enrollment=new ChromeEnrollment(store,{bridge,
    beforeRebind:id=>calls.push(["before",id]),afterRebind:id=>calls.push(["after",id])});
  let now=1000,registry=emptyRegistry(),epoch="epoch",saves=0;
  let live={groups:[{id:44,windowId:7,title:"codex_test"}],
    tabs:[{id:19,windowId:7,groupId:44,title:"ChatGPT",url}]};
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

test("explicit created-chat confirmation after extension reload restores only its single-member group",async()=>{
  const f=await fixture();try{
    const legacyGroup={key:"legacy-group",groupId:999,windowId:999,sessionToken:"legacy-epoch",label:"legacy",color:"grey",paused:false,enrolledAt:1};
    const legacySession={key:"legacy-session",groupKey:legacyGroup.key,tabId:999,sessionToken:"legacy-epoch",url:"https://chatgpt.com/c/legacy",title:"legacy",paused:false,enrolledAt:1};
    f.setRegistry({...f.registry,groups:[...f.registry.groups,legacyGroup],sessions:[...f.registry.sessions,legacySession]});
    f.setEpoch("after-extension-reload");await f.advance();
    const candidate=f.enrollment.getSnapshot(f.now).candidates[0];
    assert.equal(candidate.epochHash,await hashUrl("after-extension-reload"));
    assert.equal(f.bridge.getSnapshot(f.now).links[0].status,"needs-rebind");
    assert.notEqual(f.registry.groups[0].sessionToken,"after-extension-reload");
    const intent=f.begin(),request=f.enrollment.pending(extensionId,f.now)[0];
    const result=await enrollApprovedCandidate(request,f.params);
    assert.equal(result.sessionKey,f.first.id);
    assert.equal(f.registry.groups[0].sessionToken,"after-extension-reload");
    assert.equal(f.registry.sessions[0].sessionToken,"after-extension-reload");
    assert.deepEqual(f.registry.groups[1],legacyGroup);assert.deepEqual(f.registry.sessions[1],legacySession);
    await f.sync();
    assert.equal(f.enrollment.acknowledge(extensionId,{id:intent.id,status:"applied",sessionKey:result.sessionKey,urlHash:request.urlHash},f.now).status,"done");
    assert.equal(f.bridge.getSnapshot(f.now).links[0].status,"connected");
  }finally{f.store.close();}
});

test("stale browser recovery refuses multi-member groups and changed confirmation epoch",async()=>{
  for(const kind of ["multiple-members","changed-epoch"]){
    const f=await fixture();try{
      f.setEpoch("reload");await f.advance();f.begin();
      const request=f.enrollment.pending(extensionId,f.now)[0];
      if(kind==="multiple-members")f.setRegistry({...f.registry,sessions:[...f.registry.sessions,{...f.registry.sessions[0],key:"sibling",tabId:20}]});
      else f.setEpoch("another-reload");
      const before=JSON.stringify(f.registry),saves=f.saves;
      await assert.rejects(enrollApprovedCandidate(request,f.params),/ENROLLMENT_REBIND_TARGET_CHANGED/);
      assert.equal(JSON.stringify(f.registry),before);assert.equal(f.saves,saves);
      if(kind==="multiple-members"){
        assert.equal((await discoverChatCandidates(f.registry,f.live,"reload",{hashUrl})).length,0);
      }
    }finally{f.store.close();}
  }
});

async function confirmCreatedChat(f){
  await f.advance();
  const intent=f.begin(),request=f.enrollment.pending(extensionId,f.now)[0];
  const result=await enrollApprovedCandidate(request,f.params);
  await f.sync();
  f.enrollment.acknowledge(extensionId,{id:intent.id,status:"applied",sessionKey:result.sessionKey,urlHash:request.urlHash},f.now);
}

test("Reload after created-chat confirmation offers explicit same-chat recovery repeatedly without new sessions",async()=>{
  const f=await fixture();try{
    await confirmCreatedChat(f);
    const session=f.registry.sessions[0];
    for(const epoch of ["reload-one","reload-two"]){
      f.setEpoch(epoch);await f.sync();
      const candidate=f.enrollment.getSnapshot(f.now).candidates[0];
      assert.equal(candidate.sessionKey,session.key);
      assert.equal(candidate.urlHash,candidate.previousUrlHash);
      assert.equal(candidate.epochHash,await hashUrl(epoch));
      assert.equal(f.bridge.getSnapshot(f.now).links[0].status,"needs-rebind");
      const intent=f.begin(),request=f.enrollment.pending(extensionId,f.now)[0];
      await enrollApprovedCandidate(request,f.params);
      const saves=f.saves;
      assert.equal((await enrollApprovedCandidate(request,f.params)).alreadyApplied,true);
      assert.equal(f.saves,saves);
      await f.sync();
      const ack={id:intent.id,status:"applied",sessionKey:session.key,urlHash:request.urlHash};
      assert.equal(f.enrollment.acknowledge(extensionId,ack,f.now).status,"done");
      assert.equal(f.enrollment.acknowledge(extensionId,ack,f.now).alreadyConfirmed,true);
      assert.equal(f.bridge.getSnapshot(f.now).links[0].status,"connected");
      assert.equal(f.registry.sessions.length,1);
      assert.equal(f.registry.sessions[0].key,session.key);
      assert.equal(f.registry.sessions[0].tabId,session.tabId);
      assert.equal(f.enrollment.getSnapshot(f.now).candidates.length,0);
    }
    assert.equal(f.enrollment.getSnapshot(f.now).registrations.filter(x=>x.status==="done").length,4);
  }finally{f.store.close();}
});

test("same-chat Reload recovery rejects navigation, pause, ambiguity, epoch and URL races before saving",async()=>{
  for(const kind of ["navigation","query","hash","paused","group-paused","multiple","epoch","race"]){
    const f=await fixture();try{
      await confirmCreatedChat(f);f.setEpoch("reload");await f.sync();
      f.begin();const request=f.enrollment.pending(extensionId,f.now)[0];
      if(["navigation","query","hash"].includes(kind)){
        const url=kind==="navigation"?"https://chatgpt.com/c/other":f.live.tabs[0].url+(kind==="query"?"?model=x":"#x");
        f.setLive({...f.live,tabs:[{...f.live.tabs[0],url}]});
      }
      if(kind==="paused")f.setRegistry({...f.registry,sessions:f.registry.sessions.map(s=>({...s,paused:true}))});
      if(kind==="group-paused")f.setRegistry({...f.registry,groups:f.registry.groups.map(g=>({...g,paused:true}))});
      if(kind==="multiple")f.setRegistry({...f.registry,sessions:[...f.registry.sessions,{...f.registry.sessions[0],key:"sibling",tabId:20}]});
      if(kind==="epoch")f.setEpoch("another-reload");
      let params=f.params;
      if(kind==="race"){
        let reads=0;
        params={...params,snapshot:async()=>++reads===1?f.live:{...f.live,tabs:[{...f.live.tabs[0],url:"https://chatgpt.com/c/other"}]}};
      }
      const before=JSON.stringify(f.registry),saves=f.saves;
      await assert.rejects(enrollApprovedCandidate(request,params),/ENROLLMENT_/);
      assert.equal(JSON.stringify(f.registry),before);assert.equal(f.saves,saves);
      if(kind!=="race"&&kind!=="epoch")assert.equal((await discoverChatCandidates(f.registry,f.live,"reload",{hashUrl})).length,0);
    }finally{f.store.close();}
  }
});

test("server requires last successful same-tab URL confirmation, current epoch and correct linked workstream",async()=>{
  for(const kind of ["unconfirmed","wrong-hash","wrong-tab","wrong-group","wrong-window","wrong-workstream","wrong-extension","missing-epoch","not-stale"]){
    const f=await fixture();try{
      await confirmCreatedChat(f);f.setEpoch("reload");await f.sync();
      const db=f.store.db;
      if(kind==="unconfirmed")db.prepare("UPDATE chrome_enrollment_intents SET status='failed' WHERE session_key IS NOT NULL").run();
      const columns={"wrong-hash":["url_hash","f".repeat(64)],"wrong-tab":["tab_id",20],"wrong-group":["group_id",45],"wrong-window":["window_id",8],"wrong-workstream":["workstream_id","other"],"wrong-extension":["extension_id","bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]};
      if(columns[kind]){
        const [column,value]=columns[kind];
        if(kind==="wrong-workstream")f.store.create({id:"other",name:"other",projectKey:"other",repository:"owner/repo"},f.now);
        if(kind==="wrong-extension")f.bridge.pair("chrome-extension://"+value,f.bridge.beginPairing(f.now).code,f.now);
        db.prepare("UPDATE chrome_enrollment_intents SET "+column+"=? WHERE session_key IS NOT NULL").run(value);
      }
      if(kind==="missing-epoch")db.prepare("UPDATE chrome_discovery_candidates SET epoch_hash=NULL").run();
      if(kind==="not-stale")f.bridge.sync(extensionId,{...bridgePayload(f.registry,f.live,"epoch"),composerBuild:REQUIRED_COMPOSER_BUILD},f.now);
      const c=f.enrollment.getSnapshot(f.now).candidates[0];
      assert.throws(()=>f.enrollment.begin("work",extensionId,c.tabId,c.urlHash,f.now),/REBIND_NOT_ALLOWED/);
      assert.equal(f.calls.length,2); // only the original created-chat confirmation
    }finally{f.store.close();}
  }
});

test("same-existing route recovery accepts only an identical clean ChatGPT conversation URL",()=>{
  for(const url of ["https://chatgpt.com/c/a","https://chatgpt.com/g/g-p-one/c/a"])
    assert.equal(isSameExistingChatRoute(url,url),true);
  for(const url of ["https://chatgpt.com/","https://chatgpt.com/c/a?x=1","https://chatgpt.com/c/a#x","https://user@chatgpt.com/c/a","http://chatgpt.com/c/a","https://other.test/c/a"])
    assert.equal(isSameExistingChatRoute(url,url),false);
  assert.equal(isSameExistingChatRoute("https://chatgpt.com/c/a","https://chatgpt.com/c/b"),false);
});

test('an initially existing confirmed conversation can explicitly rebind after Reload without changing physical identity',async()=>{
  const f=await fixture({url:'https://chatgpt.com/c/already-existing'});try{
    const original=f.registry.sessions[0];f.setEpoch('reload');await f.sync();
    const intent=f.begin(),request=f.enrollment.pending(extensionId,f.now)[0];
    const result=await enrollApprovedCandidate(request,f.params);await f.sync();
    f.enrollment.acknowledge(extensionId,{id:intent.id,status:'applied',sessionKey:result.sessionKey,urlHash:request.urlHash},f.now);
    assert.equal(f.bridge.getSnapshot(f.now).links[0].status,'connected');
    for(const k of ['key','tabId','groupKey','url'])assert.equal(f.registry.sessions[0][k],original[k]);
    assert.deepEqual(f.calls,[['before','work'],['after','work']]);
  }finally{f.store.close();}
});
test('initially existing Reload recovery still refuses navigation and unconfirmed source identity',async()=>{
  for(const drift of ['navigation','confirmation','epoch']){
    const f=await fixture({url:'https://chatgpt.com/c/already-existing'});try{
      f.setEpoch('reload');await f.sync();
      if(drift==='navigation')f.setLive({...f.live,tabs:[{...f.live.tabs[0],url:'https://chatgpt.com/c/another'}]});
      if(drift==='navigation'){await f.sync();assert.equal(f.enrollment.getSnapshot(f.now).candidates.length,0);continue;}
      if(drift==='confirmation')f.store.db.prepare("UPDATE chrome_enrollment_intents SET status='failed'").run();
      if(drift==='epoch')f.store.db.prepare('UPDATE chrome_discovery_candidates SET epoch_hash=NULL').run();
      assert.throws(()=>f.begin(),/REBIND_NOT_ALLOWED/);assert.equal(f.calls.length,0);
    }finally{f.store.close();}
  }
});

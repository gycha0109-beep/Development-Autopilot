import test from "node:test";
import assert from "node:assert/strict";
import {emptyRegistry,applyAction,normalizedRegistry,sessionStatus,overview} from "../extension/core.js";
import {bridgePayload} from "../extension/bridge-core.js";
import {readRequestedObservation,matchesContinuationProof} from "../extension/observation-worker.js";

const epoch="session-epoch";
const url="https://chatgpt.com/c/example-existing-chat";
const original={groups:[],tabs:[{id:11,groupId:-1,windowId:5,url,title:"Regular ChatGPT chat"}]};
const enroll=(view=original)=>applyAction(emptyRegistry(),
  {type:"enrollStandaloneTab",tabId:11},view,epoch,()=>"standalone-1",1000);
test("standalone ChatGPT tab is registered without any Chrome group",()=>{
  const registry=enroll();
  assert.equal(registry.groups.length,0);
  assert.equal(registry.sessions[0].groupKey,"");
  assert.equal(registry.sessions[0].windowId,5);
  assert.equal(sessionStatus(registry.sessions[0],registry,original,epoch),"connected");
  assert.equal(overview(registry,original,epoch).activeTabs,1);
  const saved=normalizedRegistry(JSON.parse(JSON.stringify(registry)));
  assert.equal(saved.sessions[0].windowId,5);
  const bridge=bridgePayload(saved,original,epoch);
  assert.equal(bridge.sessions[0].status,"connected");
  assert.equal(bridge.sessions[0].groupLabel,"개별 채팅");
  assert.equal(JSON.stringify(bridge).includes(url),false);
});
test("standalone exact tab identity, window, group, URL and epoch cannot silently change",()=>{
  const registry=enroll(),session=registry.sessions[0];
  for(const change of [
    {tabs:[]},
    {tabs:[{...original.tabs[0],windowId:8}]},
    {tabs:[{...original.tabs[0],groupId:3}]},
    {tabs:[{...original.tabs[0],url:"https://chatgpt.com/c/other"}]}
  ]){
    assert.notEqual(sessionStatus(session,registry,{...original,...change},epoch),"connected");
  }
  assert.equal(sessionStatus(session,registry,original,"different-epoch"),"needs-rebind");
  assert.throws(()=>applyAction(registry,{type:"enrollStandaloneTab",tabId:11},
    original,epoch,()=>"other",1100),/ALREADY_REGISTERED/);
});
test("standalone enroll refuses arbitrary sites and grouped ChatGPT tabs",()=>{
  assert.throws(()=>enroll({groups:[],tabs:[{...original.tabs[0],url:"https://evil.example"}]}),
    /STANDALONE_EXISTING_CHAT_REQUIRED/);
  assert.throws(()=>enroll({groups:[],tabs:[{...original.tabs[0],groupId:5}]}),
    /STANDALONE_EXISTING_CHAT_REQUIRED/);
});
test("standalone registered tab has verified observation and no URL or draft leak",async()=>{
  const registry=enroll();
  let calls=0;
  const adapters={
    load:async()=>registry,snapshot:async()=>original,epoch:async()=>epoch,
    getTab:async()=>({...original.tabs[0]}),now:()=>3000,
    execute:async({target,func,args})=>{
      calls++;
      assert.equal(target.tabId,11);
      assert.equal(func.name,"captureChatObservation");
      assert.equal(args[0].expectedPath,"/c/example-existing-chat");
      return [{result:{verified:true,schemaVersion:1,sourceVersion:"chat-observer-1",
        source:"chatgpt-dom",bindingFingerprint:args[0].bindingFingerprint,
        replyFingerprint:"b".repeat(64),contentComplete:true,assistantBusy:false,
        composerHasDraft:false,stopControlVerified:false,connectionWarning:false,
        lengthWarning:false,providerRestriction:false,humanActionCue:false,
        scopeCompleteCue:false,ciWaitCue:false,otherWarning:false,uiAmbiguous:false}}];
    }
  };
  const observed=await readRequestedObservation({sessionKey:"standalone-1",
    workstreamId:"macro:standalone-1"},adapters);
  assert.equal(observed.verified,true);
  assert.equal(calls,1);
  assert.equal(matchesContinuationProof(observed,{bindingFingerprint:observed.bindingFingerprint,
    replyFingerprint:observed.replyFingerprint,ciWaitCue:false}),true);
  assert.equal(JSON.stringify(observed).includes(url),false);
  adapters.getTab=async()=>({...original.tabs[0],url:"https://chatgpt.com/c/other"});
  assert.equal((await readRequestedObservation({sessionKey:"standalone-1",
    workstreamId:"macro:standalone-1"},adapters)).verified,false);
  assert.equal(calls,1);
});
test("standalone chat explicit operator rebind requires matching physical tab",()=>{
  const registry=enroll();
  const swapped={groups:[],tabs:[{id:33,groupId:-1,windowId:7,
    url:"https://chatgpt.com/c/example-existing-chat",title:"Restored"}]};
  assert.notEqual(sessionStatus(registry.sessions[0],registry,swapped,epoch),"connected");
  const rebound=applyAction(registry,{type:"rebindStandaloneTab",sessionKey:"standalone-1",tabId:33},
    swapped,epoch,()=>"none",2000);
  assert.equal(sessionStatus(rebound.sessions[0],rebound,swapped,epoch),"connected");
  assert.equal(rebound.sessions[0].key,"standalone-1");
});

import {restoreExactRegistrations,exportPortableRegistry,importPortableRegistry} from "../extension/registry-portable.js";
test("standalone chat restarts without group and restores a unique exact conversation",()=>{
  const old=enroll();
  const next={groups:[],tabs:[{id:33,groupId:-1,windowId:7,url,title:"same chat new tab"}]};
  const repaired=restoreExactRegistrations(old,next,"new-epoch");
  assert.equal(repaired.changed,true);
  assert.equal(repaired.tabsRestored,1);
  assert.equal(repaired.registry.sessions[0].key,"standalone-1");
  assert.equal(repaired.registry.sessions[0].tabId,33);
  assert.equal(repaired.registry.sessions[0].windowId,7);
  assert.equal(sessionStatus(repaired.registry.sessions[0],repaired.registry,next,"new-epoch"),"connected");
  const duplicate=structuredClone(next);
  duplicate.tabs.push({...duplicate.tabs[0],id:34});
  assert.equal(restoreExactRegistrations(old,duplicate,"new-epoch").changed,false);
});
test("standalone portable backup includes exact URL and no credentials",()=>{
  const registry=enroll();
  registry.hiddenToken="SECRET_DO_NOT_EXPORT";
  const exported=exportPortableRegistry(registry,original,epoch);
  assert.equal(exported.groups.length,0);
  assert.equal(exported.sessions.length,1);
  assert.equal(exported.sessions[0].groupKey,"");
  assert.equal(JSON.stringify(exported).includes("SECRET_DO_NOT_EXPORT"),false);
  const fresh=importPortableRegistry(emptyRegistry(),exported,original,epoch,
    ()=>"new-1",2000);
  assert.equal(fresh.importedGroups,0);
  assert.equal(fresh.importedTabs,1);
  assert.equal(fresh.restoredTabs,1);
  assert.equal(fresh.registry.sessions[0].url,url);
  assert.equal(sessionStatus(fresh.registry.sessions[0],fresh.registry,original,epoch),"connected");
  const again=importPortableRegistry(fresh.registry,exported,original,epoch,
    ()=>"new-2",3000);
  assert.equal(again.importedTabs,0);
});

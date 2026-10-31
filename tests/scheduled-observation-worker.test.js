import test from "node:test";
import assert from "node:assert/strict";
import {emptyRegistry,applyAction} from "../extension/core.js";
import {readRequestedObservation,matchesContinuationProof} from "../extension/observation-worker.js";

test("extension observes ONLY exactly registered live PIE tab and returns no transcript",async()=>{
  const url="https://chatgpt.com/g/g-p-123-pie/c/456";
  const epoch="stable-epoch";
  const view={groups:[{id:5,windowId:3,title:"PIE",color:"blue"}],
    tabs:[{id:7,windowId:3,groupId:5,url,title:"PIE data"}]};
  let seq=0;
  let registry=applyAction(emptyRegistry(),{type:"enrollGroup",groupId:5},view,epoch,()=>String(++seq),1000);
  registry=applyAction(registry,{type:"enrollTab",groupKey:registry.groups[0].key,tabId:7},
    view,epoch,()=>String(++seq),1001);
  const sessionKey=registry.sessions[0].key;
  let executed=0;
  const execute=async({target,func,args})=>{
    executed++;
    assert.equal(target.tabId,7);
    assert.equal(func.name,"captureChatObservation");
    assert.equal(args[0].expectedPath,"/g/g-p-123-pie/c/456");
    return [{result:{schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
      verified:true,assistantBusy:false,composerHasDraft:false,stopControlVerified:false,
      contentComplete:true,uiAmbiguous:false,connectionWarning:false,lengthWarning:false,
      providerRestriction:false,otherWarning:false,humanActionCue:false,scopeCompleteCue:false,
      ciWaitCue:false,bindingFingerprint:args[0].bindingFingerprint,
      replyFingerprint:"a".repeat(64)}}];
  };
  const adapters={load:async()=>registry,snapshot:async()=>view,epoch:async()=>epoch,
    getTab:async()=>view.tabs[0],execute,now:()=>12345};
  const challenge={workstreamId:"pie",sessionKey};
  const observed=await readRequestedObservation(challenge,adapters);
  assert.equal(observed.verified,true);
  assert.equal(executed,1);
  assert.equal(observed.observedAt,12345);
  assert.ok(matchesContinuationProof(observed,{
    bindingFingerprint:observed.bindingFingerprint,
    replyFingerprint:observed.replyFingerprint,ciWaitCue:false
  }));
  assert.equal(JSON.stringify(observed).includes(url),false);
  assert.equal(JSON.stringify(observed).includes("PRIVATE_DRAFT"),false);
  const mismatch=await readRequestedObservation({...challenge,sessionKey:"other"},adapters);
  assert.equal(mismatch.verified,false);
  assert.equal(executed,1);
  view.tabs[0].url="https://chatgpt.com/c/unrelated";
  const changed=await readRequestedObservation(challenge,adapters);
  assert.equal(changed.verified,false);
  assert.equal(executed,1);
});
test("pre-submit proof fails closed on streaming, drafts, warnings and changed fingerprints",()=>{
  const base={verified:true,bindingFingerprint:"b".repeat(64),
    replyFingerprint:"a".repeat(64),assistantBusy:false,composerHasDraft:false,
    contentComplete:true,stopControlVerified:false,connectionWarning:false,
    lengthWarning:false,providerRestriction:false,otherWarning:false,uiAmbiguous:false,
    humanActionCue:false,scopeCompleteCue:false,ciWaitCue:false};
  const proof={bindingFingerprint:base.bindingFingerprint,
    replyFingerprint:base.replyFingerprint,ciWaitCue:false};
  assert.equal(matchesContinuationProof(base,proof),true);
  for(const partial of [
    {assistantBusy:true},{composerHasDraft:true},{contentComplete:false},
    {replyFingerprint:"c".repeat(64)},{stopControlVerified:true},
    {connectionWarning:true},{lengthWarning:true},{providerRestriction:true},
    {otherWarning:true},{uiAmbiguous:true},{humanActionCue:true},
    {scopeCompleteCue:true},{ciWaitCue:true},{verified:false}
  ])assert.equal(matchesContinuationProof({...base,...partial},proof),false,
    JSON.stringify(partial));
});

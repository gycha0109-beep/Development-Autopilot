import test from "node:test";
import assert from "node:assert/strict";
import {readRequestedObservation,matchesContinuationProof} from "../extension/observation-worker.js";
import {observation} from "../test-support/autopilot-fixture.js";

function fixture(patch={}){
  const group={key:"group",groupId:3,windowId:2,sessionToken:"epoch",paused:false};
  const session={key:"session",tabId:11,groupKey:"group",sessionToken:"epoch",paused:false,
    url:"https://chatgpt.com/g/g-p-project/c/chat"};
  const registry={groups:[group],sessions:[session]};
  const tab={id:11,windowId:2,groupId:3,url:session.url};let calls=0;
  const adapters={load:async()=>structuredClone(registry),snapshot:async()=>({groups:[{id:3,windowId:2}],tabs:[tab]}),
    epoch:async()=>"epoch",getTab:async()=>tab,
    execute:async options=>{calls++;assert.equal(options.target.tabId,11);assert.equal(options.target.allFrames,false);
      assert.equal(options.world,"ISOLATED");assert.equal(options.func.name,"captureChatObservation");
      return [{result:observation({bindingFingerprint:options.args[0].bindingFingerprint})}];},...patch};
  return {registry,group,session,tab,adapters,calls:()=>calls,read:()=>readRequestedObservation({workstreamId:"work",sessionKey:"session"},adapters)};
}

test("worker injects only exact enrolled physical tab and returns no URL or transcript",async()=>{
  const f=fixture(),result=await f.read();assert.equal(result.verified,true);assert.equal(f.calls(),1);
  assert.match(result.bindingFingerprint,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(result),/https:|g-p-project|\/c\/chat/);
});

for(const kind of ["unregistered","paused","group-paused","epoch","url","window","group"])
test("worker does not inject on "+kind,async()=>{
  const f=fixture();
  if(kind==="unregistered")f.registry.sessions=[];
  if(kind==="paused")f.session.paused=true;
  if(kind==="group-paused")f.group.paused=true;
  if(kind==="epoch")f.adapters.epoch=async()=>"new-epoch";
  if(kind==="url")f.tab.url="https://chatgpt.com/c/another-chat";
  if(kind==="window")f.tab.windowId=9;
  if(kind==="group")f.tab.groupId=9;
  assert.equal((await f.read()).verified,false);assert.equal(f.calls(),0);
});

test("navigation or registry change during injection discards the result",async()=>{
  for(const kind of ["navigation","registry"]){
    const f=fixture(),execute=f.adapters.execute;
    f.adapters.execute=async args=>{const result=await execute(args);
      if(kind==="navigation")f.tab.url="https://chatgpt.com/c/other";else f.session.paused=true;
      return result;};
    assert.equal((await f.read()).verified,false);
  }
});

test("last-moment proof blocks changed response, busy, draft, warnings and ambiguous UI",()=>{
  const proof=observation({});assert.equal(matchesContinuationProof(proof,proof),true);
  for(const patch of [{replyFingerprint:"f".repeat(64)},{bindingFingerprint:"e".repeat(64)},
    {assistantBusy:true},{composerHasDraft:true},{composerHasDraft:null},{connectionWarning:true},
    {lengthWarning:true},{humanActionCue:true},{providerRestriction:true},{ciWaitCue:true},{uiAmbiguous:true}])
    assert.equal(matchesContinuationProof({...proof,...patch},proof),false,JSON.stringify(patch));
});

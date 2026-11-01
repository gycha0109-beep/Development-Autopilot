import test from "node:test";
import assert from "node:assert/strict";
import {emptyRegistry,applyAction} from "../extension/core.js";
import {dispatchRegisteredChatCommand} from "../extension/chat-dispatch.js";

const url="https://chatgpt.com/c/dispatch-chat";
const epoch="epoch";
const view={groups:[],tabs:[{id:5,windowId:2,groupId:-1,url,title:"ChatGPT"}]};
let count=0;
const registry=applyAction(emptyRegistry(),{type:"enrollStandaloneTab",tabId:5},
  view,epoch,()=>"session-key",1000);
const complete={verified:true,source:"chatgpt-dom",schemaVersion:1,
  sourceVersion:"chat-observer-1",assistantBusy:false,contentComplete:true,
  composerHasDraft:false,stopControlVerified:false,connectionWarning:false,
  lengthWarning:false,providerRestriction:false,otherWarning:false,
  uiAmbiguous:false,humanActionCue:false,scopeCompleteCue:false,ciWaitCue:false,
  replyFingerprint:"c".repeat(64)};
function setup({stopped=false,drift=false,throwAfterClick=false,proof=false,
  injectClicked=true}={}){
  let injections=0;
  const getTab=async()=>drift?{...view.tabs[0],url:"https://chatgpt.com/c/other"}:view.tabs[0];
  const adapters={
    load:async()=>registry,snapshot:async()=>view,epoch:async()=>epoch,getTab,
    authorized:async()=>!stopped,
    execute:async({target,func,args})=>{
      injections++;
      assert.equal(target.tabId,5);
      if(func.name==="captureChatObservation")return [{result:{
        ...complete,bindingFingerprint:args[0].bindingFingerprint
      }}];
      assert.equal(func.name,"submitToExistingChatGPT");
      assert.equal(args[2],"/c/dispatch-chat");
      if(throwAfterClick)throw Error("maybe sent");
      return [{result:{clicked:injectClicked,reason:injectClicked?"SENT":"NO_COMPOSER"}}];
    }
  };
  const command={
    id:"command",sessionKey:"session-key",message:"Continue next roadmap task",
    ...(proof?{observationProof:{
      bindingFingerprint:"b".repeat(64),replyFingerprint:"c".repeat(64),ciWaitCue:false}}:{})
  };
  return {command,adapters,count:()=>injections};
}
test("Workstream and macro use one identical verified dispatch path",async()=>{
  for(const workstreamId of [undefined,"workstream-1"]){
    const f=setup();
    const r=await dispatchRegisteredChatCommand({...f.command,workstreamId},f.adapters);
    assert.equal(r.status,"sent");
    assert.equal(f.count(),1);
  }
});
test("global STOP, wrong URL, and missing registration refuse before physical send",async()=>{
  const stopped=setup({stopped:true});
  assert.equal((await dispatchRegisteredChatCommand(stopped.command,stopped.adapters)).status,"blocked");
  assert.equal(stopped.count(),0);
  const changed=setup({drift:true});
  assert.equal((await dispatchRegisteredChatCommand(changed.command,changed.adapters)).reason,"CHAT_IDENTITY_CHANGED");
  assert.equal(changed.count(),0);
  const invalid=setup();
  assert.equal((await dispatchRegisteredChatCommand({...invalid.command,sessionKey:"wrong"},invalid.adapters)).status,"blocked");
  assert.equal(invalid.count(),0);
});
test("ambiguous physical delivery never reports sent",async()=>{
  const failed=setup({throwAfterClick:true});
  assert.equal((await dispatchRegisteredChatCommand(failed.command,failed.adapters)).status,"unknown");
  assert.equal(failed.count(),1);
  const refused=setup({injectClicked:false});
  assert.equal((await dispatchRegisteredChatCommand(refused.command,refused.adapters)).status,"blocked");
  assert.equal(refused.count(),1);
});
test("changed observation proof is rejected before submission",async()=>{
  const f=setup({proof:true});
  const r=await dispatchRegisteredChatCommand(f.command,f.adapters);
  assert.equal(r.status,"blocked");
  assert.equal(r.reason,"OBSERVATION_PRECONDITION_CHANGED");
  assert.equal(f.count(),1); // Only observation executed, not the send function.
});

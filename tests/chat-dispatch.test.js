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
  injectClicked=true,recoveryObservation=null}={}){
  let injections=0;
  const getTab=async()=>drift?{...view.tabs[0],url:"https://chatgpt.com/c/other"}:view.tabs[0];
  const adapters={
    load:async()=>registry,snapshot:async()=>view,epoch:async()=>epoch,getTab,
    authorized:async()=>!stopped,
    execute:async({target,func,args})=>{
      injections++;
      assert.equal(target.tabId,5);
      if(func.name==="captureChatObservation")return [{result:{
        ...complete,...(recoveryObservation||{}),
        bindingFingerprint:args[0].bindingFingerprint
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


async function recoveryBinding(){
  const values=["macro:session-key","session-key",5,2,-1,url];
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(values)));
  return [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
test("timeout sends follow-up only with same visible timeout panel, never clicks Stop",async()=>{
  const warning={connectionWarning:true,connectionWarningKind:"send_timeout",
    recoveryWarningSafe:true,assistantBusy:false,stopControlVerified:false,
    composerHasDraft:false,humanActionCue:false,providerRestriction:false,
    lengthWarning:false,otherWarning:false};
  const f=setup({recoveryObservation:warning});
  const command={...f.command,message:"현황 파악하고 계속 진행",
    recoveryProof:{kind:"send_timeout",bindingFingerprint:await recoveryBinding()}};
  assert.equal((await dispatchRegisteredChatCommand(command,f.adapters)).status,"sent");
  assert.equal(f.count(),2); // one read + exactly one send, no Stop click
  const changed=setup({recoveryObservation:{...warning,connectionWarningKind:null}});
  assert.equal((await dispatchRegisteredChatCommand(command,changed.adapters)).reason,
    "RECOVERY_PRECONDITION_CHANGED");
  assert.equal(changed.count(),1); // No physical send
  const streaming=setup({recoveryObservation:{...warning,stopControlVerified:true,assistantBusy:true}});
  assert.equal((await dispatchRegisteredChatCommand(command,streaming.adapters)).status,"blocked");
  assert.equal(streaming.count(),1);
});
test("disconnect recovery sends only after observed generation has stopped",async()=>{
  const done={connectionWarning:true,connectionWarningKind:"disconnect",
    recoveryWarningSafe:true,assistantBusy:false,stopControlVerified:false,
    composerHasDraft:false,humanActionCue:false,providerRestriction:false,
    lengthWarning:false,otherWarning:false,
    diagnostic:{threadForms:1,threadEditors:1}};
  const command={sessionKey:"session-key",message:"현황 파악하고 계속 진행",
    recoveryProof:{kind:"disconnect_stopped",bindingFingerprint:await recoveryBinding(),
      operationId:"a".repeat(8)+"-"+"a".repeat(4)+"-"+"a".repeat(4)+"-"+"a".repeat(4)+"-"+"a".repeat(12)}};
  const f=setup({recoveryObservation:done});
  assert.equal((await dispatchRegisteredChatCommand(command,f.adapters)).status,"sent");
  assert.equal(f.count(),2);
  const busy=setup({recoveryObservation:{...done,stopControlVerified:true,assistantBusy:true}});
  assert.equal((await dispatchRegisteredChatCommand(command,busy.adapters)).reason,
    "RECOVERY_PRECONDITION_CHANGED");
  assert.equal(busy.count(),1);
  const changed=setup({recoveryObservation:{...done,connectionWarningKind:"send_timeout"}});
  assert.equal((await dispatchRegisteredChatCommand(command,changed.adapters)).status,"blocked");
  assert.equal(changed.count(),1);
});

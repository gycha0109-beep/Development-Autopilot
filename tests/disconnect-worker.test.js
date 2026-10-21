import test from "node:test";
import assert from "node:assert/strict";
import {executeRecoveryCommand} from "../extension/disconnect-worker.js";
import {observation} from "../test-support/autopilot-fixture.js";
const operationId="12345678-1234-4234-8234-123456789abc";
function fixture({kind="stop",patch={},authorized=true,drift=false}={}){
  const group={key:"group",groupId:3,windowId:2,sessionToken:"epoch",paused:false};
  const session={key:"session",tabId:11,groupKey:"group",sessionToken:"epoch",paused:false,url:"https://chatgpt.com/c/recovery"};
  const registry={groups:[group],sessions:[session]},tab={id:11,windowId:2,groupId:3,url:session.url};
  let writes=0,reads=0,authorizations=0;
  const adapters={load:async()=>structuredClone(registry),snapshot:async()=>({groups:[{id:3,windowId:2}],tabs:[tab]}),
    epoch:async()=>"epoch",getTab:async()=>tab,
    authorize:async()=>{authorizations++;if(drift)session.paused=true;return {authorized};},
    execute:async options=>{
      assert.equal(options.target.tabId,11);assert.equal(options.target.allFrames,false);assert.equal(options.world,"ISOLATED");
      if(options.func.name==="captureChatObservation"){
        reads++;const userFingerprint=(writes?"e":"f").repeat(64);
        return [{result:observation({bindingFingerprint:options.args[0].bindingFingerprint,
          ...(kind==="stop"?{connectionWarning:true,assistantBusy:true,stopControlVerified:true}:{}),
          recoveryUserFingerprint:userFingerprint,...(writes?{recoveryReportProof:{operationId,userFingerprint}}:{}),...patch})}];
      }
      writes++;assert.equal(options.func.name,kind==="stop"?"clickVerifiedDisconnectStop":"submitToExistingChatGPT");
      return [{result:{clicked:true}}];
    }};
  const command={operationId,kind,workstreamId:"work",sessionKey:"session"};
  return {adapters,registry,command,writes:()=>writes,reads:()=>reads,authorizations:()=>authorizations,
    run:async()=>{
      // Obtain the exact normal worker binding digest rather than inventing a tab fingerprint.
      const {readRequestedObservation}=await import("../extension/observation-worker.js");
      const pre=await readRequestedObservation(command,adapters);command.bindingFingerprint=pre.bindingFingerprint;
      return executeRecoveryCommand(command,adapters);
    }};
}
for(const kind of ["stop","report"])
test("worker executes one scoped "+kind+" and report requires a new exact user-message proof",async()=>{
  const f=fixture({kind}),receipt=await f.run();assert.equal(receipt.outcome,kind==="stop"?"clicked":"submitted");
  assert.equal(f.writes(),1);assert.equal(f.authorizations(),1);
  if(kind==="report")assert.equal(receipt.userFingerprint,"e".repeat(64));
});
for(const patch of [{composerHasDraft:true},{uiAmbiguous:true},{providerRestriction:true},{humanActionCue:true},
  {connectionWarning:false},{stopControlVerified:false},{assistantBusy:false},{ciWaitCue:true}])
test("worker blocks Stop before mutation when preconditions change: "+JSON.stringify(patch),async()=>{
  const f=fixture({patch});assert.equal((await f.run()).outcome,"unknown");assert.equal(f.writes(),0);
});
test("revoked server permission or registry drift after authorization prevents any writer injection",async()=>{
  for(const options of [{authorized:false},{drift:true}]){
    const f=fixture(options);assert.equal((await f.run()).outcome,"unknown");assert.equal(f.writes(),0);
  }
});

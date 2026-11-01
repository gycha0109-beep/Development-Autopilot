import test from "node:test";
import assert from "node:assert/strict";
import {verifiedCiFailure} from "../local/chat-ci-signal.js";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";

const repo="owner/project",SHA="a".repeat(40),at=3_000_000;
const observation={schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
  verified:true,bindingFingerprint:"b".repeat(64),replyFingerprint:"c".repeat(64),
  observedAt:at,connectionWarning:false,lengthWarning:false,
  providerRestriction:false,humanActionCue:false,otherWarning:false,
  uiAmbiguous:false,assistantBusy:false,stopControlVerified:false,
  composerHasDraft:false,contentComplete:true,scopeCompleteCue:false,ciWaitCue:true};
function evidence(override={}){
  return {registry:{repositories:[{name:repo}]},scan:{status:"observed",checkedAt:at,
    repositories:[{repository:repo,status:"observed",
      observedAt:new Date(at).toISOString(),
      runs:[{runId:123,runAttempt:2,headSha:SHA,
        ciState:"FAILURE",workflowName:"CI",createdAt:new Date(at-1000).toISOString()}]}]},
    incidents:[{code:"CI_FAILED",state:"open",scope:"repo:"+repo+":123:2"}],...override};
}
test("fresh exact failure and matching incident select CI-red advisory only",()=>{
  const signal=verifiedCiFailure({...evidence(),repository:repo,now:at});
  assert.equal(signal.runId,123);
  assert.equal(signal.runAttempt,2);
  assert.equal(signal.headSha,SHA);
  assert.equal(signal.advisoryOnly,true);
});
test("stale, wrong repo, resolved, older attempt, missing incident never trigger CI-red",()=>{
  assert.equal(verifiedCiFailure({...evidence(),repository:"owner/other",now:at}),null);
  assert.equal(verifiedCiFailure({...evidence(),repository:repo,now:at+6*60_000}),null);
  assert.equal(verifiedCiFailure({...evidence({incidents:[]}),repository:repo,now:at}),null);
  const e=evidence();
  e.scan.repositories[0].runs.push({...e.scan.repositories[0].runs[0],
    runAttempt:3,ciState:"SUCCESS"});
  assert.equal(verifiedCiFailure({...e,repository:repo,now:at}),null);
});
test("CI wait report automatically queues verified red macro without Workstreams",()=>{
  let now=at;
  const ext="abcdefghijklmnopabcdefghijklmnop",session="chat1";
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],sessions:[{extensionId:ext,
    sessionKey:session,status:"connected",urlHash:"d".repeat(64)}],links:[]})};
  const macros=new ChatMacroController(store,{bridge,now:()=>now});
  macros.setCIProvider(()=>evidence());
  try{
    macros.configure(ext,{sessionKey:session,enabled:true,mode:"auto",
      intervalMinutes:1,repository:repo});
    assert.equal(store.list().length,0);
    const verify=()=>{
      const request=macros.requestObservations(ext)[0];
      return macros.observe(ext,{requestId:request.requestId,
        observation:{...observation,observedAt:now}});
    };
    assert.equal(verify().reason,"REPLY_STABILITY_PENDING");
    now=at+31_000;
    const result=verify();
    assert.equal(result.queued,true);
    assert.equal(result.macroKey,"ci_red");
    const command=macros.claim(ext);
    assert.equal(command.macroKey,"ci_red");
    assert.equal(command.observationProof.ciWaitCue,true);
    assert.match(command.message,/Run 123 Attempt 2/);
    macros.ack(ext,{id:command.id,status:"sent",reason:"SUBMITTED"});
    assert.equal(macros.get(ext,session).lastCiIdentity,
      "ci:"+repo+":123:2:"+SHA);
    now=at+93_000;
    assert.equal(verify().queued,false);
  }finally{store.close();}
});

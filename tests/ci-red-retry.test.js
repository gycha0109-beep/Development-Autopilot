import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";

const repository="testowner/testrepo";
const branch="feat/test-track/ci-red";
const sha="a".repeat(40);
const extensionId="abcdefghijklmnopabcdefghijklmnop";
const sessionKey="test-chat",urlHash="d".repeat(64);
function fixture({stop=false}={}){
  let now=4_000_000;
  let ci="RUNNING",attempt=1,incident=false,editorDraft=false;
  let replyFingerprint="c".repeat(64);
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId,sessionKey,status:"connected",urlHash}],links:[]})};
  const macros=new ChatMacroController(store,{bridge,now:()=>now});
  const ciProvider=()=>({registry:{repositories:[{name:repository}]},
    scan:{status:"observed",checkedAt:now,repositories:[{
      repository,branch,headSha:sha,status:"observed",observedAt:new Date(now).toISOString(),
      runs:[{runId:902,runAttempt:attempt,headSha:sha,
        workflowName:"CI Red Integration Test",ciState:ci,
        createdAt:new Date(now-1_000).toISOString()}]
    }]},incidents:incident?[{code:"CI_FAILED",state:"open",
      scope:"repo:"+repository+":902:"+attempt}]:[]});
  macros.setCIProvider(ciProvider);
  macros.setChatCiStatus(()=>({status:"observed",ciState:ci,repository,
    branch,headSha:sha,observedAt:new Date(now).toISOString(),runs:[{
      runId:902,runAttempt:attempt,headSha:sha,workflowName:"CI Red Integration Test",
      ciState:ci,createdAt:new Date(now-1_000).toISOString()
    }]}));
  macros.configure(extensionId,{sessionKey,enabled:true,mode:"auto",
    intervalMinutes:1,repository,ciBranch:branch});
  if(stop)store.setStopped(true);
  const observation=()=>({schemaVersion:1,sourceVersion:"chat-observer-1",
    source:"chatgpt-dom",verified:true,bindingFingerprint:"b".repeat(64),
    replyFingerprint,observedAt:now,
    connectionWarning:false,lengthWarning:false,providerRestriction:false,
    humanActionCue:false,otherWarning:false,uiAmbiguous:false,
    assistantBusy:false,stopControlVerified:false,composerHasDraft:editorDraft,
    contentComplete:true,scopeCompleteCue:false,ciWaitCue:true});
  const observe=()=>{
    const challenge=macros.requestObservations(extensionId)[0];
    assert.ok(challenge,"expected registered, authorized chat observation");
    return macros.observe(extensionId,{requestId:challenge.requestId,
      observation:observation()});
  };
  return {store,macros,observe,observation,
    advance:ms=>now+=ms,
    setCI:(value,failed)=>{ci=value;incident=failed;},
    setAttempt:value=>{attempt=value;},
    setReply:value=>{replyFingerprint=value;},
    setDraft:value=>{editorDraft=value;},
    close:()=>store.close()};
}

test("running CI waits; verified RED sends one investigate/fix/retry message",()=>{
  const f=fixture();
  try{
    assert.equal(f.store.list().length,0,"no Workstream is registered");
    assert.equal(f.observe().reason,"WAIT_VERIFIED_CI");
    f.advance(35_000);
    assert.equal(f.observe().reason,"WAIT_VERIFIED_CI");
    assert.equal(f.macros.claim(extensionId),null);
    f.setCI("FAILURE",true);
    assert.equal(f.observe().reason,"REPLY_STABILITY_PENDING");
    f.advance(31_000);
    const queued=f.observe();
    assert.equal(queued.queued,true);
    assert.equal(queued.macroKey,"ci_red");
    const cmd=f.macros.claim(extensionId);
    assert.equal(cmd.macroKey,"ci_red");
    assert.equal(cmd.observationProof.ciWaitCue,true);
    assert.match(cmd.message,/WORKLOG/);
    assert.ok(cmd.message.includes(branch));
    assert.match(cmd.message,/다른 트랙/);
    assert.match(cmd.message,/Run ID 902 Attempt 1 HEAD SHA/);
    assert.match(cmd.message,/testowner\/testrepo/);
    assert.equal(f.macros.ack(extensionId,{id:cmd.id,status:"sent"}).status,"sent");
    assert.equal(f.macros.get(extensionId,sessionKey).lastCiIdentity,
      "ci:"+repository+":902:1:"+sha);
    f.advance(95_000);
    assert.equal(f.observe().reason,"WAIT_VERIFIED_CI");
    assert.equal(f.macros.claim(extensionId),null);
    assert.equal(f.macros.view(extensionId).commands.filter(x=>
      x.macroKey==="ci_red"&&x.state==="sent").length,1);
  }finally{f.close();}
});
test("failed CI with a draft does not dispatch, but retries once after editor clears",()=>{
  const f=fixture();
  try{
    f.setCI("FAILURE",true);
    f.setDraft(true);
    assert.equal(f.observe().reason,"CI_RED_WAIT_SAFE_COMPOSER");
    assert.equal(f.macros.claim(extensionId),null);
    f.advance(5_000);
    f.setDraft(false);
    assert.equal(f.observe().reason,"REPLY_STABILITY_PENDING");
    f.advance(31_000);
    assert.equal(f.observe().macroKey,"ci_red");
  }finally{f.close();}
});
test("new attempt RUNNING never reuses old red; new failed attempt yields distinct message",()=>{
  const f=fixture();
  try{
    f.setCI("FAILURE",true);
    assert.equal(f.observe().reason,"REPLY_STABILITY_PENDING");
    f.advance(31_000);
    assert.equal(f.observe().macroKey,"ci_red");
    const first=f.macros.claim(extensionId);
    f.macros.ack(extensionId,{id:first.id,status:"sent"});
    f.setAttempt(2);f.setCI("RUNNING",false);f.advance(65_000);
    f.setReply("e".repeat(64));
    assert.equal(f.observe().reason,"WAIT_VERIFIED_CI");
    f.setCI("FAILURE",true);
    assert.equal(f.observe().reason,"REPLY_STABILITY_PENDING");
    f.advance(31_000);
    assert.equal(f.observe().queued,true);
    const second=f.macros.claim(extensionId);
    assert.equal(second.macroKey,"ci_red");
    assert.match(second.message,/Attempt 2/);
    assert.notEqual(first.id,second.id);
  }finally{f.close();}
});
test("global STOP and missing incident never cause a red message",()=>{
  const f=fixture({stop:true});
  try{
    f.setCI("FAILURE",true);
    assert.equal(f.macros.requestObservations(extensionId).length,0);
    assert.equal(f.macros.claim(extensionId),null);
  }finally{f.close();}
  const g=fixture();
  try{
    g.setCI("FAILURE",false);
    assert.equal(g.observe().reason,"WAIT_VERIFIED_CI");
    g.advance(90_000);
    assert.equal(g.observe().reason,"WAIT_VERIFIED_CI");
    assert.equal(g.macros.claim(extensionId),null);
  }finally{g.close();}
});

test("verified new RED attempt dispatches even if the previous assistant reply has not changed",()=>{
  const f=fixture();
  try{
    f.setCI("FAILURE",true);
    assert.equal(f.observe().reason,"REPLY_STABILITY_PENDING");
    f.advance(31_000);
    assert.equal(f.observe().macroKey,"ci_red");
    const first=f.macros.claim(extensionId);
    f.macros.ack(extensionId,{id:first.id,status:"sent"});
    f.setAttempt(2);
    f.setCI("RUNNING",false);
    f.advance(65_000);
    assert.equal(f.observe().reason,"WAIT_VERIFIED_CI");
    f.setCI("FAILURE",true);
    let next=f.observe();
    if(!next.queued){
      assert.equal(next.reason,"REPLY_STABILITY_PENDING");
      f.advance(31_000);
      next=f.observe();
    }
    assert.equal(next.macroKey,"ci_red");
    const second=f.macros.claim(extensionId);
    assert.match(second.message,/Attempt 2/);
    f.macros.ack(extensionId,{id:second.id,status:"sent"});
    f.advance(65_000);
    assert.equal(f.observe().queued,false);
  }finally{f.close();}
});

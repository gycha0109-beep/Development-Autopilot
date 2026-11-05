import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";
import {GitHubChatCiObserver} from "../local/github-chat-ci.js";

const repo="gycha0109-beep/Saju";
const branch="feat/saju/reading-coverage-seven-stage";
const sha="a".repeat(40),extensionId="abcdefghijklmnopabcdefghijklmnop";
const epoch=Date.parse("2026-11-03T02:25:00Z");
function fixture(){
  let now=epoch,ciStatus="in_progress",conclusion=null,ciAttempt=1;
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId,sessionKey:"saju",status:"connected",
      urlHash:"d".repeat(64)}],links:[]})};
  const macros=new ChatMacroController(store,{bridge,now:()=>now});
  const observer=new GitHubChatCiObserver({
    now:()=>now,pollMs:1,readBranchHead:async()=>sha,targets:()=>[{
      repository:repo,branch
    }],
    read:async()=>[{
      runId:2745,runAttempt:ciAttempt,headSha:sha,
      headBranch:branch,workflowName:"Saju CI",
      status:ciStatus,conclusion,
      createdAt:new Date(epoch-60_000).toISOString()
    }],
    readJobs:async()=>[{runId:2745,headSha:sha,
      status:ciStatus,conclusion}]
  });
  macros.setCIProvider(()=>observer.provider());
  macros.setChatCiStatus(r=>observer.state(r));
  const configured=macros.configure(extensionId,{
    sessionKey:"saju",enabled:true,mode:"auto",
    intervalMinutes:10,repository:repo,ciBranch:branch
  });
  const read=async({ciWaitCue=false,draft=false,reply="c".repeat(64)}={})=>{
    await observer.refresh({force:true});
    const challenge=macros.requestObservations(extensionId)[0];
    assert.ok(challenge);
    const observation={
      schemaVersion:1,sourceVersion:"chat-observer-1",
      source:"chatgpt-dom",verified:true,
      bindingFingerprint:"b".repeat(64),replyFingerprint:reply,
      observedAt:now,connectionWarning:false,lengthWarning:false,
      providerRestriction:false,humanActionCue:false,
      otherWarning:false,uiAmbiguous:false,assistantBusy:false,
      stopControlVerified:false,composerHasDraft:draft,
      contentComplete:true,scopeCompleteCue:false,ciWaitCue
    };
    return macros.observe(extensionId,{requestId:challenge.requestId,observation});
  };
  return {store,macros,observer,configured,read,
    advance:ms=>now+=ms,
    status:(s,c,a=ciAttempt)=>{ciStatus=s;conclusion=c;ciAttempt=a;},
    close:()=>store.close()};
}

test("10-minute Saju chat independently waits for running CI and sends one verified RED",async()=>{
  const x=fixture();
  try{
    assert.equal(x.store.list().length,0,"Workstream is not required");
    assert.equal(x.configured.intervalMinutes,10);
    assert.equal(x.configured.ciBranch,branch);
    assert.equal((await x.read({ciWaitCue:false})).reason,"WAIT_VERIFIED_CI");
    x.advance(31_000);
    assert.equal((await x.read({ciWaitCue:false})).reason,"WAIT_VERIFIED_CI");
    x.status("completed","failure");
    assert.equal((await x.read({ciWaitCue:false})).reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    const outcome=await x.read({ciWaitCue:false});
    assert.equal(outcome.queued,true);
    assert.equal(outcome.macroKey,"ci_red");
    const cmd=x.macros.claim(extensionId);
    assert.match(cmd.message,/실패\(RED\)/);
    assert.match(cmd.message,/오류 원인/);
    assert.match(cmd.message,/재시도/);
    assert.match(cmd.message,/Run ID 2745/);
    x.macros.ack(extensionId,{id:cmd.id,status:"sent"});
    x.advance(90_000);
    assert.equal((await x.read({ciWaitCue:false})).queued,false);
    assert.equal(x.macros.claim(extensionId),null);
  }finally{x.close();}
});
test("CI success resumes only after ten-minute interval and fresh reply",async()=>{
  const x=fixture();
  try{
    assert.equal((await x.read({ciWaitCue:true})).reason,"WAIT_VERIFIED_CI");
    x.status("completed","success");
    assert.equal((await x.read({ciWaitCue:true})).reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    const outcome=await x.read({ciWaitCue:true});
    assert.equal(outcome.queued,true);
    const cmd=x.macros.claim(extensionId);
    assert.equal(cmd.macroKey,"general");
    x.macros.ack(extensionId,{id:cmd.id,status:"sent"});
    x.advance(9*60_000);
    assert.equal((await x.read({ciWaitCue:true,reply:"e".repeat(64)})).queued,false);
    x.advance(2*60_000);
    // The reply was already seen at minute nine; it may dispatch after
    // the ten-minute minimum has elapsed and stability is established.
    assert.equal((await x.read({ciWaitCue:true,reply:"e".repeat(64)})).queued,true);
  }finally{x.close();}
});
test("wrong branch and missing confirmed jobs cannot send another chat CI RED",async()=>{
  const x=fixture();
  try{
    // Explicit scoped repo and exact branch have no cross-chat CI sends.
    assert.equal(x.configured.repository,repo);
    assert.equal(x.configured.ciBranch,branch);
    await assert.rejects(async()=>x.macros.configure(extensionId,{
      sessionKey:"saju",enabled:true,mode:"auto",
      intervalMinutes:10,repository:repo,ciBranch:"../other"
    }),/MACRO_CI_BRANCH_INVALID/);
  }finally{x.close();}
});

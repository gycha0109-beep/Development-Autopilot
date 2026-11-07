import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";
import {completionCiEvidence,completionOutcome,ROADMAP_AUDIT_PROMPT,fetchGitHubBranchHead,RoadmapCiHeadObserver}
  from "../local/roadmap-completion.js";

const extensionId="abcdefghijklmnopabcdefghijklmnop";
const repo="example/saju",branch="feat/saju/roadmap";
const head="a".repeat(40),newHead="b".repeat(40);
const firstReply="c".repeat(64),auditReply="d".repeat(64),binding="e".repeat(64);
const secondReply="f".repeat(64);
const base=at=>({schemaVersion:1,sourceVersion:"chat-observer-1",
  source:"chatgpt-dom",verified:true,bindingFingerprint:binding,
  replyFingerprint:firstReply,observedAt:at,
  connectionWarning:false,lengthWarning:false,providerRestriction:false,
  humanActionCue:false,ciWaitCue:false,scopeCompleteCue:true,
  otherWarning:false,uiAmbiguous:false,assistantBusy:false,
  stopControlVerified:false,composerHasDraft:false,contentComplete:true,
  roadmapCompleteCue:true,roadmapAuditResult:null,
  roadmapAuditScopeProvided:false,roadmapAuditHeadSha:null});
const outcome={roadmapCompleteCue:false,scopeCompleteCue:false,
  replyFingerprint:auditReply,roadmapAuditResult:"COMPLETE",
  roadmapAuditScopeProvided:true,roadmapAuditHeadSha:head};
function fixture({intervalMinutes=10,secondChat=false,withRepo=true}={}){
  let at=1_000_000;
  let ci={status:"observed",ciState:"SUCCESS",repository:repo,branch,
    verifiedBranchHead:head,runs:[{runId:121,runAttempt:1,headSha:head,ciState:"SUCCESS"}]};
  const sessions=[{extensionId,sessionKey:"target",status:"connected",
    urlHash:"1".repeat(64)}];
  if(secondChat)sessions.push({extensionId,sessionKey:"other",
    status:"connected",urlHash:"2".repeat(64)});
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],sessions,links:[]})};
  const macros=new ChatMacroController(store,{bridge,now:()=>at});
  macros.setChatCiStatus(()=>ci);
  macros.setCompletionCiStatus(()=>ci);
  macros.configure(extensionId,{sessionKey:"target",enabled:true,mode:"auto",
    intervalMinutes,repository:withRepo?repo:null,ciBranch:withRepo?branch:null});
  if(secondChat)macros.configure(extensionId,{
    sessionKey:"other",enabled:true,mode:"auto",intervalMinutes,
    repository:repo,ciBranch:branch});
  function observe(fields={},key="target"){
    const request=macros.requestObservations(extensionId).find(x=>x.sessionKey===key);
    assert.ok(request?.requestId,"Expected a registered chat observation");
    return macros.observe(extensionId,{requestId:request.requestId,
      observation:{...base(at),...fields,observedAt:at}});
  }
  function startAudit(){
    assert.equal(observe().reason,"REPLY_STABILITY_PENDING");
    at+=31_000;
    const queued=observe();
    assert.equal(queued.queued,true);
    assert.equal(queued.macroKey,"audit");
    const command=macros.claim(extensionId);
    assert.equal(command.macroKey,"audit");
    assert.match(command.message,/ROADMAP_AUDIT: COMPLETE/);
    assert.match(command.message,new RegExp(head));
    assert.match(command.message,new RegExp(repo));
    macros.ack(extensionId,{id:command.id,status:"sent"});
    assert.equal(macros.completion(extensionId,"target").phase,"audit_sent");
    return command;
  }
  return {store,macros,bridge,observe,startAudit,
    advance:ms=>{at+=ms;},ci:value=>{ci=value;},
    current:()=>at,close:()=>store.close()};
}

test("exact declaration creates ONE audit; green verified SHA completes only one chat",()=>{
  const x=fixture({secondChat:true});
  try{
    const audit=x.startAudit();
    assert.equal(x.store.list().length,0);
    assert.equal(x.macros.get(extensionId,"other").enabled,true);
    assert.equal(x.observe().reason,"ROADMAP_AUDIT_AWAIT_NEW_REPLY");
    x.advance(1_000);
    assert.equal(x.observe(outcome).reason,"ROADMAP_AUDIT_STABILITY_PENDING");
    x.advance(31_000);
    const done=x.observe(outcome);
    assert.equal(done.completed,true);
    assert.equal(done.reason,"ROADMAP_COMPLETE_VERIFIED");
    assert.equal(x.macros.get(extensionId,"target").enabled,false);
    assert.equal(x.macros.get(extensionId,"target").status,"completed");
    assert.equal(x.macros.get(extensionId,"other").enabled,true);
    assert.equal(x.macros.completion(extensionId,"target").phase,"completed");
    assert.equal(x.macros.completion(extensionId,"target").verified_run_identity,"121:1");
    assert.equal(x.macros.claim(extensionId),null);
    assert.equal(x.macros.view(extensionId).completions[0].phase,"completed");
    const reloaded=new ChatMacroController(x.store,{bridge:x.bridge,now:x.current});
    assert.equal(reloaded.get(extensionId,"target").status,"completed");
    assert.equal(reloaded.requestObservations(extensionId).some(r=>
      r.sessionKey==="target"),false);
    assert.equal(x.macros.view(extensionId).commands.filter(c=>
      c.macroKey==="audit").length,1);
    assert.equal(audit.macroKey,"audit");
  }finally{x.close();}
});

test("incomplete final audit reopens only the original roadmap after interval",()=>{
  const x=fixture();
  try{
    x.startAudit();
    x.advance(1_000);
    assert.equal(x.observe({...outcome,roadmapAuditResult:"INCOMPLETE"}).reason,
      "ROADMAP_AUDIT_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe({...outcome,roadmapAuditResult:"INCOMPLETE"}).reason,
      "ROADMAP_AUDIT_INCOMPLETE_CONTINUE");
    assert.equal(x.macros.completion(extensionId,"target"),null);
    assert.equal(x.macros.get(extensionId,"target").enabled,true);
    x.advance(10*60_000);
    const flags={roadmapCompleteCue:false,scopeCompleteCue:false,
      replyFingerprint:auditReply};
    assert.equal(x.observe(flags).reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    const next=x.observe(flags);
    assert.equal(next.queued,true,JSON.stringify(next));
    assert.equal(next.macroKey,"general");
  }finally{x.close();}
});

test("blocked audit or missing exact audit result pauses only the target",()=>{
  for(const status of ["BLOCKED",null]){
    const x=fixture({secondChat:true});
    try{
      x.startAudit();
      x.advance(1_000);
      assert.equal(x.observe({...outcome,roadmapAuditResult:status}).reason,
        "ROADMAP_AUDIT_STABILITY_PENDING");
      x.advance(31_000);
      const answer=x.observe({...outcome,roadmapAuditResult:status});
      assert.equal(answer.needsAttention,true);
      assert.equal(x.macros.get(extensionId,"target").enabled,false);
      assert.equal(x.macros.get(extensionId,"target").status,"paused");
      assert.equal(x.macros.completion(extensionId,"target").phase,"attention");
      assert.equal(x.macros.get(extensionId,"other").enabled,true);
    }finally{x.close();}
  }
});

test("false complete, changed CI HEAD and missing project scope cannot finish",()=>{
  for(const variation of [
    {field:{roadmapAuditHeadSha:newHead},reason:"ROADMAP_AUDIT_CI_UNVERIFIED"},
    {field:{roadmapAuditScopeProvided:false},reason:"ROADMAP_AUDIT_SCOPE_MISSING"},
    {changeCi:{status:"observed",ciState:"RUNNING",repository:repo,branch,
      runs:[{runId:121,runAttempt:1,headSha:head,ciState:"RUNNING"}]},
      reason:"ROADMAP_AUDIT_CI_UNVERIFIED"}
  ]){
    const x=fixture();
    try{
      x.startAudit();
      if(variation.changeCi)x.ci(variation.changeCi);
      x.advance(1_000);
      x.observe({...outcome,...variation.field});
      x.advance(31_000);
      assert.equal(x.observe({...outcome,...variation.field}).reason,
        variation.reason);
      assert.equal(x.macros.get(extensionId,"target").status,"paused");
    }finally{x.close();}
  }
});

test("CI change between queued audit and browser claim never sends the audit",()=>{
  const x=fixture();
  try{
    assert.equal(x.observe().reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe().macroKey,"audit");
    x.ci({status:"observed",ciState:"SUCCESS",repository:repo,branch,
      verifiedBranchHead:newHead,runs:[{runId:122,runAttempt:1,headSha:newHead,ciState:"SUCCESS"}]});
    assert.equal(x.macros.claim(extensionId),null);
    assert.equal(x.macros.get(extensionId,"target").enabled,false);
    assert.equal(x.macros.completion(extensionId,"target").phase,"attention");
    assert.equal(x.macros.view(extensionId).commands[0].state,"blocked");
  }finally{x.close();}
});
test("CI RUNNING or global STOP never emits a premature audit",()=>{
  const x=fixture();
  try{
    x.ci({status:"observed",ciState:"RUNNING",repository:repo,branch,
      runs:[{runId:121,runAttempt:1,headSha:head,ciState:"RUNNING"}]});
    assert.equal(x.observe().reason,"WAIT_VERIFIED_CI");
    x.advance(90_000);
    assert.equal(x.observe().queued,false);
    assert.equal(x.macros.completion(extensionId,"target"),null);
    x.store.setStopped(true);
    x.ci({status:"observed",ciState:"SUCCESS",repository:repo,branch,
      runs:[{runId:121,runAttempt:1,headSha:head,ciState:"SUCCESS"}]});
    x.advance(31_000);
    assert.equal(x.macros.requestObservations(extensionId).length,0);
    assert.equal(x.macros.completion(extensionId,"target"),null);
  }finally{x.close();}
});
test("without repository audit can run, but autonomous completion is forbidden",()=>{
  const x=fixture({withRepo:false});
  try{
    x.startAudit=undefined;
    assert.equal(x.observe().reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe().macroKey,"audit");
    const cmd=x.macros.claim(extensionId);
    assert.equal(cmd.macroKey,"audit");
    x.macros.ack(extensionId,{id:cmd.id,status:"sent"});
    x.advance(1_000);x.observe({...outcome,roadmapAuditHeadSha:null});
    x.advance(31_000);
    assert.equal(x.observe({...outcome,roadmapAuditHeadSha:null}).reason,
      "ROADMAP_AUDIT_CI_UNVERIFIED");
    assert.equal(x.macros.get(extensionId,"target").status,"paused");
  }finally{x.close();}
});
test("completion evidence rejects stale, mixed HEAD, non-green runs",()=>{
  const ok={status:"observed",ciState:"SUCCESS",repository:repo,branch,
    verifiedBranchHead:head,runs:[{runId:1,runAttempt:1,headSha:head,ciState:"SUCCESS"}]};
  assert.equal(completionCiEvidence(ok,repo,branch).headSha,head);
  assert.equal(completionCiEvidence(ok,repo,null),null);
  assert.equal(completionCiEvidence({...ok,status:"unknown"},repo,branch),null);
  assert.equal(completionCiEvidence({...ok,runs:[
    ...ok.runs,{runId:2,runAttempt:1,headSha:newHead,ciState:"SUCCESS"}
  ]},repo,branch),null);
  assert.equal(completionCiEvidence({...ok,runs:[
    ...ok.runs,{runId:2,runAttempt:1,headSha:head,ciState:"RUNNING"}
  ]},repo,branch),null);
  assert.equal(completionOutcome({...outcome},{expectedHead:head,
    ciEvidence:completionCiEvidence(ok,repo,branch)}).status,"completed");
  assert.ok(ROADMAP_AUDIT_PROMPT.includes("프로젝트 지침"));
  assert.ok(ROADMAP_AUDIT_PROMPT.length<700);
});

test("completion requires independently verified current branch HEAD, not prior green",()=>{
  const ok={status:"observed",ciState:"SUCCESS",repository:repo,branch,
    verifiedBranchHead:newHead,
    runs:[{runId:121,runAttempt:1,headSha:head,ciState:"SUCCESS"}]};
  assert.equal(completionCiEvidence(ok,repo,branch),null);
  assert.equal(completionCiEvidence({...ok,verifiedBranchHead:null},repo,branch),null);
  assert.equal(completionCiEvidence({...ok,verifiedBranchHead:head},repo,branch).headSha,head);
  assert.equal(completionCiEvidence({...ok,branch:null},repo,null),null,
    "unscoped repository must not auto-complete");
});
test("GitHub branch HEAD lookup is authenticated, read-only and validates exact SHA",async()=>{
  let invoked;
  const returned=await fetchGitHubBranchHead(repo,branch,{run:async(command,args,options)=>{
    invoked={command,args,options};
    return {stdout:JSON.stringify({commit:{sha:head}})};
  }});
  assert.equal(returned,head);
  assert.equal(invoked.command,"gh");
  assert.match(invoked.args[1],/\/branches\/feat%2Fsaju%2Froadmap/);
  assert.equal(invoked.options.windowsHide,true);
  assert.equal(invoked.args.includes("PATCH"),false);
  await assert.rejects(()=>fetchGitHubBranchHead(repo,"../unsafe"),/COMPLETION_BRANCH_INVALID/);
  await assert.rejects(()=>fetchGitHubBranchHead(repo,branch,{
    run:async()=>({stdout:JSON.stringify({commit:{sha:"short"}})})}),
    /COMPLETION_HEAD_UNVERIFIED/);
});
test("branch-tip observer throttles requests and refuses stale or failed reads",async()=>{
  let now=1_000_000,headAtGitHub=head,requests=0;
  const observer=new RoadmapCiHeadObserver({
    targets:()=>[{repository:repo,branch}],now:()=>now,
    read:async()=>{requests++;return headAtGitHub;}
  });
  await observer.refresh();
  assert.equal(observer.state(repo,branch).headSha,head);
  await observer.refresh();
  assert.equal(requests,1);
  now+=61_000;headAtGitHub=newHead;
  await observer.refresh();
  assert.equal(observer.state(repo,branch).headSha,newHead);
  now+=5*60_000+1;
  assert.equal(observer.state(repo,branch).status,"unknown");
});

test("new verified CI RED during final audit returns to ordinary error retry",()=>{
  const x=fixture();
  try{
    x.startAudit();
    const failed={status:"observed",ciState:"FAILURE",repository:repo,branch,
      headSha:head,observedAt:new Date(x.current()).toISOString(),
      verifiedBranchHead:head,runs:[{
        runId:130,runAttempt:1,headSha:head,ciState:"FAILURE",
        workflowName:"CI"
      }]};
    x.ci(failed);
    const ciIdentity="ci:"+repo+":130:1:"+head;
    x.macros.ciFailure=()=>({identity:ciIdentity,repository:repo,
      runId:130,runAttempt:1,headSha:head});
    assert.equal(x.observe().reason,"ROADMAP_AUDIT_CI_RED_RETRY_PENDING");
    assert.equal(x.macros.completion(extensionId,"target"),null);
    assert.equal(x.macros.get(extensionId,"target").enabled,true);
    x.advance(1_000);
    assert.equal(x.observe({roadmapCompleteCue:false,scopeCompleteCue:false,
      replyFingerprint:auditReply}).reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe({roadmapCompleteCue:false,scopeCompleteCue:false,
      replyFingerprint:auditReply}).reason,"WAIT_FRESH_REPLY_OR_INTERVAL");
    x.advance(10*60_000);
    x.ci({...failed,observedAt:new Date(x.current()).toISOString()});
    assert.equal(x.observe({roadmapCompleteCue:false,scopeCompleteCue:false,
      replyFingerprint:auditReply}).reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe({roadmapCompleteCue:false,scopeCompleteCue:false,
      replyFingerprint:auditReply}).macroKey,"ci_red");
    const red=x.macros.claim(extensionId);
    assert.equal(red.macroKey,"ci_red");
    assert.match(red.message,/Run ID 130/);
    assert.ok(x.macros.get(extensionId,"target").enabled);
  }finally{x.close();}
});
test("STOP during an unfinished audit preserves its state without sending",()=>{
  const x=fixture();
  try{
    x.startAudit();
    x.store.setStopped(true);
    x.advance(31_000);
    assert.equal(x.macros.requestObservations(extensionId).length,0);
    assert.equal(x.macros.completion(extensionId,"target").phase,"audit_sent");
    assert.equal(x.macros.get(extensionId,"target").enabled,true);
    assert.equal(x.macros.claim(extensionId),null);
    x.store.setStopped(false);
    assert.equal(x.observe(outcome).reason,"ROADMAP_AUDIT_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe(outcome).completed,true);
  }finally{x.close();}
});
test("uncertain audit message delivery pauses; restart cannot reissue audit",()=>{
  const x=fixture();
  try{
    assert.equal(x.observe().reason,"REPLY_STABILITY_PENDING");
    x.advance(31_000);
    assert.equal(x.observe().macroKey,"audit");
    const request=x.macros.claim(extensionId);
    assert.equal(request.macroKey,"audit");
    const restarted=new ChatMacroController(x.store,{
      bridge:x.bridge,now:x.current
    });
    assert.equal(restarted.get(extensionId,"target").enabled,false);
    assert.equal(restarted.get(extensionId,"target").reason,
      "RESTART_UNCERTAIN_NO_REPLAY");
    assert.equal(restarted.claim(extensionId),null);
    assert.equal(restarted.completion(extensionId,"target").phase,"audit_queued");
  }finally{x.close();}
});

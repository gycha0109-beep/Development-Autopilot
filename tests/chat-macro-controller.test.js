import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController,DEFAULT_MACROS,classifyMacroObservation} from "../local/chat-macro-controller.js";

const EXT="abcdefghijklmnopabcdefghijklmnop",SESSION="session-1",URL="a".repeat(64);
const A="b".repeat(64),B="c".repeat(64);
const base={schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
  verified:true,observedAt:1_000_000,bindingFingerprint:A,replyFingerprint:B,
  lengthWarning:false,connectionWarning:false,providerRestriction:false,
  humanActionCue:false,ciWaitCue:false,scopeCompleteCue:false,
  otherWarning:false,uiAmbiguous:false,assistantBusy:false,
  stopControlVerified:false,composerHasDraft:false,contentComplete:true};
function setup(){
  let now=1_000_000,connected=true,hash=URL;
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({
    clients:[{extensionId:EXT,status:"online",composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId:EXT,sessionKey:SESSION,status:connected?"connected":"missing",urlHash:hash}],
    links:[]
  })};
  const macros=new ChatMacroController(store,{bridge,now:()=>now});
  return {store,macros,setNow:n=>{now=n},setConnected:v=>{connected=v},
    setHash:v=>{hash=v},close:()=>store.close()};
}
function observe(macros,at,flags={}){
  const [request]=macros.requestObservations(EXT);
  assert.ok(request?.requestId);
  return macros.observe(EXT,{requestId:request.requestId,
    observation:{...base,observedAt:at,...flags}});
}
test("seven editable macro skills have clear safe default messages",()=>{
  assert.equal(Object.keys(DEFAULT_MACROS).length,8);
  assert.ok(DEFAULT_MACROS.general.includes("로드맵"));
  const x=setup();
  try{
    assert.equal(x.macros.templates(EXT).general,DEFAULT_MACROS.general);
    x.macros.setTemplate(EXT,{macroKey:"general",prompt:"새로운 로드맵 진행"});
    assert.equal(x.macros.templates(EXT).general,"새로운 로드맵 진행");
    assert.throws(()=>x.macros.setTemplate(EXT,{macroKey:"unknown",prompt:"hi"}),/MACRO_TEMPLATE_INVALID/);
  }finally{x.close();}
});
test("registered chat can arm with zero Workstreams; no workstream is created",()=>{
  const x=setup();
  try{
    const cfg=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:2});
    assert.equal(cfg.enabled,true);
    assert.equal(x.store.list().length,0);
    assert.equal(x.macros.list(EXT).length,1);
    assert.equal(x.macros.view(EXT).globalStopped,false);
  }finally{x.close();}
});
test("completed reply needs two stable observations and exact proof before auto-queue",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    assert.equal(observe(x.macros,1_000_000).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_029_000);
    assert.equal(observe(x.macros,1_029_000).queued,false);
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000).queued,true);
    const cmd=x.macros.claim(EXT);
    assert.equal(cmd.macroKey,"general");
    assert.equal(cmd.observationProof.replyFingerprint,B);
    assert.equal(x.macros.ack(EXT,{id:cmd.id,status:"sent",reason:"SENT"}).status,"sent");
    assert.equal(x.macros.view(EXT).commands[0].state,"sent");
    x.setNow(1_091_000);
    assert.equal(observe(x.macros,1_091_000).queued,false);
    x.setNow(1_122_000);
    assert.equal(observe(x.macros,1_122_000,{replyFingerprint:"d".repeat(64)}).queued,false);
    x.setNow(1_153_000);
    assert.equal(observe(x.macros,1_153_000,{replyFingerprint:"d".repeat(64)}).queued,true);
  }finally{x.close();}
});
test("CI waits for verified failure without manual restart",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const r=observe(x.macros,1_000_000,{ciWaitCue:true});
    assert.equal(r.queued,false);
    assert.equal(r.reason,"WAIT_VERIFIED_CI");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
  }finally{x.close();}
});
test("approval requires human intervention; length warning arms automatic migration",()=>{
  for(const [flag,key] of [["humanActionCue","blocker"]]){
    const x=setup();
    try{
      x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
      const result=observe(x.macros,1_000_000,{[flag]:true});
      assert.equal(result.queued,false);
      assert.equal(result.suggestedMacro,key);
      assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    }finally{x.close();}
  }
});
test("global stop vetoes queued and manual sends without losing configuration",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"manual"});
    x.store.setStopped(true);
    assert.throws(()=>x.macros.enqueue(EXT,SESSION,"general"),/GLOBAL_STOP_ACTIVE/);
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
  }finally{x.close();}
});
test("reconnection with same chat hash preserves config; changed URL hash suspends it",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    x.setConnected(false);x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).reason,"CONNECTION_REATTACH_IN_PROGRESS");
    assert.equal(x.macros.recovery(EXT,SESSION).kind,"disconnect");
    x.setConnected(true);x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    x.setHash("f".repeat(64));x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.match(x.macros.get(EXT,SESSION).reason,/REAPPROVAL/);
  }finally{x.close();}
});
test("manual macro is one-shot and confirmed failures never replay",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"manual"});
    const c=x.macros.enqueue(EXT,SESSION,"ci_red");
    assert.throws(()=>x.macros.enqueue(EXT,SESSION,"general"),/MACRO_NOT_READY/);
    const claim=x.macros.claim(EXT);
    assert.equal(claim.id,c.id);
    assert.equal(claim.observationProof,null);
    x.macros.ack(EXT,{id:claim.id,status:"unknown",reason:"INJECTION_FAILED"});
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.view(EXT).commands[0].state,"unknown");
  }finally{x.close();}
});
test("repeated scope completion triggers roadmap report only once consecutively",()=>{
  const a=classifyMacroObservation({...base,scopeCompleteCue:true});
  assert.equal(a.macro,"roadmap");
  const b=classifyMacroObservation({...base,scopeCompleteCue:true},{lastMacro:"roadmap"});
  assert.equal(b.macro,"general");
});

test("an extension token replacement explicitly revokes old macro consent",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    assert.equal(x.macros.revokeExtension(EXT).revoked,1);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.get(EXT,SESSION).reason,"EXTENSION_REPAIRED_REAPPROVAL");
  }finally{x.close();}
});
test("incomplete observation flags cannot create an automatic continuation",()=>{
  const incomplete={...base};
  delete incomplete.humanActionCue;
  assert.equal(classifyMacroObservation(incomplete).reason,"OBSERVATION_FLAGS_INCOMPLETE");
});
test("a newly linked legacy Workstream suspends standalone automation",()=>{
  let links=[];
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({
    clients:[{extensionId:EXT,status:"online",composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId:EXT,sessionKey:SESSION,status:"connected",urlHash:URL}],links
  })};
  const macros=new ChatMacroController(store,{bridge,now:()=>1_000_000});
  try{
    macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    links=[{extensionId:EXT,sessionKey:SESSION,workstreamId:"legacy"}];
    macros.reconcile();
    assert.equal(macros.get(EXT,SESSION).enabled,false);
    assert.equal(macros.get(EXT,SESSION).reason,"LEGACY_WORKSTREAM_LINK_CONFLICT");
    assert.throws(()=>macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"}),
      /MACRO_LEGACY_WORKSTREAM_LINK_ACTIVE/);
  }finally{store.close();}
});
test("an uncertain claimed message after server restart pauses the chat, never replays",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const c=x.macros.enqueue(EXT,SESSION,"general");
    assert.equal(x.macros.claim(EXT).id,c.id);
    const restarted=new ChatMacroController(x.store,{bridge:x.macros.bridge,
      now:()=>1_030_000});
    assert.equal(restarted.get(EXT,SESSION).enabled,false);
    assert.equal(restarted.view(EXT).commands[0].state,"unknown");
    assert.equal(restarted.claim(EXT),null);
  }finally{x.close();}
});
test("expired command lease transitions to uncertain and disables auto replay",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    x.macros.enqueue(EXT,SESSION,"general");
    x.macros.claim(EXT);
    x.setNow(1_121_000);x.macros.reconcile();
    assert.equal(x.macros.view(EXT).commands[0].state,"unknown");
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
  }finally{x.close();}
});

test("disconnected response clicks stop exactly once then waits for independent stop verification",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    const failure={connectionWarning:true,connectionWarningKind:"disconnect",
      recoveryWarningSafe:true,replyFingerprint:null,contentComplete:false,
      assistantBusy:true,stopControlVerified:true};
    const first=observe(x.macros,1_000_000,failure);
    assert.equal(first.queued,false);
    assert.equal(first.recoveryAction?.kind,"verified-disconnect-stop");
    const op=first.recoveryAction;
    const safe={...base,...failure,observedAt:1_000_000};
    assert.equal(x.macros.authorizeRecovery(EXT,{operationId:op.operationId,
      sessionKey:SESSION,bindingFingerprint:op.bindingFingerprint,
      observation:safe}).authorized,true);
    assert.equal(x.macros.authorizeRecovery(EXT,{operationId:op.operationId,
      sessionKey:SESSION,bindingFingerprint:op.bindingFingerprint,
      observation:safe}).authorized,false);
    assert.equal(x.macros.acknowledgeRecovery(EXT,{
      operationId:op.operationId,outcome:"clicked"}).accepted,true);
    x.setNow(1_001_000);
    assert.equal(observe(x.macros,1_001_000,failure).reason,"WAIT_STOP_CONFIRMED");
    x.setNow(1_002_000);
    const done=observe(x.macros,1_002_000,{
      ...failure,assistantBusy:false,stopControlVerified:false,
      diagnostic:{threadForms:1,threadEditors:1}
    });
    assert.equal(done.queued,true);
    assert.equal(done.macroKey,"disconnect");
    const claim=x.macros.claim(EXT);
    assert.equal(claim.macroKey,"disconnect");
    assert.equal(claim.message,"현황 파악하고 계속 진행");
    assert.equal(claim.recoveryProof.kind,"disconnect_stopped");
    assert.equal(claim.recoveryProof.operationId,op.operationId);
    x.macros.ack(EXT,{id:claim.id,status:"sent",reason:"VERIFIED_SUBMITTED"});
    assert.equal(x.macros.recovery(EXT,SESSION).state,"recovered");
    x.setNow(1_004_000);
    assert.equal(observe(x.macros,1_004_000,failure).reason,"RECOVERY_ALREADY_HANDLED");
    assert.equal(x.macros.view(EXT).commands.length,1);
  }finally{x.close();}
});
test("send timeout queues continuation without pressing any stop button",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    const timeout={connectionWarning:true,connectionWarningKind:"send_timeout",
      recoveryWarningSafe:true,replyFingerprint:null,contentComplete:false,
      assistantBusy:false,stopControlVerified:false};
    const result=observe(x.macros,1_000_000,timeout);
    assert.equal(result.queued,true);
    assert.equal(result.macroKey,"network");
    assert.equal(x.macros.recovery(EXT,SESSION).operationId,null);
    const claimed=x.macros.claim(EXT);
    assert.equal(claimed.message,"현황 파악하고 계속 진행");
    assert.equal(claimed.recoveryProof.kind,"send_timeout");
    assert.equal(claimed.observationProof,null);
    x.macros.ack(EXT,{id:claimed.id,status:"sent",reason:"SENT_ONCE"});
    x.setNow(1_030_000);
    assert.equal(observe(x.macros,1_030_000,timeout).reason,"RECOVERY_ALREADY_HANDLED");
    assert.equal(x.macros.view(EXT).commands.length,1);
  }finally{x.close();}
});
test("disconnected chat automatically reattaches then selects connection recovery macro",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    x.setConnected(false);x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.recovery(EXT,SESSION).kind,"disconnect");
    x.setConnected(true);x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(observe(x.macros,1_000_000).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_031_000);
    const result=observe(x.macros,1_031_000);
    assert.equal(result.queued,true);
    assert.equal(result.macroKey,"disconnect");
  }finally{x.close();}
});
test("repeated unsafe connection warning escalates after bounded automatic attempts",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    for(let i=0;i<5;i++){
      if(i)x.setNow(1_000_000+1_000_000*i);
      const result=observe(x.macros,1_000_000+1_000_000*i,
        {connectionWarning:true,assistantBusy:false,stopControlVerified:false});
      assert.equal(result.queued,false);
    }
    assert.equal(x.macros.get(EXT,SESSION).status,"needs_attention");
    assert.equal(x.macros.recovery(EXT,SESSION).state,"attention");
    assert.equal(x.macros.view(EXT).commands.length,0);
  }finally{x.close();}
});

test("automatic blocker notification is one-shot, never an approval or auto-resume",async()=>{
  const x=setup(),out=[];
  try{
    x.macros.alertEnabled=true;
    x.macros.sendAlert=async message=>{out.push(message);return true};
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const result=observe(x.macros,1_000_000,{humanActionCue:true});
    assert.equal(result.queued,false);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.alerts(EXT).length,1);
    assert.equal((await x.macros.drainAlerts()).status,"accepted");
    assert.equal((await x.macros.drainAlerts()).status,"empty");
    assert.equal(out.length,1);
    assert.match(out[0],/USER_APPROVAL_OR_PROVIDER_BLOCKER/);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});
test("ambiguous Telegram delivery never retries a possibly sent alert",async()=>{
  const x=setup();
  try{
    x.macros.alertEnabled=true;
    let sends=0;
    x.macros.sendAlert=async()=>{sends++;throw Error("provider_timeout")};
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    observe(x.macros,1_000_000,{humanActionCue:true});
    assert.equal((await x.macros.drainAlerts()).status,"unknown");
    assert.equal((await x.macros.drainAlerts()).status,"empty");
    assert.equal(sends,1);
    assert.equal(x.macros.alerts(EXT)[0].state,"unknown");
  }finally{x.close();}
});

test("plain chat length warning schedules automatic migration without turning off automation",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const result=observe(x.macros,1_000_000,{lengthWarning:true});
    assert.equal(result.queued,false);
    assert.equal(result.automaticMigration,true);
    assert.equal(result.reason,"AUTO_MIGRATION_WATCH_PENDING");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.deepEqual(x.macros.generalMigrationTargets(EXT),[
      {sessionKey:SESSION,sourceKind:"chat-macro-general",
        migrationStatus:"waiting",repository:null}
    ]);
    const paused=x.macros.pauseForMigration(EXT,SESSION,{generic:true});
    assert.equal(paused.macroSession,true);
    assert.equal(x.macros.get(EXT,SESSION).status,"migrating");
  }finally{x.close();}
});
test("failed automatic migration pauses only the chat and records operator alert",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    x.macros.pauseForMigration(EXT,SESSION,{generic:true});
    assert.equal(x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"GENERIC_MIGRATION_NEEDS_ATTENTION"}).accepted,true);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.get(EXT,SESSION).reason,"GENERIC_MIGRATION_NEEDS_ATTENTION");
    assert.equal(x.macros.alerts(EXT).length,1);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});

test("post-send generation is a waiting state, not a reason to disable automation",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    assert.equal(observe(x.macros,1_000_000).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000).queued,true);
    const sent=x.macros.claim(EXT);
    x.macros.ack(EXT,{id:sent.id,status:"sent"});
    x.setNow(1_035_000);
    const pending=observe(x.macros,1_035_000,{
      replyFingerprint:null,assistantBusy:true,contentComplete:false
    });
    assert.equal(pending.reason,"WAIT_POST_SEND_REPLY");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.claim(EXT),null);
    x.setNow(1_050_000);
    assert.equal(observe(x.macros,1_050_000,{
      verified:false,replyFingerprint:null,reasonCode:"DOM_OBSERVATION_FAILED"
    }).reason,"WAIT_POST_SEND_REPLY");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    x.setNow(1_092_000);
    assert.equal(observe(x.macros,1_092_000,{replyFingerprint:"d".repeat(64)}).queued,false);
    x.setNow(1_124_000);
    assert.equal(observe(x.macros,1_124_000,{replyFingerprint:"d".repeat(64)}).queued,true);
  }finally{x.close();}
});
test("post-send grace cannot authorize a wrong-chat observation or an automatic resend",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    observe(x.macros,1_000_000);
    x.setNow(1_031_000);
    observe(x.macros,1_031_000);
    const sent=x.macros.claim(EXT);
    x.macros.ack(EXT,{id:sent.id,status:"sent"});
    x.setNow(1_032_000);
    const invalid=observe(x.macros,1_032_000,{
      verified:false,replyFingerprint:null,reasonCode:"CONVERSATION_MISMATCH"
    });
    assert.equal(invalid.reason,"OBSERVATION_UNVERIFIED");
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});


test("decision matrix: CI RUNNING means no command at any ten-minute check",()=>{
  for(const waitCue of [true,false]){
    const x=setup();
    try{
      x.macros.setChatCiStatus(()=>({status:"observed",ciState:"RUNNING"}));
      x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
        intervalMinutes:10,repository:"owner/repo"});
      for(const at of [1_000_000,1_031_000,1_600_000,2_200_000]){
        x.setNow(at);
        const result=observe(x.macros,at,{ciWaitCue:waitCue});
        assert.equal(result.queued,false);
        assert.equal(result.reason,"WAIT_VERIFIED_CI");
        assert.equal(x.macros.claim(EXT),null);
      }
      assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    }finally{x.close();}
  }
});

test("decision matrix: CI status unavailable or ambiguous means no prompt",()=>{
  for(const state of [
    {status:"unknown",ciState:"UNKNOWN"},
    {status:"ambiguous",ciState:"AMBIGUOUS"},
    {status:"observed",ciState:"UNKNOWN"}
  ]){
    const x=setup();
    try{
      x.macros.setChatCiStatus(()=>state);
      x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
        intervalMinutes:10,repository:"owner/repo"});
      for(const at of [1_000_000,1_600_000]){
        x.setNow(at);
        const result=observe(x.macros,at);
        assert.equal(result.queued,false);
        assert.equal(result.reason,"CI_STATUS_UNAVAILABLE");
        assert.equal(x.macros.claim(EXT),null);
      }
    }finally{x.close();}
  }
});

test("decision matrix: completed GREEN and completed chat send only default progress",()=>{
  const x=setup();
  try{
    let state={status:"observed",ciState:"RUNNING"};
    x.macros.setChatCiStatus(()=>state);
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,repository:"owner/repo"});
    assert.equal(observe(x.macros,1_000_000,{ciWaitCue:true}).queued,false);
    state={status:"observed",ciState:"SUCCESS"};
    x.setNow(1_600_000);
    assert.equal(observe(x.macros,1_600_000,{ciWaitCue:true}).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_631_000);
    assert.equal(observe(x.macros,1_631_000,{ciWaitCue:true}).macroKey,"general");
    const cmd=x.macros.claim(EXT);
    assert.equal(cmd.message,DEFAULT_MACROS.general);
    assert.match(cmd.message,/계속 진행/);
    x.macros.ack(EXT,{id:cmd.id,status:"sent"});
    x.setNow(1_800_000);
    assert.equal(observe(x.macros,1_800_000,{ciWaitCue:true}).queued,false);
  }finally{x.close();}
});

test("decision matrix: assistant still generating or draft is never another send",()=>{
  const x=setup();
  try{
    x.macros.setChatCiStatus(()=>({status:"observed",ciState:"SUCCESS"}));
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,repository:"owner/repo"});
    const running=observe(x.macros,1_000_000,{assistantBusy:true});
    assert.equal(running.queued,false);
    x.setNow(1_600_000);
    const drafting=observe(x.macros,1_600_000,{composerHasDraft:true});
    assert.equal(drafting.queued,false);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});

test("decision matrix: unlinked chat awaiting CI does not guess success",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:10});
    for(const at of [1_000_000,1_600_000]){
      x.setNow(at);
      assert.equal(observe(x.macros,at,{ciWaitCue:true}).reason,"WAIT_VERIFIED_CI");
      assert.equal(x.macros.claim(EXT),null);
    }
    x.setNow(2_200_000);
    assert.equal(observe(x.macros,2_200_000,{ciWaitCue:false}).reason,"REPLY_STABILITY_PENDING");
    x.setNow(2_231_000);
    assert.equal(observe(x.macros,2_231_000,{ciWaitCue:false}).macroKey,"general");
  }finally{x.close();}
});

test("workflow scope persists across normal macro config edits and rejects invalid names",()=>{
  const x=setup();
  try{
    const cfg=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,repository:"owner/repo",ciBranch:"main",
      ciWorkflows:["CI","Governance","Supabase Production"]});
    assert.deepEqual(cfg.ciWorkflows,["CI","Governance","Supabase Production"]);
    const again=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:10});
    assert.deepEqual(again.ciWorkflows,cfg.ciWorkflows);
    assert.throws(()=>x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,ciWorkflows:["CI","CI"]}),/MACRO_CI_WORKFLOW_SCOPE_INVALID/);
    assert.throws(()=>x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,ciWorkflows:["CI\nGovernance"]}),/MACRO_CI_WORKFLOW_SCOPE_INVALID/);
  }finally{x.close();}
});

test("payment scoped main CI GREEN ignores unrelated Admin console failure",()=>{
  const x=setup();
  try{
    const sha="a".repeat(40);
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,repository:"owner/repo",ciBranch:"main",
      ciWorkflows:["CI","Governance"]});
    x.macros.setChatCiStatus((repo,branch,workflows)=>{
      assert.equal(repo,"owner/repo");assert.equal(branch,"main");
      assert.deepEqual(workflows,["CI","Governance"]);
      return {status:"observed",ciState:"SUCCESS"};
    });
    x.macros.setCIProvider(()=>({
      registry:{status:"observed",repositories:[{name:"owner/repo"}]},
      scan:{status:"observed",checkedAt:1_031_000,repositories:[{
        repository:"owner/repo",branch:"main",headSha:sha,
        status:"observed",observedAt:new Date(1_031_000).toISOString(),
        runs:[{runId:121,runAttempt:1,headSha:sha,workflowName:"Admin Console Private Build",
          ciState:"FAILURE",createdAt:new Date(1_031_000).toISOString()}]
      }]},
      incidents:[{state:"open",code:"CI_FAILED",scope:"repo:owner/repo:121:1"}]
    }));
    assert.equal(x.macros.ciFailure("owner/repo","main",["CI","Governance"]),null);
    assert.equal(observe(x.macros,1_000_000,{ciWaitCue:true}).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000,{ciWaitCue:true}).macroKey,"general");
    assert.equal(x.macros.claim(EXT).message,DEFAULT_MACROS.general);
  }finally{x.close();}
});

test("GREEN after previous roadmap report resumes once without a changed assistant reply",()=>{
  const x=setup();
  try{
    x.macros.setChatCiStatus(()=>({status:"observed",ciState:"SUCCESS"}));
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10,repository:"owner/repo",ciBranch:"main"});
    x.macros.db.prepare("UPDATE macro_sessions SET last_reply=?,last_macro='roadmap',last_sent_at=?,next_due=? WHERE extension_id=? AND session_key=?")
      .run(B,300_000,900_000,EXT,SESSION);
    assert.equal(observe(x.macros,1_000_000,{ciWaitCue:true}).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000,{ciWaitCue:true}).macroKey,"general");
    const cmd=x.macros.claim(EXT);
    assert.equal(cmd.message,DEFAULT_MACROS.general);
    x.macros.ack(EXT,{id:cmd.id,status:"sent"});
    x.setNow(1_700_000);
    assert.equal(observe(x.macros,1_700_000,{ciWaitCue:true}).queued,false);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});

test("Telegram alerts are persisted when not configured and sent only after enrollment",async()=>{
  const x=setup(),texts=[];
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const stop=observe(x.macros,1_000_000,{humanActionCue:true});
    assert.equal(stop.queued,false);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.alerts(EXT)[0].state,"pending");
    assert.equal((await x.macros.drainAlerts()).status,"telegram_setup_required");
    assert.equal(x.macros.alerts(EXT)[0].state,"pending");
    x.macros.alertConfigured=()=>true;
    x.macros.sendAlert=async text=>{texts.push(text);return true;};
    assert.equal((await x.macros.drainAlerts()).status,"accepted");
    assert.equal(texts.length,1);
    assert.match(texts[0],/USER_APPROVAL_OR_PROVIDER_BLOCKER/);
    assert.equal((await x.macros.drainAlerts()).status,"empty");
  }finally{x.close();}
});
test("obsolete approval alert is never sent when chat no longer needs approval",async()=>{
  const x=setup(),messages=[];
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    observe(x.macros,1_000_000,{humanActionCue:true});
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    x.macros.alertConfigured=()=>true;
    x.macros.sendAlert=async text=>{messages.push(text);return true;};
    assert.equal((await x.macros.drainAlerts()).status,"obsolete");
    assert.equal(messages.length,0);
  }finally{x.close();}
});
test("long transient DOM failure waits for re-observation rather than disabling Saju",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5});
    x.macros.db.prepare("UPDATE macro_sessions SET last_sent_at=?,next_due=? WHERE extension_id=? AND session_key=?")
      .run(100_000,400_000,EXT,SESSION);
    x.setNow(1_000_000);
    const pending=observe(x.macros,1_000_000,{
      verified:false,replyFingerprint:null,reasonCode:"DOM_OBSERVATION_FAILED"
    });
    assert.equal(pending.reason,"OBSERVATION_RETRY_PENDING");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.alerts(EXT)[0].kind,"observation_uncertain");
    x.setNow(1_300_000);
    assert.equal(observe(x.macros,1_300_000,{
      verified:false,replyFingerprint:null,reasonCode:undefined
    }).reason,"OBSERVATION_RETRY_PENDING");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.claim(EXT),null);
    x.setNow(1_330_000);
    assert.equal(observe(x.macros,1_330_000,{assistantBusy:true,replyFingerprint:null}).queued,false);
  }finally{x.close();}
});
test("an explicitly wrong conversation remains paused instead of silently retrying",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5});
    const invalid=observe(x.macros,1_000_000,{
      verified:false,replyFingerprint:null,reasonCode:"CONVERSATION_MISMATCH"
    });
    assert.equal(invalid.reason,"OBSERVATION_UNVERIFIED");
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
  }finally{x.close();}
});

test("deleted CI branch pauses only its affected chat and alerts operator once",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5,
      repository:"example/ops",ciBranch:"docs/ops/merged"});
    x.macros.setChatCiStatus(()=>({status:"unknown",ciState:"UNKNOWN",
      errorCode:"GITHUB_BRANCH_NOT_FOUND"}));
    x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.get(EXT,SESSION).reason,"CI_BRANCH_REMOVED_NEEDS_NEW_TARGET");
    assert.equal(x.macros.alerts(EXT)[0].state,"pending");
    const count=x.macros.alerts(EXT).length;
    x.macros.reconcile();
    assert.equal(x.macros.alerts(EXT).length,count);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});
test("transient GitHub unavailability does not stop an opted-in chat",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5,
      repository:"example/ops",ciBranch:"docs/ops/active"});
    x.macros.setChatCiStatus(()=>({status:"unknown",ciState:"UNKNOWN",
      errorCode:"GITHUB_CI_UNAVAILABLE"}));
    x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
  }finally{x.close();}
});

test("failed project migration stops only the in-flight project chat and never replays",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/payment",ciBranch:"main",intervalMinutes:5});
    x.macros.pauseForMigration(EXT,SESSION);
    const result=x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"AUTO_MIGRATION_NEEDS_ATTENTION"
    });
    assert.equal(result.accepted,true);
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.get(EXT,SESSION).reason,"AUTO_MIGRATION_NEEDS_ATTENTION");
    assert.equal(x.macros.alerts(EXT).length,1);
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"AUTO_MIGRATION_NEEDS_ATTENTION"
    }).accepted,false);
    assert.equal(x.macros.alerts(EXT).length,1);
  }finally{x.close();}
});
test("a late project migration failure cannot stop an active chat after successful cutover",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/payment",ciBranch:"main"});
    const refused=x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"AUTO_MIGRATION_NEEDS_ATTENTION"
    });
    assert.equal(refused.accepted,false);
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.alerts(EXT).length,0);
  }finally{x.close();}
});
test("a stagnant migrating chat generates one alert but is not resumed or resent",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/payment",ciBranch:"main",intervalMinutes:5});
    x.macros.pauseForMigration(EXT,SESSION);
    x.setNow(1_000_000+20*60_000+10);
    x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).status,"migrating");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.alerts(EXT).length,1);
    assert.equal(x.macros.alerts(EXT)[0].reason,"MIGRATION_STALLED_CONFIRM_STAGE");
    x.macros.reconcile();
    assert.equal(x.macros.alerts(EXT).length,1);
  }finally{x.close();}
});

test("paused approval automatically resumes only after two clean stable observations",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5});
    assert.equal(observe(x.macros,1_000_000,{humanActionCue:true}).reason,
      "USER_APPROVAL_OR_PROVIDER_BLOCKER");
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    const first=x.macros.requestObservations(EXT);
    assert.equal(first.length,1);
    assert.equal(x.macros.observe(EXT,{requestId:first[0].requestId,
      observation:{...base,observedAt:1_000_000}}).reason,
      "APPROVAL_RESOLUTION_STABILITY_PENDING");
    x.setNow(1_010_000);
    assert.equal(observe(x.macros,1_010_000).resumed,undefined);
    x.setNow(1_032_000);
    const resumed=observe(x.macros,1_032_000);
    assert.equal(resumed.resumed,true);
    assert.equal(resumed.queued,false);
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.get(EXT,SESSION).reason,"APPROVAL_RESOLVED_VERIFIED");
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});
test("approval still present or ambiguous never resumes the paused chat",()=>{
  for(const flags of [{humanActionCue:true},{providerRestriction:true},
    {uiAmbiguous:true},{assistantBusy:true,contentComplete:false}]){
    const x=setup();
    try{
      x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
      observe(x.macros,1_000_000,{humanActionCue:true});
      x.setNow(1_033_000);
      const event=observe(x.macros,1_033_000,flags);
      assert.equal(event.queued,false);
      assert.equal(x.macros.get(EXT,SESSION).enabled,false);
      assert.equal(x.macros.claim(EXT),null);
    }finally{x.close();}
  }
});
test("selected roadmap persists across repeat cycles without overriding CI RED safety",()=>{
  const x=setup();
  try{
    const cfg=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      preferredMacroKey:"roadmap",intervalMinutes:1});
    assert.equal(cfg.preferredMacroKey,"roadmap");
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    assert.equal(x.macros.get(EXT,SESSION).preferredMacroKey,"roadmap");
    assert.throws(()=>x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,
      preferredMacroKey:"disconnect"}),/MACRO_PREFERRED_KEY_INVALID/);
    observe(x.macros,1_000_000);
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000).queued,true);
    assert.equal(x.macros.claim(EXT).macroKey,"roadmap");

  }finally{x.close();}
});

test("explicit approval rearm preserves reply and CI identity but never sends immediately",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/repo",ciBranch:"main",intervalMinutes:5});
    observe(x.macros,1_000_000,{humanActionCue:true});
    const before=x.macros.get(EXT,SESSION);
    assert.equal(before.enabled,false);
    assert.throws(()=>x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:false}),
      /MACRO_APPROVAL_RESUME_CONFIRM_REQUIRED/);
    const result=x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:true});
    assert.equal(result.resumed,true);
    assert.equal(result.messageSent,false);
    const after=x.macros.get(EXT,SESSION);
    assert.equal(after.enabled,true);
    assert.equal(after.reason,"OPERATOR_APPROVAL_CONFIRMED_REVERIFY");
    assert.equal(after.lastReplyFingerprint,before.lastReplyFingerprint);
    assert.equal(after.lastSentAt,before.lastSentAt);
    assert.equal(after.repository,before.repository);
    assert.equal(after.ciBranch,before.ciBranch);
    assert.equal(x.macros.claim(EXT),null);
    assert.throws(()=>x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:true}),
      /MACRO_APPROVAL_RESUME_NOT_ELIGIBLE/);
  }finally{x.close();}
});

test("choosing a different macro on an active chat preserves prior send proof and schedule",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    observe(x.macros,1_000_000);
    x.setNow(1_031_000);
    observe(x.macros,1_031_000);
    const command=x.macros.claim(EXT);
    assert.equal(command.macroKey,"general");
    x.macros.ack(EXT,{id:command.id,status:"sent",reason:"SENT"});
    const before=x.macros.get(EXT,SESSION);
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:1,preferredMacroKey:"roadmap"});
    const after=x.macros.get(EXT,SESSION);
    assert.equal(after.preferredMacroKey,"roadmap");
    assert.equal(after.lastReplyFingerprint,before.lastReplyFingerprint);
    assert.equal(after.lastSentAt,before.lastSentAt);
    assert.equal(after.lastMacro,before.lastMacro);
    assert.equal(after.updatedAt,before.updatedAt);
    x.setNow(1_092_000);
    assert.equal(observe(x.macros,1_092_000).queued,false);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});

test("operator-confirmed finished approval resumes once when only the old assistant text remains",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/repo",ciBranch:"main",intervalMinutes:1});
    const stale={humanActionCue:true,humanActionCategory:"approval",
      toolApproval:{pending:false}};
    assert.equal(observe(x.macros,1_000_000,stale).reason,
      "USER_APPROVAL_OR_PROVIDER_BLOCKER");
    x.macros.setChatCiStatus(()=>({status:"observed",ciState:"SUCCESS"}));
    x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:true});
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    x.setNow(1_005_000);
    assert.equal(observe(x.macros,1_005_000,stale).reason,
      "APPROVAL_REVERIFY_STABILITY_PENDING");
    x.setNow(1_038_000);
    assert.equal(observe(x.macros,1_038_000,stale).reason,
      "APPROVAL_REVERIFY_INTERVAL_PENDING");
    x.setNow(1_062_000);
    const continuation=observe(x.macros,1_062_000,stale);
    assert.equal(continuation.queued,true);
    assert.equal(continuation.reason,"APPROVAL_CONFIRMED_CONTINUATION_ONCE");
    const command=x.macros.claim(EXT);
    assert.equal(command.macroKey,"general");
    assert.match(command.message,/사용자가 이전 승인 절차를 완료/);
    x.macros.ack(EXT,{id:command.id,status:"sent",reason:"SENT"});
    x.setNow(1_064_000);
    assert.equal(observe(x.macros,1_064_000,stale).reason,"WAIT_POST_SEND_REPLY");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    x.setNow(1_070_000);
    assert.equal(observe(x.macros,1_070_000,stale).reason,"WAIT_POST_SEND_REPLY");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});
test("operator approval rearm still blocks visible tool permissions and CI uncertainty",()=>{
  for(const mode of ["pending-tool","provider","unobserved-ci","running-ci"]){
    const x=setup();
    try{
      x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
        repository:"owner/repo",ciBranch:"main",intervalMinutes:1});
      observe(x.macros,1_000_000,{humanActionCue:true});
      x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:true});
      x.macros.setChatCiStatus(()=>mode==="unobserved-ci"?
        {status:"unavailable"}:{status:"observed",ciState:mode==="running-ci"?"RUNNING":"SUCCESS"});
      x.setNow(1_065_000);
      const flags={humanActionCue:true,humanActionCategory:"approval",
        toolApproval:{pending:mode==="pending-tool"},
        providerRestriction:mode==="provider"};
      assert.equal(observe(x.macros,1_065_000,flags).queued,false);
      x.setNow(1_100_000);
      assert.equal(observe(x.macros,1_100_000,flags).queued,false);
      assert.equal(x.macros.claim(EXT),null);
      assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    }finally{x.close();}
  }
});

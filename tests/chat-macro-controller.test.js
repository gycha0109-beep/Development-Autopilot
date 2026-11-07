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
  assert.equal(Object.keys(DEFAULT_MACROS).length,9);
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
test("saving first-time macro preferences creates a disabled draft and respects global STOP",()=>{
  const x=setup();
  try{
    x.store.setStopped(true);
    const cfg=x.macros.savePreferences(EXT,{sessionKey:SESSION,
      preferredMacroKey:"task_unit",intervalMinutes:13});
    assert.equal(cfg.enabled,false);
    assert.equal(cfg.mode,"manual");
    assert.equal(cfg.status,"disabled");
    assert.equal(cfg.reason,"OPERATOR_DISABLED");
    assert.equal(cfg.preferredMacroKey,"task_unit");
    assert.equal(cfg.intervalMinutes,13);
    assert.equal(cfg.repository,null);
    assert.equal(x.macros.view(EXT).globalStopped,true);
    assert.equal(x.macros.view(EXT).commands.length,0);
  }finally{x.close();}
});

test("saving preferences preserves an existing pause, CI proof and send history",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:5,repository:"owner/repo",ciBranch:"main"});
    x.macros.db.prepare("UPDATE macro_sessions SET last_reply=?,last_macro=?,"+
      "last_sent_at=?,last_ci_identity=?,next_due=? WHERE extension_id=? AND session_key=?")
      .run(B,"general",990_000,"ci-proof",1_500_000,EXT,SESSION);
    x.macros.pause(EXT,SESSION,"USER_APPROVAL_OR_PROVIDER_BLOCKER");
    const before=x.macros.get(EXT,SESSION);
    const after=x.macros.savePreferences(EXT,{sessionKey:SESSION,
      preferredMacroKey:"task_unit",intervalMinutes:13});
    assert.equal(after.enabled,before.enabled);
    assert.equal(after.status,before.status);
    assert.equal(after.reason,before.reason);
    assert.equal(after.repository,before.repository);
    assert.equal(after.ciBranch,before.ciBranch);
    assert.equal(after.lastReplyFingerprint,before.lastReplyFingerprint);
    assert.equal(after.lastSentAt,before.lastSentAt);
    assert.equal(after.lastCiIdentity,before.lastCiIdentity);
    assert.equal(after.nextDue,before.nextDue);
    assert.equal(after.preferredMacroKey,"task_unit");
    assert.equal(after.intervalMinutes,13);
  }finally{x.close();}
});

test("saving preferences rejects a chat whose registered URL identity changed",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:false,mode:"manual"});
    x.setHash("d".repeat(64));
    assert.throws(()=>x.macros.savePreferences(EXT,{sessionKey:SESSION,
      preferredMacroKey:"roadmap",intervalMinutes:8}),
      /MACRO_PREFERENCES_IDENTITY_UNVERIFIED/);
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
test("verified same-tab migration can resume after an earlier failed cutover",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/payment",ciBranch:"main",intervalMinutes:5});
    x.macros.pauseForMigration(EXT,SESSION);
    x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"AUTO_MIGRATION_NEEDS_ATTENTION"
    });
    assert.equal(x.macros.migrationTargets(EXT)[0].repairOnly,true);
    assert.throws(()=>x.macros.resumeAfterMigration(EXT,SESSION),
      /MACRO_MIGRATION_TARGET_NOT_CHANGED/);
    x.setHash("d".repeat(64));
    const restored=x.macros.resumeAfterMigration(EXT,SESSION);
    assert.equal(restored.resumed,true);
    const cfg=x.macros.get(EXT,SESSION);
    assert.equal(cfg.enabled,true);
    assert.equal(cfg.status,"armed");
    assert.equal(cfg.approvedUrlHash,"d".repeat(64));
    assert.equal(cfg.preferredMacroKey,"general");
    assert.equal(Boolean(x.macros.migrationTargets(EXT)[0].repairOnly),false);
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.reportMigrationFailure(EXT,{
      sessionKey:SESSION,reason:"AUTO_MIGRATION_NEEDS_ATTENTION"
    }).accepted,false);
  }finally{x.close();}
});
test("unrelated operator pause can never use migration recovery",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/payment"});
    x.macros.pause(EXT,SESSION,"OPERATOR_STOPPED");
    x.setHash("e".repeat(64));
    assert.throws(()=>x.macros.resumeAfterMigration(EXT,SESSION),
      /MACRO_MIGRATION_NOT_IN_PROGRESS/);
    assert.equal(x.macros.migrationTargets(EXT).length,0);
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

test("multi-repository CI must be observed green before any automatic send",()=>{
  const x=setup();
  try{
    let secondary="RUNNING";
    x.macros.setChatCiStatus((repository,branch)=>{
      if(repository==="owner/Saju")
        return {status:"observed",ciState:secondary};
      return {status:"observed",ciState:"SUCCESS"};
    });
    const cfg=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,
      mode:"auto",intervalMinutes:1,repository:"owner/MyeongHa",ciBranch:"main",
      ciObservers:[{repository:"owner/Saju",branch:"main"}]});
    assert.deepEqual(cfg.ciObservers,[{repository:"owner/Saju",branch:"main"}]);
    assert.equal(observe(x.macros,1_000_000).reason,"WAIT_ADDITIONAL_CI");
    assert.equal(x.macros.claim(EXT),null);
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    secondary="SUCCESS";
    x.setNow(1_031_000);
    assert.equal(observe(x.macros,1_031_000).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_062_000);
    assert.equal(observe(x.macros,1_062_000).queued,true);
    const queuedMessage=x.store.db.prepare(
      "select message from macro_commands where session_key=? order by created_at desc limit 1")
      .get(SESSION)?.message;
    assert.match(queuedMessage,/owner\/Saju @ main/);
    assert.match(queuedMessage,/read only/);
    secondary="FAILURE";
    assert.equal(x.macros.claim(EXT),null);
    const pending=x.store.db.prepare(
      "select state,reason from macro_commands where session_key=? order by created_at desc limit 1")
      .get(SESSION);
    assert.equal(pending.state,"blocked");
    assert.equal(pending.reason,"CI_OBSERVER_NOT_VERIFIED");
  }finally{x.close();}
});
test("invalid duplicate CI observers reject configuration without mutating chat",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      repository:"owner/MyeongHa",ciBranch:"main"});
    for(const observers of [
      [{repository:"owner/MyeongHa",branch:"main"}],
      [{repository:"owner/Saju",branch:"main"},{repository:"owner/Saju",branch:"main"}],
      [{repository:"owner/Saju",branch:"../invalid"}],
      [{repository:"owner/Saju",branch:"main"},null]
    ]){
      assert.throws(()=>x.macros.configure(EXT,{sessionKey:SESSION,
        enabled:true,mode:"auto",repository:"owner/MyeongHa",
        ciBranch:"main",ciObservers:observers}),/MACRO_CI_OBSERVERS_INVALID/);
    }
    assert.deepEqual(x.macros.get(EXT,SESSION).ciObservers,[]);
  }finally{x.close();}
});

test("task-unit macro has the short approved prompt and can be customized independently",()=>{
  const x=setup();
  try{
    assert.ok(DEFAULT_MACROS.task_unit.includes("로드맵이나 새 작업을 임의로 만들지 마세요"));
    assert.ok(DEFAULT_MACROS.task_unit.includes("1~2줄"));
    assert.equal(x.macros.templates(EXT).task_unit,DEFAULT_MACROS.task_unit);
    x.macros.setTemplate(EXT,{macroKey:"task_unit",prompt:DEFAULT_MACROS.task_unit});
    assert.equal(x.macros.templates(EXT).general,DEFAULT_MACROS.general);
    assert.equal(x.macros.templates(EXT).task_unit,DEFAULT_MACROS.task_unit);
  }finally{x.close();}
});

test("task-unit automatic run does not create a roadmap report or audit for completion cues",()=>{
  const x=setup();
  try{
    const cfg=x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      preferredMacroKey:"task_unit",intervalMinutes:1});
    assert.equal(cfg.preferredMacroKey,"task_unit");
    assert.equal(observe(x.macros,1_000_000,{
      scopeCompleteCue:true,roadmapCompleteCue:true
    }).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_031_000);
    const result=observe(x.macros,1_031_000,{
      scopeCompleteCue:true,roadmapCompleteCue:true
    });
    assert.equal(result.queued,true);
    assert.equal(result.macroKey,"task_unit");
    assert.equal(x.macros.completion(EXT,SESSION),null);
    const cmd=x.macros.claim(EXT);
    assert.equal(cmd.macroKey,"task_unit");
    assert.equal(cmd.message.includes("로드맵이나 새 작업을 임의로 만들지 마세요"),true);
    x.macros.ack(EXT,{id:cmd.id,status:"sent",reason:"SENT"});
    assert.equal(x.macros.get(EXT,SESSION).lastMacro,"task_unit");
  }finally{x.close();}
});

test("task-unit macro remains gated by human approval and global stop",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      preferredMacroKey:"task_unit"});
    assert.equal(observe(x.macros,1_000_000,{humanActionCue:true}).reason,
      "USER_APPROVAL_OR_PROVIDER_BLOCKER");
    assert.equal(x.macros.get(EXT,SESSION).enabled,false);
    assert.equal(x.macros.claim(EXT),null);
  }finally{x.close();}
});

test("stale disconnect recovery cannot replace operator approval confirmation",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    x.setConnected(false);x.macros.reconcile();
    x.setConnected(true);x.macros.reconcile();
    x.macros.db.prepare("UPDATE macro_sessions SET enabled=0,status='paused',reason='USER_APPROVAL_OR_PROVIDER_BLOCKER' WHERE extension_id=? AND session_key=?").run(EXT,SESSION);
    x.macros.resumeApproved(EXT,{sessionKey:SESSION,confirmed:true});
    x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).reason,"OPERATOR_APPROVAL_CONFIRMED_REVERIFY");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(x.macros.recovery(EXT,SESSION).kind,"disconnect");
  }finally{x.close();}
});
test("stale disconnect recovery cannot replace observation retry state",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    x.setConnected(false);x.macros.reconcile();
    x.setConnected(true);x.macros.reconcile();
    x.macros.db.prepare("UPDATE macro_sessions SET enabled=1,status='armed',reason='OBSERVATION_RETRY_PENDING' WHERE extension_id=? AND session_key=?").run(EXT,SESSION);
    x.macros.reconcile();
    assert.equal(x.macros.get(EXT,SESSION).reason,"OBSERVATION_RETRY_PENDING");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
  }finally{x.close();}
});

test("paused invalid observation can be explicitly retried without losing send history",()=>{
 const x=setup();
 try{
   x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5});
   x.macros.db.prepare("UPDATE macro_sessions SET last_reply=?,last_macro=?,last_sent_at=? WHERE extension_id=? AND session_key=?")
     .run(B,"general",999_000,EXT,SESSION);
   x.macros.pause(EXT,SESSION,"OBSERVATION_UNVERIFIED");
   const before=x.macros.get(EXT,SESSION);
   const result=x.macros.resumeObservation(EXT,{sessionKey:SESSION});
   assert.equal(result.resumed,true);
   assert.equal(result.messageSent,false);
   const after=x.macros.get(EXT,SESSION);
   assert.equal(after.enabled,true);
   assert.equal(after.reason,"OBSERVATION_RETRY_PENDING");
   assert.equal(after.lastReplyFingerprint,before.lastReplyFingerprint);
   assert.equal(after.lastMacro,before.lastMacro);
   assert.equal(after.lastSentAt,before.lastSentAt);
   assert.equal(x.macros.view(EXT).commands.length,0);
   assert.equal(x.macros.claim(EXT),null);
 }finally{x.close();}
});
test("operator stop or approval blocker cannot be bypassed with observation retry",()=>{
 for(const reason of ["OPERATOR_STOPPED","USER_APPROVAL_OR_PROVIDER_BLOCKER"]){
  const x=setup();
  try{
   x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
   x.macros.pause(EXT,SESSION,reason);
   assert.throws(()=>x.macros.resumeObservation(EXT,{sessionKey:SESSION}),
     /MACRO_OBSERVATION_RETRY_NOT_ELIGIBLE/);
   assert.equal(x.macros.get(EXT,SESSION).enabled,false);
  }finally{x.close();}
 }
});
test("macro dashboard CI summary gives status without exposing run payload",()=>{
 const x=setup();
 try{
  x.macros.setChatCiStatus(()=>({status:"observed",ciState:"FAILURE",
   headSha:"a".repeat(40),runs:[{log:"sensitive details"}]}));
  x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
   repository:"owner/repo",ciBranch:"main"});
  const cfg=x.macros.view(EXT).sessions[0];
  assert.equal(cfg.ci.ciState,"FAILURE");
  assert.equal(cfg.ci.status,"observed");
  assert.equal(cfg.ci.runs,undefined);
 }finally{x.close();}
});

test("CI scope edits preserve paused approval state and previous send evidence",()=>{
 const x=setup();
 try{
  x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
    repository:"owner/MyeongHa",ciBranch:"main",intervalMinutes:5});
  x.macros.db.prepare("UPDATE macro_sessions SET last_reply=?,last_macro=?,last_sent_at=?,last_ci_identity=? WHERE extension_id=? AND session_key=?")
   .run(B,"general",999_000,"identity",EXT,SESSION);
  x.macros.pause(EXT,SESSION,"USER_APPROVAL_OR_PROVIDER_BLOCKER");
  const before=x.macros.get(EXT,SESSION);
  const changed=x.macros.setCiScope(EXT,{sessionKey:SESSION,
   repository:"owner/MyeongHa",ciBranch:"fix/payment",
   ciObservers:[{repository:"owner/Saju",branch:"main"}]});
  const after=x.macros.get(EXT,SESSION);
  assert.equal(changed.saved,true);
  assert.equal(changed.messageSent,false);
  assert.equal(after.enabled,false);
  assert.equal(after.reason,"USER_APPROVAL_OR_PROVIDER_BLOCKER");
  assert.equal(after.ciBranch,"fix/payment");
  assert.deepEqual(after.ciObservers,[{repository:"owner/Saju",branch:"main"}]);
  assert.equal(after.lastReplyFingerprint,before.lastReplyFingerprint);
  assert.equal(after.lastSentAt,before.lastSentAt);
  assert.equal(after.lastMacro,before.lastMacro);
  assert.equal(after.lastCiIdentity,null);
  assert.equal(x.macros.claim(EXT),null);
 }finally{x.close();}
});
test("CI scope change rejects invalid branch and in-flight send",()=>{
 const x=setup();
 try{
  x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
    repository:"owner/Project",ciBranch:"main",intervalMinutes:1});
  assert.throws(()=>x.macros.setCiScope(EXT,{sessionKey:SESSION,
    repository:"owner/Project",ciBranch:"../danger"}),/MACRO_CI_SCOPE_INVALID/);
  x.macros.enqueue(EXT,SESSION,"general",{binding:A,reply:B,urlHash:URL});
  assert.equal(x.macros.view(EXT).commands[0].state,"queued");
  assert.throws(()=>x.macros.setCiScope(EXT,{sessionKey:SESSION,
    repository:"owner/Project",ciBranch:"fix/foo"}),/MACRO_CI_SCOPE_IDENTITY_UNVERIFIED/);
  assert.equal(x.macros.get(EXT,SESSION).ciBranch,"main");
 }finally{x.close();}
});

test("observation pause auto-recovers after two clean independent page checks without sending",()=>{
 const x=setup();
 try{
   x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:5});
   x.macros.db.prepare("UPDATE macro_sessions SET last_reply=?,last_macro=?,last_sent_at=? "+
     "WHERE extension_id=? AND session_key=?").run(B,"general",950_000,EXT,SESSION);
   x.macros.pause(EXT,SESSION,"OBSERVATION_UNVERIFIED");
   const first=observe(x.macros,1_000_000);
   assert.equal(first.queued,false);
   assert.equal(first.reason,"OBSERVATION_AUTO_RECHECK_STABILITY_PENDING");
   assert.equal(x.macros.get(EXT,SESSION).enabled,false);
   x.setNow(1_030_100);
   const second=observe(x.macros,1_030_100);
   assert.equal(second.resumed,true);
   assert.equal(second.messageSent,false);
   assert.equal(x.macros.get(EXT,SESSION).enabled,true);
   assert.equal(x.macros.get(EXT,SESSION).status,"armed");
   assert.equal(x.macros.get(EXT,SESSION).reason,"OBSERVATION_AUTO_RECOVERED_WAIT_NEXT_REPLY");
   assert.equal(x.macros.get(EXT,SESSION).lastSentAt,950_000);
   assert.equal(x.macros.get(EXT,SESSION).lastReplyFingerprint,B);
   assert.equal(x.macros.get(EXT,SESSION).nextDue,1_330_100);
   assert.equal(x.macros.claim(EXT),null);
 }finally{x.close();}
});
test("unclean approval, warnings, draft, bad ID or changing reply never auto-rearm",()=>{
 const x=setup();
 try{
   x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
   x.macros.pause(EXT,SESSION,"OBSERVATION_UNVERIFIED");
   const flags=[
     {humanActionCue:true},{providerRestriction:true},{otherWarning:true},
     {uiAmbiguous:true},{composerHasDraft:true},{toolApproval:{pending:true}},
     {verified:false},{assistantBusy:true},{contentComplete:false}
   ];
   for(const dirty of flags){
     assert.equal(observe(x.macros,1_000_000,dirty).reason,
       "OBSERVATION_AUTO_RECHECK_NOT_SAFE");
     assert.equal(x.macros.get(EXT,SESSION).enabled,false);
   }
   assert.equal(observe(x.macros,1_000_000).reason,
     "OBSERVATION_AUTO_RECHECK_STABILITY_PENDING");
   x.setNow(1_050_000);
   assert.equal(observe(x.macros,1_050_000,{replyFingerprint:"d".repeat(64)}).reason,
     "OBSERVATION_AUTO_RECHECK_STABILITY_PENDING");
   assert.equal(x.macros.get(EXT,SESSION).enabled,false);
 }finally{x.close();}
});
test("operator stop, changed chat identity and global stop cannot auto-rearm",()=>{
 for(const reason of ["OPERATOR_STOPPED","AUTO_MIGRATION_NEEDS_ATTENTION"]){
   const x=setup();
   try{
     x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
     x.macros.pause(EXT,SESSION,reason);
     assert.equal(x.macros.requestObservations(EXT).length,0,reason);
   }finally{x.close();}
 }
 const x=setup();
 try{
   x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
   x.macros.pause(EXT,SESSION,"OBSERVATION_UNVERIFIED");
   x.setHash("d".repeat(64));
   assert.equal(x.macros.requestObservations(EXT).length,0);
   assert.equal(x.macros.get(EXT,SESSION).reason,"CHAT_IDENTITY_CHANGED_REAPPROVAL");
 }finally{x.close();}
 const y=setup();
 try{
   y.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
   y.macros.pause(EXT,SESSION,"OBSERVATION_UNVERIFIED");
   y.store.setStopped(true);
   const r=observe(y.macros,1_000_000);
   assert.equal(r.queued,false);
   assert.equal(r.reason,"OBSERVATION_AUTO_RECHECK_NOT_SAFE");
   assert.equal(y.macros.get(EXT,SESSION).enabled,false);
 }finally{y.close();}
});

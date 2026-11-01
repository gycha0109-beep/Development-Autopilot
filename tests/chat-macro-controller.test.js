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
  assert.equal(Object.keys(DEFAULT_MACROS).length,7);
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
test("approval and hard length warnings prevent unsafe sends",()=>{
  for(const [flag,key] of [["humanActionCue","blocker"],
    ["lengthWarning","migration"]]){
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

test("network warning triggers automatic bounded recovery, not immediate manual pause",()=>{
  const x=setup();
  try{
    x.macros.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",intervalMinutes:1});
    const first=observe(x.macros,1_000_000,{connectionWarning:true,
      assistantBusy:true,stopControlVerified:true});
    assert.equal(first.queued,false);
    assert.equal(first.recovery,"recovering");
    assert.equal(x.macros.get(EXT,SESSION).enabled,true);
    assert.equal(first.recoveryAction?.kind,"verified-disconnect-stop");
    const op=first.recoveryAction;
    const safe={...base,observedAt:1_000_000,connectionWarning:true,
      assistantBusy:true,stopControlVerified:true};
    assert.equal(x.macros.authorizeRecovery(EXT,{operationId:op.operationId,
      sessionKey:SESSION,bindingFingerprint:op.bindingFingerprint,
      observation:safe}).authorized,true);
    assert.equal(x.macros.authorizeRecovery(EXT,{operationId:op.operationId,
      sessionKey:SESSION,bindingFingerprint:op.bindingFingerprint,
      observation:safe}).authorized,false);
    assert.equal(x.macros.acknowledgeRecovery(EXT,{
      operationId:op.operationId,outcome:"clicked"}).accepted,true);
    x.setNow(1_030_000);
    assert.equal(observe(x.macros,1_030_000).reason,"REPLY_STABILITY_PENDING");
    x.setNow(1_061_000);
    const done=observe(x.macros,1_061_000);
    assert.equal(done.queued,true);
    assert.equal(done.macroKey,"network");
    const claim=x.macros.claim(EXT);
    assert.equal(claim.macroKey,"network");
    x.macros.ack(EXT,{id:claim.id,status:"sent",reason:"VERIFIED_SUBMITTED"});
    assert.equal(x.macros.recovery(EXT,SESSION).state,"recovered");
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

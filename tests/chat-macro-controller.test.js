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
test("CI, approval, length and connection warnings pause auto-sends and expose appropriate manual macro",()=>{
  for(const [flag,key] of [["ciWaitCue",null],["humanActionCue","blocker"],
    ["lengthWarning","migration"],["connectionWarning","network"]]){
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
    assert.equal(x.macros.get(EXT,SESSION).reason,"CHAT_DISCONNECTED");
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

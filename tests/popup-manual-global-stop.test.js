import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {WorkstreamStore} from "../local/store.js";
import {ChatMacroController} from "../local/chat-macro-controller.js";

const EXT="abcdefghijklmnopabcdefghijklmnop",SESSION="selected-chat",URL_HASH="a".repeat(64);
const popup=readFileSync(new URL("../extension/popup.html",import.meta.url),"utf8");
const js=readFileSync(new URL("../extension/popup.js",import.meta.url),"utf8");
const background=readFileSync(new URL("../extension/background.js",import.meta.url),"utf8");
const server=readFileSync(new URL("../local/server.js",import.meta.url),"utf8");

function fixture({linked=false}={}){
  let clock=1000000;
  const store=new WorkstreamStore();
  const bridge={getSnapshot:()=>({clients:[{extensionId:EXT,status:"online",
    composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId:EXT,sessionKey:SESSION,status:"connected",urlHash:URL_HASH}],
    links:linked?[{extensionId:EXT,sessionKey:SESSION}]:[]})};
  const macro=new ChatMacroController(store,{bridge,now:()=>clock});
  return {store,macro,advance:ms=>{clock+=ms;},close:()=>store.close()};
}
test("manual CTA is after template save, auto start follows templates",()=>{
  const save=popup.indexOf('id="macro-template-save"');
  const start=popup.indexOf('id="macro-configure"');
  const manual=popup.indexOf('id="macro-send"');
  const stop=popup.indexOf('id="macro-stop"');
  assert.ok(save>0&&start>save&&manual>start&&stop>manual);
  assert.match(popup,/>자동 작업 시작</);
  assert.match(popup,/>선택 매크로 수동 1회</);
  assert.match(js,/el\("macro-configure"\)\.textContent/);
  assert.match(js,/설정을 저장해도 자동 전송은 시작되지 않습니다/);
  assert.match(js,/전체 자동화는 계속 정지됩니다/);
  assert.match(js,/el\("macro-send"\)\.disabled=!selectedQuickTab\(\)/);
  assert.match(popup,/전체 정지 중에도 수동 1회 전송은 가능하지만, 자동 진행은 정지 상태를 유지합니다/);
  assert.match(popup,/id="macro-global-state"/);
  assert.match(popup,/id="macro-global-control"/);
  assert.match(js,/"전체 정지 해제 · 자동화 재개"/);
  assert.match(js,/action:"global",payload:/);
  assert.match(js,/expectedStopped:currentlyStopped,confirmed:true/);
});
test("global STOP blocks all automatic commands but permits an explicit one-shot",()=>{
  const x=fixture();
  try{
    x.macro.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto",
      intervalMinutes:10});
    x.store.setStopped(true);
    assert.throws(()=>x.macro.enqueue(EXT,SESSION,"general"),/GLOBAL_STOP_ACTIVE/);
    assert.equal(x.macro.claim(EXT),null);
    const queued=x.macro.enqueueManual(EXT,SESSION,"general");
    assert.equal(queued.macroKey,"general");
    assert.throws(()=>x.macro.enqueueManual(EXT,SESSION,"general"),/MACRO_NOT_READY/);
    const claim=x.macro.claim(EXT);
    assert.equal(claim.id,queued.id);
    assert.equal(claim.manualOnce,true);
    assert.equal(claim.observationProof,null);
    assert.equal(claim.recoveryProof,null);
    const ack=x.macro.ack(EXT,{id:claim.id,status:"sent"});
    assert.equal(ack.status,"sent");
    assert.equal(x.store.isStopped(),true,"global STOP must remain true");
    assert.equal(x.macro.get(EXT,SESSION).mode,"auto","original auto mode preserved");
    assert.equal(x.macro.get(EXT,SESSION).intervalMinutes,10);
    assert.equal(x.macro.claim(EXT),null);
    assert.equal(x.macro.view(EXT).commands.filter(c=>c.state==="sent").length,1);
  }finally{x.close();}
});
test("stopped claim cannot claim an automatic queue, but can select a manual one",()=>{
  const x=fixture();
  try{
    x.macro.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    const c=x.macro.enqueue(EXT,SESSION,"general");
    x.store.setStopped(true);
    assert.equal(x.macro.claim(EXT),null);
    assert.equal(x.macro.view(EXT).commands[0].state,"queued");
    // A pending automatic command must not be bypassed by manual double-send.
    assert.throws(()=>x.macro.enqueueManual(EXT,SESSION,"general"),/MACRO_NOT_READY/);
    x.store.setStopped(false);
    const claim=x.macro.claim(EXT);
    assert.equal(claim.id,c.id);
    assert.equal(claim.manualOnce,false);
  }finally{x.close();}
});
test("unknown manual send is not replayed after restart",()=>{
  const x=fixture();
  try{
    x.macro.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"manual"});
    x.store.setStopped(true);
    x.macro.enqueueManual(EXT,SESSION,"general");
    const claimed=x.macro.claim(EXT);
    assert.equal(claimed.manualOnce,true);
    const restarted=new ChatMacroController(x.store,{bridge:x.macro.bridge,
      now:()=>1001000});
    assert.equal(restarted.claim(EXT),null);
    assert.equal(restarted.get(EXT,SESSION).enabled,false);
    assert.equal(restarted.view(EXT).commands[0].state,"unknown");
    assert.equal(x.store.isStopped(),true);
  }finally{x.close();}
});
test("manual override never bypasses chat ownership, legacy links or proof gating",()=>{
  const x=fixture({linked:true});
  try{
    assert.throws(()=>x.macro.configure(EXT,{sessionKey:SESSION,
      enabled:true,mode:"manual"}),/MACRO_LEGACY_WORKSTREAM_LINK_ACTIVE/);
  }finally{x.close();}
  const y=fixture();
  try{
    y.macro.configure(EXT,{sessionKey:SESSION,enabled:false,mode:"manual"});
    y.store.setStopped(true);
    assert.throws(()=>y.macro.enqueueManual(EXT,SESSION,"general"),/MACRO_NOT_READY/);
    y.macro.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"manual"});
    assert.throws(()=>y.macro.enqueue(EXT,SESSION,"audit",{manualOnce:true}),
      /MANUAL_ONCE_PROOF_INVALID/);
    assert.throws(()=>y.macro.enqueue(EXT,SESSION,"general",{
      manualOnce:true,reply:"a".repeat(64),binding:"b".repeat(64)}),
      /MANUAL_ONCE_PROOF_INVALID/);
  }finally{y.close();}
});
test("server and Chrome only allow manual override through paired extension manual route",()=>{
  assert.match(server,/macro-send"\)\s*[\s\S]{0,80}enqueueManual/);
  assert.match(background,/claimRoute==="\/api\/v1\/bridge\/macro-claim"&&command\.manualOnce===true/);
  assert.match(background,/result\.authenticated===true/);
});


test("manual queued click expires after two minutes under global STOP",()=>{
  const x=fixture();
  try{
    x.macro.configure(EXT,{sessionKey:SESSION,enabled:true,mode:"auto"});
    x.store.setStopped(true);
    const once=x.macro.enqueueManual(EXT,SESSION,"general");
    x.advance(120001);
    assert.equal(x.macro.claim(EXT),null);
    assert.equal(x.macro.view(EXT).commands.find(c=>c.id===once.id).state,"blocked");
    assert.equal(x.macro.view(EXT).commands.find(c=>c.id===once.id).reason,"MANUAL_ONCE_EXPIRED");
    assert.equal(x.store.isStopped(),true);
  }finally{x.close();}
});

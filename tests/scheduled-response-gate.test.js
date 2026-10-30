import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatContinuation} from "../local/chat-continuation.js";

const EXT="abcdefghijklmnopabcdefghijklmnop";
const SESSION="pie-session";
function fixture(){
  const store=new WorkstreamStore();
  let now=1_000_000,connected=true;
  store.create({id:"pie",name:"PIE",projectKey:"pie",repository:"owner/pie"},now);
  const bridge={getSnapshot:()=>({
    clients:[{extensionId:EXT,status:connected?"online":"offline",composerBuild:"composer-2026-10-15-r17"}],
    sessions:[{extensionId:EXT,sessionKey:SESSION,status:connected?"connected":"stale",origin:"https://chatgpt.com"}],
    links:[{workstreamId:"pie",extensionId:EXT,sessionKey:SESSION,status:connected?"connected":"stale"}]
  })};
  const empty={targets:{list:()=>[]}};
  const chat=new ChatContinuation(store,{bridge,watchtower:empty,github:empty,
    gate:{one:()=>null},now:()=>now});
  chat.configure("pie",{enabled:true,mode:"scheduled",message:"로드맵 따라서 계속 진행",
    intervalMinutes:10});
  const sample=(overrides={})=>({
    schemaVersion:1,sourceVersion:"chat-observer-1",source:"chatgpt-dom",
    verified:true,assistantBusy:false,composerHasDraft:false,stopControlVerified:false,
    contentComplete:true,uiAmbiguous:false,connectionWarning:false,lengthWarning:false,
    providerRestriction:false,otherWarning:false,humanActionCue:false,scopeCompleteCue:false,
    ciWaitCue:false,bindingFingerprint:"b".repeat(64),replyFingerprint:"a".repeat(64),
    observedAt:now,...overrides
  });
  const deliver=(overrides={})=>{
    const request=chat.requestObservations(EXT)[0];
    assert.ok(request,"fresh read-only challenge");
    return chat.acceptObservation(EXT,{requestId:request.requestId,observation:sample(overrides)});
  };
  return {store,chat,bridge,sample,deliver,clock:x=>now=x,now:()=>now,
    offline:()=>{connected=false},close:()=>store.close()};
}
test("scheduled sends fail closed until the same completed reply is observed twice",()=>{
  const x=fixture();try{
    x.clock(1_600_000);
    assert.deepEqual(x.chat.tick(),[]);
    x.clock(1_530_000);assert.equal(x.deliver().stable,false);
    x.clock(1_540_000);assert.equal(x.deliver({assistantBusy:true}).accepted,false);
    x.clock(1_550_000);assert.equal(x.deliver().stable,false);
    x.clock(1_600_000);assert.equal(x.deliver().stable,true);
    assert.equal(x.chat.tick().length,1);
    assert.equal(x.chat.tick().length,0,"one pending command, never duplicate");
  }finally{x.close()}
});
test("unsafe composer, stop, warnings, ambiguity, CI wait, approval and complete scope never arm sends",()=>{
  const unsafe=[
    {assistantBusy:true},{composerHasDraft:true},{stopControlVerified:true},
    {connectionWarning:true},{lengthWarning:true},{providerRestriction:true},
    {otherWarning:true},{uiAmbiguous:true},{humanActionCue:true},
    {scopeCompleteCue:true},{ciWaitCue:true},{contentComplete:false},
    {replyFingerprint:null},{verified:false}
  ];
  for(const condition of unsafe){
    const x=fixture();try{
      x.clock(1_520_000);x.deliver();
      x.clock(1_600_000);assert.equal(x.deliver(condition).accepted,false);
      assert.equal(x.chat.tick().length,0,JSON.stringify(condition));
    }finally{x.close()}
  }
});
test("claimed scheduled command carries exact proof and same completed reply cannot be sent twice",()=>{
  const x=fixture();try{
    x.clock(1_530_000);x.deliver();
    x.clock(1_600_000);x.deliver();
    const job=x.chat.tick()[0];
    assert.ok(job?.id);
    const claim=x.chat.claim(EXT);
    assert.equal(claim.observationProof.bindingFingerprint,"b".repeat(64));
    assert.equal(claim.observationProof.replyFingerprint,"a".repeat(64));
    assert.equal(x.chat.claim(EXT),null);
    x.chat.acknowledge(EXT,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    x.clock(2_150_000);x.deliver();
    x.clock(2_220_000);x.deliver();
    assert.equal(x.chat.tick().length,0,"previous fingerprint already used");
    x.clock(2_300_000);x.deliver({replyFingerprint:"c".repeat(64)});
    x.clock(2_365_000);x.deliver({replyFingerprint:"c".repeat(64)});
    const next=x.chat.tick();
    assert.equal(next.length,1);
    assert.equal(x.chat.claim(EXT).observationProof.replyFingerprint,"c".repeat(64));
  }finally{x.close()}
});
test("changed response between claim and dispatch invalidates the queued command",()=>{
  const x=fixture();try{
    x.clock(1_530_000);x.deliver();
    x.clock(1_600_000);x.deliver();
    const pending=x.chat.tick()[0];
    x.clock(1_610_000);x.deliver({assistantBusy:true});
    assert.equal(x.chat.claim(EXT),null);
    assert.equal(x.chat.commands()[0].state,"blocked");
    assert.equal(x.chat.config("pie").enabled,false);
    assert.equal(x.chat.commands()[0].id,pending.id);
  }finally{x.close()}
});
test("observation challenges are paired, single use, bounded, and cannot bypass offline link",()=>{
  const x=fixture();try{
    x.clock(1_500_000);
    const req=x.chat.requestObservations(EXT)[0];
    assert.equal(x.chat.requestObservations(EXT).length,0,"in-flight request deduplicated");
    assert.throws(()=>x.chat.acceptObservation("other",{requestId:req.requestId,observation:x.sample()}),/INVALID/);
    assert.equal(x.chat.acceptObservation(EXT,{requestId:req.requestId,observation:x.sample()}).accepted,true);
    assert.throws(()=>x.chat.acceptObservation(EXT,{requestId:req.requestId,observation:x.sample()}),/INVALID/);
    x.offline();
    assert.equal(x.chat.requestObservations(EXT).length,0);
    assert.equal(x.chat.tick().length,0);
  }finally{x.close()}
});
test("restart does not trust pre-restart stability; fresh browser samples required",()=>{
  const x=fixture();try{
    x.clock(1_530_000);x.deliver();
    x.clock(1_600_000);x.deliver();
    assert.ok(x.chat.observationProof("pie"));
    const empty={targets:{list:()=>[]}};
    const restarted=new ChatContinuation(x.store,{
      bridge:x.bridge,watchtower:empty,github:empty,gate:{one:()=>null},now:()=>1_600_001});
    assert.equal(restarted.observationProof("pie"),null);
    assert.equal(restarted.tick().length,0);
  }finally{x.close()}
});

test("unchanged completed reply becomes eligible after two fresh post-restart observations",()=>{
  const x=fixture();try{
    x.clock(1_530_000);x.deliver();
    x.clock(1_600_000);x.deliver();
    assert.ok(x.chat.observationProof("pie"));
    const empty={targets:{list:()=>[]}};
    x.clock(1_600_001);
    const restarted=new ChatContinuation(x.store,{
      bridge:x.bridge,watchtower:empty,github:empty,gate:{one:()=>null},now:x.now});
    assert.equal(restarted.observationProof("pie"),null);
    let req=restarted.requestObservations(EXT)[0];
    assert.ok(req);
    const first=restarted.acceptObservation(EXT,{
      requestId:req.requestId,observation:x.sample()});
    assert.equal(first.stable,false);
    assert.equal(restarted.observationProof("pie"),null);
    x.clock(1_640_001);
    req=restarted.requestObservations(EXT)[0];
    assert.ok(req);
    const second=restarted.acceptObservation(EXT,{
      requestId:req.requestId,observation:x.sample()});
    assert.equal(second.stable,true);
    assert.ok(restarted.observationProof("pie"));
    assert.equal(restarted.tick().length,1);
  }finally{x.close()}
});

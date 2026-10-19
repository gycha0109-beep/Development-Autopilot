import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChromeBridge} from "../local/chrome-bridge.js";
import {ChatContinuation} from "../local/chat-continuation.js";
import {AutopilotRuntime} from "../local/autopilot-runtime.js";
import {CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";
import {observation,NOW} from "../test-support/autopilot-fixture.js";

const ext="abcdefghijklmnopabcdefghijklmnop";
function fixture(){
  const store=new WorkstreamStore();let now=NOW;
  const bridge=new ChromeBridge(store),source={targets:{list:()=>[]},current:()=>({targets:[],results:[]}),refresh:async()=>{}};
  const gate={one:()=>null,getReview:()=>null};
  const paired=bridge.beginPairing(now);bridge.pair("chrome-extension://"+ext,paired.code,now);
  const sync=()=>bridge.sync(ext,{version:1,composerBuild:CHAT_COMPOSER_BUILD,sessions:["work","other"].map(id=>({
    sessionKey:id,groupKey:"group",title:id,origin:"https://chatgpt.com",status:"connected"}))},now);
  for(const id of ["work","other"])store.create({id,name:id,projectKey:"project",repository:"owner/repo"},now);
  sync();for(const id of ["work","other"])bridge.link(id,ext,id,now);
  const makeChat=()=>new ChatContinuation(store,{bridge,watchtower:source,github:source,gate,now:()=>now});
  let chat=makeChat();
  const makeRuntime=()=>new AutopilotRuntime(store,{bridge,chat,watchtower:source,github:source,gate,now:()=>now});
  let runtime=makeRuntime();
  const sample=patch=>observation({...patch,observedAt:now});
  const preview=id=>{
    runtime.preview(id,true);const request=runtime.transport.requests(ext).find(r=>r.workstreamId===id);
    runtime.transport.accept(ext,{requestId:request.requestId,observation:sample({})});
  };
  const approve=id=>{
    chat.configure(id,{enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:3});
    runtime.configure(id,{observationPermitted:true,executionPermitted:true,remainingWork:true});
  };
  const inspect=async(patches={})=>{
    const job=runtime.coordinator.tick();
    for(let i=0;i<20&&!runtime.transport.requests(ext).length;i++)await new Promise(resolve=>setImmediate(resolve));
    const requests=runtime.transport.requests(ext);assert.ok(requests.length);
    for(const request of requests)runtime.transport.accept(ext,{requestId:request.requestId,observation:sample(patches[request.workstreamId]||{})});
    return job;
  };
  return {store,bridge,source,preview,approve,inspect,sample,sync,get runtime(){return runtime;},get chat(){return chat;},
    clock:t=>{now=t;sync();},restart:()=>{runtime.close();chat=makeChat();runtime=makeRuntime();},close:()=>{runtime.close();store.close();}};
}

test("production composition routes two live-worker samples through SQLite intent, claim proof and no replay",async()=>{
  const f=fixture();try{
    f.preview("work");f.approve("work");f.clock(NOW+60_000);
    await f.inspect();assert.equal(f.chat.commands().length,0);
    f.clock(NOW+120_000);await f.inspect();
    assert.equal(f.chat.commands().length,1);
    const command=f.chat.claim(ext,{observationProtocol:"observation-worker-1"});assert.ok(command.observationProof.verified);
    assert.equal(command.observationProof.replyFingerprint,f.sample({}).replyFingerprint);
    f.chat.acknowledge(ext,command.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    f.restart();f.clock(NOW+180_000);await f.inspect();
    assert.equal(f.chat.commands().length,1);assert.equal(f.chat.claim(ext),null);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM autopilot_response_claims").get().n,1);
  }finally{f.close();}
});

test("old workers cannot claim managed commands without live pre-send proof support",async()=>{
  const f=fixture();try{
    f.preview("work");f.approve("work");f.clock(NOW+60_000);await f.inspect();
    f.clock(NOW+120_000);await f.inspect();assert.equal(f.chat.commands().length,1);
    assert.equal(f.chat.claim(ext),null);assert.equal(f.chat.commands()[0].state,"blocked");
  }finally{f.close();}
});

test("legacy time-only schedules never queue without explicit observation and execution enrollment",()=>{
  const f=fixture();try{
    f.chat.configure("work",{enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:3});
    f.clock(NOW+60_000);assert.deepEqual(f.chat.tick(),[]);assert.equal(f.chat.claim(ext),null);
    assert.throws(()=>f.runtime.preview("other",false),/EXPLICIT_PERMISSION/);
    assert.throws(()=>f.runtime.configure("work",{executionPermitted:true}),/SCOPE_CHANGED/);
  }finally{f.close();}
});

test("browser challenge rejects wrong client and duplicate upload; private payload fields are discarded",()=>{
  const f=fixture();try{
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    const payload={requestId:request.requestId,observation:f.sample({text:"PRIVATE_BODY",url:"PRIVATE_URL",draft:"PRIVATE_DRAFT"})};
    assert.throws(()=>f.runtime.transport.accept("other-client",payload),/CHALLENGE/);
    f.runtime.transport.accept(ext,payload);
    assert.throws(()=>f.runtime.transport.accept(ext,payload),/CHALLENGE/);
    assert.doesNotMatch(JSON.stringify(f.runtime.snapshot()),/PRIVATE_/);
    assert.equal(f.runtime.transport.latest("work").observedAt,NOW);
  }finally{f.close();}
});

test("restart invalidates an in-flight observation; relink and task revision invalidate scope",()=>{
  const f=fixture();try{
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    f.restart();assert.throws(()=>f.runtime.transport.accept(ext,{requestId:request.requestId,observation:f.sample({})}),/CHALLENGE/);
    f.clock(NOW+1);f.bridge.link("work",ext,"work",NOW+1);
    assert.throws(()=>f.runtime.transport.current("work"),/SCOPE_CHANGED/);
    f.runtime.preview("work",true);f.store.db.prepare("UPDATE workstreams SET task_revision=task_revision+1 WHERE id='work'").run();
    assert.deepEqual(f.runtime.transport.requests(ext),[]);
  }finally{f.close();}
});

for(const patch of [{assistantBusy:true},{composerHasDraft:true},{verified:false},{ciWaitCue:true}])
test("runtime fails closed for "+JSON.stringify(patch),async()=>{
  const f=fixture();try{
    f.preview("work");f.approve("work");f.clock(NOW+60_000);await f.inspect({work:patch});
    f.clock(NOW+120_000);await f.inspect({work:patch});
    assert.deepEqual(f.chat.tick(),[]);assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});

test("operator cue persists local Inbox and pauses only that stream while another stream dispatches",async()=>{
  const f=fixture();try{
    for(const id of ["work","other"]){f.preview(id);f.approve(id);}
    f.clock(NOW+60_000);await f.inspect({work:{humanActionCue:true,humanActionCategory:"cost"}});
    assert.equal(f.runtime.inbox.list().length,1);assert.equal(f.store.get("work").paused,true);
    f.clock(NOW+120_000);await f.inspect();
    assert.equal(f.chat.commands().length,1);assert.equal(f.chat.commands()[0].workstreamId,"other");
  }finally{f.close();}
});

test("STOP cancels pending challenge and late uploads cannot revive it",async()=>{
  const f=fixture();try{
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    f.store.setStopped(true,NOW);assert.deepEqual(f.runtime.transport.requests(ext),[]);
    assert.throws(()=>f.runtime.transport.accept(ext,{requestId:request.requestId,observation:f.sample({})}),/CHALLENGE/);
  }finally{f.close();}
});

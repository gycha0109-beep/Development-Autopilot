import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChromeBridge} from "../local/chrome-bridge.js";
import {ChatContinuation} from "../local/chat-continuation.js";
import {AutopilotRuntime} from "../local/autopilot-runtime.js";
import {CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";
import {observation,NOW} from "../test-support/autopilot-fixture.js";
import {randomUUID} from "node:crypto";
import {RECOVERY_WORKER_BUILD} from "../extension/disconnect-page.js";
import {LOADING_WORKER_BUILD} from '../extension/loading-page.js';

const ext="abcdefghijklmnopabcdefghijklmnop";
const localCommand=(item,command)=>({...item,command,commandId:randomUUID()});
function fixture(ids=["work","other"]){
  const store=new WorkstreamStore();let now=NOW;
  const bridge=new ChromeBridge(store),source={targets:{list:()=>[]},current:()=>({targets:[],results:[]}),refresh:async()=>{}};
  const gate={one:()=>null,getReview:()=>null};
  const paired=bridge.beginPairing(now);bridge.pair("chrome-extension://"+ext,paired.code,now);
  const sync=()=>bridge.sync(ext,{version:1,composerBuild:CHAT_COMPOSER_BUILD,sessions:ids.map(id=>({
    sessionKey:id,groupKey:"group",title:id,origin:"https://chatgpt.com",status:"connected"}))},now);
  for(const id of ids)store.create({id,name:id,projectKey:"project",repository:"owner/repo"},now);
  sync();for(const id of ids)bridge.link(id,ext,id,now);
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

test('a deferred dispatch retries its own queue clock without waiting for or advancing DOM inspection',async()=>{
  const f=fixture();try{
    for(const id of ['work','other']){f.preview(id);f.approve(id);}
    f.clock(NOW+60000);await f.inspect();f.clock(NOW+120000);await f.inspect();
    assert.equal(f.chat.commands().length,1);
    const deferred=['work','other'].find(id=>!f.chat.commands().some(c=>c.workstreamId===id));
    const schedule=f.runtime.coordinator.get(deferred),sample=f.runtime.transport.latest(deferred);
    assert.equal(f.runtime.queue.task('dispatch',deferred).status,'pending');
    f.clock(NOW+121001);await f.runtime.coordinator.tick();
    assert.equal(f.chat.commands().length,2);
    assert.equal(f.runtime.coordinator.get(deferred).next_inspect_at,schedule.next_inspect_at);
    assert.deepEqual(f.runtime.transport.latest(deferred),sample);assert.deepEqual(f.runtime.transport.requests(ext),[]);
    await f.runtime.coordinator.tick();assert.equal(f.chat.commands().length,2);
  }finally{f.close();}
});

test('deferred dispatch still cancels when approval expires despite a fresh cached DOM sample',async()=>{
  const f=fixture();try{
    for(const id of ['work','other']){f.preview(id);f.approve(id);}
    f.clock(NOW+60000);await f.inspect();f.clock(NOW+3599000);await f.inspect();
    assert.equal(f.chat.commands().length,1);
    const deferred=['work','other'].find(id=>!f.chat.commands().some(c=>c.workstreamId===id));
    assert.equal(f.runtime.queue.task('dispatch',deferred).status,'pending');
    f.clock(NOW+3600001);await f.runtime.coordinator.tick();
    assert.equal(f.chat.commands().length,1);assert.equal(f.runtime.queue.task('dispatch',deferred).status,'completed');
  }finally{f.close();}
});

test("an obsolete collector cannot supply a fresh preview or keep an existing observation scope",()=>{
  const f=fixture();try{
    f.preview("work");
    f.bridge.sync(ext,{version:1,composerBuild:"composer-2026-10-15-r16",sessions:["work","other"].map(id=>({
      sessionKey:id,groupKey:"group",title:id,origin:"https://chatgpt.com",status:"connected"}))},NOW);
    assert.throws(()=>f.runtime.transport.current("work"),/OBSERVATION_WORKER_UPGRADE_REQUIRED/);
    assert.throws(()=>f.runtime.preview("other",true),/OBSERVATION_WORKER_UPGRADE_REQUIRED/);
    assert.equal(f.chat.commands().length,0);
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

async function pausedFixture(){
  const f=fixture();f.preview("work");f.approve("work");f.clock(NOW+60_000);
  await f.inspect({work:{humanActionCue:true,humanActionCategory:"local_test"}});return f;
}
function review(f,patch={}){
  const item=f.runtime.inbox.list()[0];
  f.runtime.operatorCommand(localCommand(item,"reinspect"));
  const challenge=f.runtime.transport.requests(ext)[0];assert.ok(challenge);
  f.runtime.transport.accept(ext,{requestId:challenge.requestId,observation:f.sample(patch)});
  return item;
}
test("local Inbox decisions use revision CAS and never grant spend, dispatch or resume",async()=>{
  const f=await pausedFixture();try{
    const old=f.runtime.inbox.list()[0],body=localCommand(old,"approve"),before=f.chat.config("work");
    assert.equal(f.runtime.operatorCommand(body).request.state,"approved");
    assert.throws(()=>f.runtime.operatorCommand(body),/COMMAND_ALREADY_USED/);
    assert.throws(()=>f.runtime.operatorCommand(localCommand(old,"reject")),/REVIEW_CHANGED/);
    assert.equal(f.store.get("work").paused,true);assert.deepEqual(f.chat.config("work"),before);
    assert.throws(()=>f.runtime.operatorCommand(localCommand(f.runtime.inbox.list()[0],"resume")),/FRESH_OPERATOR_REVIEW/);
    assert.equal(f.runtime.inbox.list()[0].state,"approved");assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
for(const patch of [{humanActionCue:true},{verified:false},{assistantBusy:true},{composerHasDraft:true},
  {connectionWarning:true},{lengthWarning:true},{ciWaitCue:true},{uiAmbiguous:true},{providerRestriction:true}])
test("paused reinspection stays read-only and blocks unsafe resume: "+JSON.stringify(patch),async()=>{
  const f=await pausedFixture();try{
    const item=review(f,patch);
    assert.throws(()=>f.runtime.operatorCommand(localCommand(item,"resume")),/ACTION_STILL_REQUIRED/);
    assert.equal(f.store.get("work").paused,true);assert.equal(f.runtime.inbox.list()[0].state,"pending");
    assert.equal(f.chat.claim(ext,{observationProtocol:"observation-worker-1"}),null);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
test("fresh same-tab review closes only the request and resumes inspection without replenishing approval",async()=>{
  const f=await pausedFixture();try{
    const before=f.chat.config("work"),item=review(f),body=localCommand(item,"resume");
    assert.equal(f.runtime.snapshot().inbox[0].reviewReason,null);
    assert.equal(f.runtime.operatorCommand(body).resumed,true);
    assert.equal(f.runtime.inbox.list()[0].state,"closed");assert.equal(f.store.get("work").paused,false);
    assert.equal(f.runtime.coordinator.get("work").next_inspect_at,0);
    assert.deepEqual(f.chat.config("work"),before);assert.equal(f.chat.commands().length,0);
    assert.throws(()=>f.runtime.operatorCommand(body),/COMMAND_ALREADY_USED/);
    f.clock(NOW+120_000);await f.inspect();assert.equal(f.chat.commands().length,0);
    // Same warning after resolution is a new occurrence, not an already closed request.
    f.clock(NOW+180_000);await f.inspect({work:{humanActionCue:true,humanActionCategory:"local_test"}});
    assert.equal(f.store.get("work").paused,true);assert.equal(f.runtime.inbox.list()[0].state,"pending");
    assert.ok(f.runtime.inbox.list()[0].revision>item.revision);
  }finally{f.close();}
});
for(const drift of ["restart","expired-proof","stop","relink","revision","target","hold"])
test("review proof is invalid after "+drift,async()=>{
  const f=await pausedFixture();try{
    let item=review(f);
    if(drift==="restart")f.restart();
    if(drift==="expired-proof")f.clock(NOW+241_000);
    if(drift==="stop")f.store.setStopped(true,NOW+60_000);
    if(drift==="relink"){f.clock(NOW+60_001);f.bridge.link("work",ext,"work",NOW+60_001);}
    if(drift==="revision")f.store.db.prepare("UPDATE workstreams SET task_revision=2 WHERE id='work'").run();
    if(drift==="target")f.source.targets.list=()=>[{workstreamId:"work",headSha:"e".repeat(40)}];
    if(drift==="hold"){f.runtime.operatorCommand(localCommand(item,"hold"));item=f.runtime.inbox.list()[0];}
    assert.throws(()=>f.runtime.operatorCommand(localCommand(item,"resume")));
    assert.equal(f.store.get("work").paused,true);assert.notEqual(f.runtime.inbox.list()[0].state,"closed");
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
test("changing review while a paused read is in flight cancels its challenge",async()=>{
  const f=await pausedFixture();try{
    const item=f.runtime.inbox.list()[0];f.runtime.operatorCommand(localCommand(item,"reinspect"));
    const challenge=f.runtime.transport.requests(ext)[0];
    f.runtime.operatorCommand(localCommand(item,"reject"));assert.deepEqual(f.runtime.transport.requests(ext),[]);
    assert.throws(()=>f.runtime.transport.accept(ext,{requestId:challenge.requestId,observation:f.sample({})}),/CHALLENGE/);
    assert.equal(f.store.get("work").paused,true);
  }finally{f.close();}
});
test("reviewed resume preserves an exhausted campaign and all sibling pauses",async()=>{
  const f=await pausedFixture();try{
    f.store.db.prepare("UPDATE chat_continuation_settings SET sent_count=max_messages,enabled=0 WHERE workstream_id='work'").run();
    f.store.db.prepare("UPDATE workstreams SET paused=1 WHERE id='other'").run();
    const before=f.chat.config("work"),item=review(f);
    assert.equal(f.runtime.operatorCommand(localCommand(item,"resume")).resumed,true);
    assert.deepEqual(f.chat.config("work"),before);assert.equal(f.store.get("other").paused,true);
    f.clock(NOW+120_000);await f.inspect();f.clock(NOW+180_000);await f.inspect();
    assert.equal(f.chat.commands().length,0);
    assert.equal(f.runtime.coordinator.state.latest("work").decision.reasonCode,"APPROVED_MESSAGE_LIMIT_REACHED");
  }finally{f.close();}
});
test("resolving one Inbox request cannot unpause another unresolved request",async()=>{
  const f=await pausedFixture();try{
    f.runtime.inbox.open("work",{reasonCategory:"approval",reasonCode:"OTHER_REVIEW",actionFingerprint:"d".repeat(64),
      evidenceTimestamp:NOW+60_000,expiresAt:NOW+600_000});
    const item=review(f),result=f.runtime.operatorCommand(localCommand(item,"resume"));
    assert.equal(result.resumed,false);assert.equal(result.reasonCode,"OTHER_OPERATOR_REQUEST_PENDING");
    assert.equal(f.store.get("work").paused,true);assert.equal(f.runtime.inbox.row(item.requestId).state,"closed");
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
test("fresh review never resolves a pending uncertain response claim",async()=>{
  const f=await pausedFixture();try{
    const item=review(f);
    f.store.db.prepare(`INSERT INTO autopilot_response_claims VALUES('uncertain','work',1,?,?,?,'unknown',NULL,?,?)`)
      .run("b".repeat(64),"d".repeat(64),"e".repeat(64),NOW,NOW);
    assert.throws(()=>f.runtime.operatorCommand(localCommand(item,"resume")),/OPERATION_PENDING/);
    assert.equal(f.store.get("work").paused,true);assert.equal(f.runtime.inbox.row(item.requestId).state,"pending");
  }finally{f.close();}
});

const disconnected={connectionWarning:true,assistantBusy:true,stopControlVerified:true};
const loadingProof=(failed=true,user='e')=>({safe:true,failed,bindingFingerprint:'b'.repeat(64),userFingerprint:user.repeat(64)});
const loadingError={verified:false,reasonCode:'ASSISTANT_RESPONSE_UNAVAILABLE',loadingSafety:loadingProof()};
const loadingNormal={loadingSafety:loadingProof(false)};
const loadingClock=(f,at)=>{f.clock(at);f.runtime.loading.heartbeat(ext,LOADING_WORKER_BUILD);};
async function loadingFixture(both=false){
  const f=fixture();
  for(const id of both?['work','other']:['work']){f.preview(id);f.approve(id);f.runtime.loading.heartbeat(ext,LOADING_WORKER_BUILD);f.runtime.loading.configure(id,true);}
  loadingClock(f,NOW+60_000);await f.inspect(both?{work:loadingError,other:loadingError}:{work:loadingError});
  return f;
}
async function loadingRead(f,at,patches={work:loadingError}){
  loadingClock(f,at);f.runtime.loading.tick();
  for(let i=0;i<30&&!f.runtime.transport.requests(ext).length;i++)await new Promise(r=>setImmediate(r));
  const requests=f.runtime.transport.requests(ext);assert.ok(requests.length);
  for(const r of requests)f.runtime.transport.accept(ext,{requestId:r.requestId,observation:f.sample(patches[r.workstreamId]||loadingNormal)});
  await Promise.all([...f.runtime.loading.jobs.values()]);
}
test('loading recovery reobserves without navigation, reloads once, verifies two fresh normal samples and re-enters normal guards',async()=>{
  const f=await loadingFixture();try{
    const campaign=f.chat.config('work');assert.equal(f.runtime.loading.get('work').stage,'REOBSERVE');
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);assert.equal(f.chat.commands().length,0);
    await loadingRead(f,NOW+90_000);assert.equal(f.runtime.loading.get('work').stage,'QUEUED');
    const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);assert.ok(c);assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
    assert.equal(f.runtime.loading.authorize(ext,c.operationId,f.sample(loadingError)).authorized,true);
    assert.equal(f.runtime.loading.ack(ext,{operationId:c.operationId,outcome:'started'}).accepted,true);
    assert.equal(f.runtime.loading.get('work').stage,'POST_RELOAD');assert.equal(f.chat.commands().length,0);
    await loadingRead(f,NOW+120_000,{work:loadingNormal});assert.equal(f.runtime.loading.get('work').stage,'VERIFYING');
    await loadingRead(f,NOW+150_000,{work:loadingNormal});assert.equal(f.runtime.loading.get('work').stage,'DONE');
    assert.deepEqual(f.chat.config('work'),campaign);assert.equal(f.chat.commands().length,0);
    loadingClock(f,NOW+180_000);await f.inspect();assert.equal(f.chat.commands().length,0);
    loadingClock(f,NOW+240_000);await f.inspect();assert.equal(f.chat.commands().length,1);
    const normal=f.chat.claim(ext,{observationProtocol:'observation-worker-1'});f.chat.acknowledge(ext,normal.id,'sent','SEND_BUTTON_CLICKED_UNVERIFIED');
    loadingClock(f,NOW+300_000);await f.inspect();assert.equal(f.chat.commands().length,1);
  }finally{f.close();}
});
test('a transient read error recovers without any reload or approval replenishment',async()=>{
  const f=await loadingFixture();try{
    const c=f.chat.config('work');await loadingRead(f,NOW+90_000,{work:loadingNormal});
    await loadingRead(f,NOW+120_000,{work:loadingNormal});
    assert.equal(f.runtime.loading.get('work').stage,'DONE');assert.equal(f.runtime.loading.get('work').attempted_at,null);
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);assert.deepEqual(f.chat.config('work'),c);
  }finally{f.close();}
});
test('failed reload reports only its axis, imposes global backoff, and never reclaims',async()=>{
  const f=await loadingFixture();try{
    f.preview('other');f.approve('other');await loadingRead(f,NOW+90_000);
    const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);f.runtime.loading.authorize(ext,c.operationId,f.sample(loadingError));
    f.runtime.loading.ack(ext,{operationId:c.operationId,outcome:'started'});
    await loadingRead(f,NOW+120_000);assert.equal(f.runtime.loading.get('work').stage,'FAILED');
    assert.equal(f.store.get('work').paused,true);assert.equal(f.store.get('other').paused,false);
    assert.equal(f.runtime.inbox.list()[0].reasonCode,'LOADING_RELOAD_DID_NOT_RECOVER');
    assert.ok(f.store.db.prepare('SELECT next_at FROM loading_reload_budget').get().next_at>NOW+120_000);
    loadingClock(f,NOW+180_000);await f.inspect();loadingClock(f,NOW+240_000);await f.inspect();
    assert.equal(f.chat.commands().filter(c=>c.workstreamId==='other').length,1);
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
  }finally{f.close();}
});
test('multiple loading errors serialize reload and verification while preserving sibling reads',async()=>{
  const f=await loadingFixture(true);try{
    await loadingRead(f,NOW+90_000,{work:loadingError,other:loadingError});
    const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);assert.ok(c);assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
    const other=c.workstreamId==='work'?'other':'work';
    assert.equal(f.runtime.loading.get(other).stage,'WAIT_SLOT');
    f.runtime.loading.authorize(ext,c.operationId,f.sample(loadingError));f.runtime.loading.ack(ext,{operationId:c.operationId,outcome:'started'});
    await loadingRead(f,NOW+120_000,{[c.workstreamId]:loadingNormal,[other]:loadingError});
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
    await loadingRead(f,NOW+150_000,{[c.workstreamId]:loadingNormal,[other]:loadingError});
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD).workstreamId,other);
  }finally{f.close();}
});

for(const count of [3,5])test(`${count} concurrent loading errors survive FIFO waiting while a healthy axis dispatches independently`,async()=>{
  const ids=Array.from({length:count},(_,i)=>'recover-'+i),f=fixture([...ids,'healthy']);
  try{
    for(const id of [...ids,'healthy']){f.preview(id);f.approve(id);}
    f.runtime.loading.heartbeat(ext,LOADING_WORKER_BUILD);
    for(const id of ids)f.runtime.loading.configure(id,true);
    const campaigns=ids.map(id=>f.chat.config(id));
    loadingClock(f,NOW+60_000);await f.inspect(Object.fromEntries(ids.map(id=>[id,loadingError])));
    loadingClock(f,NOW+120_000);await f.inspect();
    assert.deepEqual(f.chat.commands().map(c=>c.workstreamId),['healthy']);
    const healthy=f.chat.claim(ext,{observationProtocol:'observation-worker-1'});assert.equal(healthy.workstreamId,'healthy');
    f.chat.acknowledge(ext,healthy.id,'sent','SEND_BUTTON_CLICKED_UNVERIFIED');
    const remaining=new Set(ids),starts=[];
    for(let n=0;n<count;n++){
      const at=NOW+150_000+n*150_000;
      if([...remaining].some(id=>['REOBSERVE','WAIT_SLOT'].includes(f.runtime.loading.get(id).stage)))
        await loadingRead(f,at,Object.fromEntries([...remaining].map(id=>[id,loadingError])));
      else loadingClock(f,at);
      const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);assert.ok(c);assert.ok(remaining.has(c.workstreamId));
      assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
      assert.equal(f.runtime.loading.authorize(ext,c.operationId,f.sample(loadingError)).authorized,true);
      assert.equal(f.runtime.loading.ack(ext,{operationId:c.operationId,outcome:'started'}).accepted,true);
      starts.push(at);const patches=Object.fromEntries([...remaining].map(id=>[id,id===c.workstreamId?loadingNormal:loadingError]));
      await loadingRead(f,at+60_000,patches);
      assert.equal(f.runtime.loading.get(c.workstreamId).stage,'VERIFYING');
      assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
      await loadingRead(f,at+120_000,patches);
      assert.equal(f.runtime.loading.get(c.workstreamId).stage,'DONE');remaining.delete(c.workstreamId);
      for(const id of remaining){const row=f.runtime.loading.get(id);assert.ok(!['FAILED','UNKNOWN'].includes(row.stage));
        if(row.stage==='WAIT_SLOT')assert.equal(row.deadline_at,row.created_at+1_800_000);}
    }
    assert.ok(starts.every((at,i)=>i===0||at-starts[i-1]>=60_000));
    assert.deepEqual(ids.map(id=>f.chat.config(id)),campaigns);
    assert.equal(f.chat.commands().length,1);assert.equal(f.runtime.inbox.list().length,0);
    assert.equal(f.store.db.prepare('SELECT count(*) n FROM loading_recoveries WHERE attempted_at IS NOT NULL').get().n,count);
  }finally{f.close();}
});

for(const [name,patch] of Object.entries({ci:{ciWaitCue:true},cost:{humanActionCue:true,humanActionCategory:'cost'},
  localTest:{humanActionCue:true,humanActionCategory:'local_test'},disconnect:{connectionWarning:true,stopControlVerified:true},
  length:{lengthWarning:true},restriction:{providerRestriction:true}}))
test('recovered '+name+' response re-enters its exception branch without continuing or replenishing approval',async()=>{
  const f=await loadingFixture();try{
    const campaign=f.chat.config('work');await loadingRead(f,NOW+90_000);
    const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);
    f.runtime.loading.authorize(ext,c.operationId,f.sample(loadingError));f.runtime.loading.ack(ext,{operationId:c.operationId,outcome:'started'});
    const response={...loadingNormal,...patch};
    await loadingRead(f,NOW+120_000,{work:response});await loadingRead(f,NOW+150_000,{work:response});
    assert.equal(f.runtime.loading.get('work').stage,'DONE');
    loadingClock(f,NOW+180_000);await f.inspect({work:response});
    assert.notEqual(f.runtime.coordinator.state.latest('work').decision.nextAction,'CONTINUE');
    assert.equal(f.chat.commands().length,0);assert.deepEqual(f.chat.config('work'),campaign);
  }finally{f.close();}
});
for(const drift of ['missing-proof','new-user','wrong-binding','restart','relink','expired','pending-send','global-stop','running'])
test('loading reload refuses '+drift+' and cannot replay',async()=>{
  const f=await loadingFixture();try{
    await loadingRead(f,NOW+90_000);const c=f.runtime.loading.claim(ext,LOADING_WORKER_BUILD);assert.ok(c);
    let page=f.sample(loadingError);
    if(drift==='missing-proof')delete page.loadingSafety;
    if(drift==='new-user')page.loadingSafety=loadingProof(true,'f');
    if(drift==='wrong-binding')page.loadingSafety={...loadingProof(),bindingFingerprint:'f'.repeat(64)};
    if(drift==='restart')f.restart();
    if(drift==='relink')f.bridge.link('work',ext,'work',NOW+90_001);
    if(drift==='expired')loadingClock(f,NOW+3_700_000);
    if(drift==='pending-send')f.store.db.prepare(`INSERT INTO autopilot_response_claims VALUES('uncertain','work',1,?,?,?,'unknown',NULL,?,?)`)
      .run('b'.repeat(64),'c'.repeat(64),'d'.repeat(64),NOW,NOW);
    if(drift==='global-stop')f.store.setStopped(true,NOW+90_000);
    if(drift==='running')f.store.db.prepare("UPDATE workstreams SET state='RUNNING' WHERE id='work'").run();
    assert.equal(f.runtime.loading.authorize(ext,c.operationId,page).authorized,false);
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
test('the same failed request never earns a second reload after successful recovery',async()=>{
  const f=await loadingFixture();try{
    await loadingRead(f,NOW+90_000,{work:loadingNormal});await loadingRead(f,NOW+120_000,{work:loadingNormal});
    loadingClock(f,NOW+180_000);await f.inspect({work:loadingError});
    assert.equal(f.runtime.loading.get('work').stage,'FAILED');assert.equal(f.store.get('work').paused,true);
    assert.equal(f.runtime.loading.claim(ext,LOADING_WORKER_BUILD),null);
  }finally{f.close();}
});
test("upgrading the exact old recovery lease preserves campaigns, observations and sibling policies",()=>{
  const f=fixture();try{
    f.preview("work");f.approve("work");
    const before={campaign:f.chat.config("work"),sample:f.runtime.transport.latest("work"),
      links:f.bridge.getSnapshot(NOW).links,inspect:f.runtime.queue.policy("inspect")};
    const policy={...f.runtime.queue.policy("recovery")};delete policy.nextStartAt;policy.leaseMs=90_000;
    f.store.db.prepare("UPDATE autopilot_queue_policies SET policy=?,next_start_at=? WHERE kind='recovery'")
      .run(JSON.stringify(policy),NOW+1000);
    f.restart();
    assert.equal(f.runtime.queue.policy("recovery").leaseMs,330_000);
    assert.equal(f.runtime.queue.policy("recovery").nextStartAt,NOW+1000);
    assert.deepEqual({campaign:f.chat.config("work"),sample:f.runtime.transport.latest("work"),
      links:f.bridge.getSnapshot(NOW).links,inspect:f.runtime.queue.policy("inspect")},before);
    assert.equal(f.runtime.recoveryCapability("work").scope.recoveryPermitted,false);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
for(const change of ["custom-policy","active-task"])
test("recovery policy upgrade refuses "+change+" without rewriting history",()=>{
  const f=fixture();try{
    const policy={...f.runtime.queue.policy("recovery")};delete policy.nextStartAt;policy.leaseMs=90_000;
    if(change==="custom-policy")policy.maxConcurrent=2;
    f.store.db.prepare("UPDATE autopilot_queue_policies SET policy=? WHERE kind='recovery'").run(JSON.stringify(policy));
    if(change==="active-task")f.store.db.prepare(`INSERT INTO autopilot_queue_tasks
      (id,workstream_id,kind,resource_key,status,requested_at,next_eligible_at,reason)
      VALUES('old','work','recovery','old','pending',?,?,'REQUESTED')`).run(NOW,NOW);
    assert.throws(()=>f.restart(),change==="custom-policy"?/QUEUE_POLICY_CHANGE_REQUIRES_REVIEW/:/RECOVERY_POLICY_MIGRATION_HAS_ACTIVE_TASKS/);
    assert.equal(f.store.db.prepare("SELECT policy FROM autopilot_queue_policies WHERE kind='recovery'").get().policy,JSON.stringify(policy));
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
const recoveryClock=(f,at)=>{f.clock(at);f.runtime.recoveryTransport.heartbeat(ext,RECOVERY_WORKER_BUILD);};
async function recoveryFixture(){
  const f=fixture();f.preview("work");f.approve("work");
  assert.throws(()=>f.runtime.configureRecovery("work",true),/WORKER_UPGRADE/);
  f.runtime.recoveryTransport.heartbeat(ext,RECOVERY_WORKER_BUILD);
  f.runtime.configureRecovery("work",true);
  recoveryClock(f,NOW+60_000);await f.inspect({work:disconnected});return f;
}
async function recoveryEffect(f,at,patch){
  recoveryClock(f,at);const job=f.runtime.coordinator.tick();
  for(let i=0;i<50&&!f.runtime.transport.requests(ext).length;i++)await new Promise(resolve=>setImmediate(resolve));
  for(const request of f.runtime.transport.requests(ext))f.runtime.transport.accept(ext,{requestId:request.requestId,
    observation:f.sample(request.workstreamId==="work"?patch:{})});
  for(let i=0;i<50&&!f.store.db.prepare("SELECT 1 FROM chrome_recovery_commands WHERE state='queued'").get();i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.runtime.recoveryTransport.claim(ext,"old-worker"),null);
  const command=f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD);assert.ok(command);
  assert.equal(f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD),null);
  return {command,job};
}
async function stoppedRecovery(){
  const f=await recoveryFixture(),effect=await recoveryEffect(f,NOW+120_000,disconnected);
  assert.equal(f.runtime.recoveryTransport.authorize(ext,effect.command.operationId,f.sample(disconnected)).authorized,true);
  f.runtime.recoveryTransport.acknowledge(ext,{...effect.command,outcome:"clicked"});await effect.job;
  assert.equal(f.runtime.recovery.get("work").stage,"STOP_RESULT_PENDING");
  recoveryClock(f,NOW+180_000);await f.inspect();assert.equal(f.runtime.recovery.get("work").stage,"STOP_RESULT_VERIFIED");
  return f;
}

test("a pending Stop receipt cannot block another axis's next inspection and dispatch",async()=>{
  const f=await recoveryFixture();try{
    f.preview("other");f.approve("other");
    const {command,job}=await recoveryEffect(f,NOW+120_000,disconnected);
    assert.equal(f.runtime.recovery.get("work").stage,"STOP_INTENT_RECORDED");
    recoveryClock(f,NOW+180_000);await f.inspect();
    assert.equal(f.chat.commands().filter(c=>c.workstreamId==="other").length,1);
    assert.equal(f.chat.commands().filter(c=>c.workstreamId==="work").length,0);
    assert.equal(f.runtime.recoveryTransport.row(command.operationId).state,"claimed");
    // A late Stop is not replayed; its original preflight remains mandatory.
    assert.equal(f.runtime.recoveryTransport.authorize(ext,command.operationId,f.sample(disconnected)).authorized,true);
    f.runtime.recoveryTransport.acknowledge(ext,{...command,outcome:"clicked"});await job;
  }finally{f.close();}
});
test("production recovery routes debounced Stop, independent stop proof, one report, proven reply and normal bounded continuation",async()=>{
  const f=await stoppedRecovery();try{
    const {command,job}=await recoveryEffect(f,NOW+240_000,{});assert.equal(command.kind,"report");
    assert.equal(f.runtime.recoveryTransport.authorize(ext,command.operationId,f.sample({})).authorized,true);
    const userFingerprint="e".repeat(64);
    f.runtime.recoveryTransport.acknowledge(ext,{...command,outcome:"submitted",userFingerprint});await job;
    assert.equal(f.runtime.recovery.get("work").stage,"REPORT_RESULT_PENDING");
    const report={replyFingerprint:"d".repeat(64),recoveryReportProof:{operationId:command.operationId,userFingerprint}};
    recoveryClock(f,NOW+300_000);await f.inspect({work:report});
    recoveryClock(f,NOW+360_000);await f.inspect({work:report});
    assert.equal(f.runtime.recovery.get("work").stage,"REPORT_RESPONSE_VERIFIED");
    recoveryClock(f,NOW+420_000);await f.inspect({work:report});assert.equal(f.runtime.recovery.get("work").stage,"DONE");
    assert.equal(f.chat.commands().length,1);assert.equal(f.chat.config("work").maxMessages,3);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM chrome_recovery_commands").get().n,2);
    const normal=f.chat.claim(ext,{observationProtocol:"observation-worker-1"});assert.ok(normal);
    f.chat.acknowledge(ext,normal.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    recoveryClock(f,NOW+480_000);await f.inspect({work:disconnected});
    recoveryClock(f,NOW+540_000);await f.inspect({work:disconnected});
    assert.equal(f.runtime.inbox.list()[0].reasonCode,"RECOVERY_LIMIT_REACHED");assert.equal(f.store.get("work").paused,true);
    assert.equal(f.store.get("other").paused,false);assert.equal(f.chat.commands().length,1);
    assert.equal(f.store.deleteWorkstream("work","work").deleted,true);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM chrome_recovery_commands").get().n,0);
  }finally{f.close();}
});
test("a new normal reply without exact submitted-report provenance cannot complete recovery or continue",async()=>{
  const f=await stoppedRecovery();try{
    const {command,job}=await recoveryEffect(f,NOW+240_000,{});
    f.runtime.recoveryTransport.authorize(ext,command.operationId,f.sample({}));
    f.runtime.recoveryTransport.acknowledge(ext,{...command,outcome:"submitted",userFingerprint:"e".repeat(64)});await job;
    for(const at of [300_000,360_000]){recoveryClock(f,NOW+at);await f.inspect({work:{replyFingerprint:"d".repeat(64)}});}
    assert.equal(f.runtime.recovery.get("work").stage,"REPORT_RESULT_PENDING");assert.equal(f.chat.commands().length,0);
    recoveryClock(f,NOW+600_000);await f.inspect({work:{replyFingerprint:"d".repeat(64)}});
    assert.equal(f.runtime.recovery.get("work").stage,"UNKNOWN");assert.equal(f.store.get("work").paused,true);
    assert.equal(f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD),null);
  }finally{f.close();}
});
test("a changed pre-effect draft refuses Stop and never reclaims or retries its operation",async()=>{
  const f=await recoveryFixture();try{
    const {command,job}=await recoveryEffect(f,NOW+120_000,disconnected);
    assert.equal(f.runtime.recoveryTransport.authorize(ext,command.operationId,f.sample({...disconnected,composerHasDraft:true})).authorized,false);
    await job;assert.equal(f.runtime.recovery.get("work").stage,"UNKNOWN");
    assert.equal(f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD),null);
    assert.throws(()=>f.runtime.recoveryTransport.acknowledge(ext,{...command,outcome:"clicked"}),/NOT_CURRENT/);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
test("restart with an outstanding recovery claim marks unknown and preserves a no-replay Inbox",async()=>{
  const f=await recoveryFixture();try{
    const {command,job}=await recoveryEffect(f,NOW+120_000,disconnected);
    f.restart();await job;
    assert.equal(f.runtime.recoveryTransport.row(command.operationId).state,"unknown");
    assert.equal(f.runtime.recovery.get("work").stage,"UNKNOWN");
    f.runtime.recoveryTransport.heartbeat(ext,RECOVERY_WORKER_BUILD);
    assert.equal(f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD),null);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});
for(const kind of ["missing-authorization","expired-authorization","global-stop","revoked-permission"])
test("recovery ACK cannot bypass "+kind,async()=>{
  const f=await recoveryFixture();try{
    const {command,job}=await recoveryEffect(f,NOW+120_000,disconnected);
    if(kind!=="missing-authorization")f.runtime.recoveryTransport.authorize(ext,command.operationId,f.sample(disconnected));
    if(kind==="expired-authorization")recoveryClock(f,NOW+151_000);
    if(kind==="global-stop")f.store.setStopped(true,NOW+120_000);
    if(kind==="revoked-permission")f.store.db.prepare("UPDATE chrome_recovery_scopes SET enabled=0 WHERE workstream_id='work'").run();
    assert.equal(f.runtime.recoveryTransport.acknowledge(ext,{...command,outcome:"clicked"}).accepted,false);await job;
    assert.equal(f.runtime.recovery.get("work").stage,"UNKNOWN");
    assert.equal(f.chat.commands().length,0);assert.equal(f.runtime.recoveryTransport.claim(ext,RECOVERY_WORKER_BUILD),null);
  }finally{f.close();}
});

test("STOP cancels pending challenge and late uploads cannot revive it",async()=>{
  const f=fixture();try{
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    f.store.setStopped(true,NOW);assert.deepEqual(f.runtime.transport.requests(ext),[]);
    assert.throws(()=>f.runtime.transport.accept(ext,{requestId:request.requestId,observation:f.sample({})}),/CHALLENGE/);
  }finally{f.close();}
});

for(const reasonCode of ["ASSISTANT_RESPONSE_UNAVAILABLE","CONVERSATION_UNAVAILABLE"])
test(reasonCode+" records successful delivery separately from observation trust",()=>{
  const f=fixture();try{
    f.runtime.preview("work",true);
    const pending=f.runtime.snapshot().scopes.find(s=>s.workstreamId==="work").observationDelivery.pending;
    assert.equal(pending.requestedAt,NOW);assert.equal(pending.deadlineAt,NOW+80_000);
    f.clock(NOW+41_000);
    const payload={requestId:pending.requestId,observation:{schemaVersion:1,sourceVersion:"chat-observer-1",
      source:"chatgpt-dom",verified:false,reasonCode,
      text:"PRIVATE_BODY",url:"PRIVATE_URL",token:"PRIVATE_TOKEN",draft:"PRIVATE_DRAFT"}};
    f.runtime.transport.accept(ext,payload);
    const state=f.runtime.snapshot().scopes.find(s=>s.workstreamId==="work");
    assert.equal(state.observation.verified,false);assert.equal(state.observation.observedAt,NOW);
    assert.equal(state.observationDelivery.pending,null);
    const receipt=state.observationDelivery.lastReceipt;
    assert.equal(receipt.requestId,pending.requestId);assert.equal(receipt.outcome,"RECEIVED");
    assert.equal(receipt.reasonCode,reasonCode);assert.equal(receipt.roundTripMs,41_000);
    assert.equal(receipt.finishedAt,NOW+41_000);assert.equal(receipt.currentBinding,true);
    assert.throws(()=>f.runtime.configure("work",{executionPermitted:true}),/FRESH_PREVIEW/);
    assert.throws(()=>f.runtime.transport.accept(ext,payload),/CHALLENGE/);
    assert.equal(f.store.events().filter(e=>e.kind==="chrome_observation_received").length,1);
    assert.doesNotMatch(JSON.stringify([state,f.store.events()]),/PRIVATE_/);
    f.restart();assert.deepEqual(f.runtime.transport.diagnostics("work").lastReceipt,receipt);
    assert.equal(f.chat.commands().length,0);assert.equal(f.runtime.coordinator.get("work"),null);
  }finally{f.close();}
});

test("delivery timeout cannot masquerade as a page error or retain trusted stale preview, and siblings continue",async()=>{
  const f=fixture();try{
    f.preview("work");
    const reading=f.runtime.transport.read("work",{timeoutMs:10});
    const request=f.runtime.transport.requests(ext)[0];
    f.clock(NOW+25);
    await Promise.all([reading,new Promise(resolve=>setTimeout(resolve,25))]);
    const diagnostic=f.runtime.transport.diagnostics("work");
    assert.equal(diagnostic.pending,null);assert.equal(diagnostic.lastReceipt.outcome,"TIMEOUT");
    assert.equal(diagnostic.lastReceipt.reasonCode,"OBSERVATION_DELIVERY_TIMEOUT");
    assert.equal(f.runtime.transport.latest("work"),null);
    assert.throws(()=>f.runtime.transport.accept(ext,{requestId:request.requestId,observation:f.sample({})}),/CHALLENGE/);
    assert.throws(()=>f.runtime.configure("work",{executionPermitted:true}),/FRESH_PREVIEW/);
    f.preview("other");assert.equal(f.runtime.transport.latest("other").verified,true);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});

test("relink and revision changes label receipts historical; cancelled requests survive restart only as diagnostics",()=>{
  const f=fixture();try{
    f.preview("work");f.clock(NOW+1);f.bridge.link("work",ext,"work",NOW+1);
    assert.equal(f.runtime.transport.diagnostics("work").lastReceipt.currentBinding,false);
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    f.restart();
    let receipt=f.runtime.transport.diagnostics("work").lastReceipt;
    assert.equal(receipt.requestId,request.requestId);assert.equal(receipt.outcome,"CANCELLED");
    assert.equal(f.runtime.transport.diagnostics("work").pending,null);
    assert.equal(f.runtime.transport.latest("work"),null);
    assert.throws(()=>f.runtime.configure("work",{executionPermitted:true}),/FRESH_PREVIEW/);
    f.store.db.prepare("UPDATE workstreams SET task_revision=task_revision+1 WHERE id='work'").run();
    receipt=f.runtime.transport.diagnostics("work").lastReceipt;assert.equal(receipt.currentBinding,false);
    assert.equal(f.chat.commands().length,0);
  }finally{f.close();}
});

test("additive receipt migration preserves existing scopes, observations and Chrome links",()=>{
  const f=fixture();try{
    f.preview("work");const sample=f.runtime.transport.latest("work");
    const links=f.bridge.getSnapshot(NOW).links;
    f.store.db.exec("ALTER TABLE chrome_observation_scopes DROP COLUMN receipt");
    f.restart();
    assert.deepEqual(f.runtime.transport.latest("work"),sample);
    assert.deepEqual(f.bridge.getSnapshot(NOW).links,links);
    assert.equal(f.runtime.transport.diagnostics("work").lastReceipt,null);
    f.runtime.preview("work",true);const request=f.runtime.transport.requests(ext)[0];
    f.runtime.transport.accept(ext,{requestId:request.requestId,observation:f.sample({})});
    assert.equal(f.runtime.transport.diagnostics("work").lastReceipt.outcome,"RECEIVED");
  }finally{f.close();}
});

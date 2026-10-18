import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatContinuation} from "../local/chat-continuation.js";
import {DecisionGate} from "../local/decision-gate.js";
import {AutopilotCoordinator} from "../local/autopilot-coordinator.js";
import {CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";
import {NOW,BINDING,observation,policy,ciEvidence} from "../test-support/autopilot-fixture.js";

const ext="abcdefghijklmnopabcdefghijklmnop";
function fixture({watched=false,read=null,policyPatch={}}={}){
  const store=new WorkstreamStore();let now=NOW,reads=0,refreshes=0;
  const values=new Map(),bindings=new Map();
  const evidence=watched?ciEvidence():{watchtower:{targets:[],results:[]},github:{targets:[],results:[]}};
  const watchtower={targets:{list:()=>evidence.watchtower.targets},current:()=>evidence.watchtower,
    refresh:async()=>{refreshes++;evidence.watchtower.checkedAt=now;return evidence.watchtower;}};
  const github={targets:{list:()=>evidence.github.targets},current:()=>evidence.github,
    refresh:async()=>{refreshes++;evidence.github.checkedAt=now;return evidence.github;}};
  const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",composerBuild:CHAT_COMPOSER_BUILD}],
    links:[...bindings.keys()].map(id=>({workstreamId:id,extensionId:ext,sessionKey:id,status:"connected"})),
    sessions:[...bindings.keys()].map(id=>({extensionId:ext,sessionKey:id,origin:"https://chatgpt.com",status:"connected"}))})};
  const gate=new DecisionGate(store,{watchtower,github,now:()=>now});
  const makeChat=()=>new ChatContinuation(store,{bridge,watchtower,github,gate,now:()=>now});
  let chat=makeChat();
  const makeCoordinator=()=>new AutopilotCoordinator(store,{chat,watchtower,github,gate,now:()=>now,
    observe:async id=>{reads++;return read?read(id,now):observation({observedAt:now,bindingFingerprint:bindings.get(id),...values.get(id)});}});
  let coordinator=makeCoordinator();
  const config=id=>coordinator.configure(id,{bindingFingerprint:bindings.get(id),remainingWork:true,
    observationPermitted:true,executionPermitted:true,policy:{...policy,observationTimeoutMs:1000,...policyPatch}});
  const add=(id="work",binding=BINDING)=>{
    store.create({id,name:id,projectKey:"project",repository:"owner/repo",trackKey:"track"},now);
    bindings.set(id,binding);values.set(id,{});
    if(watched&&id==="work")gate.review(id);
    chat.configure(id,{enabled:true,mode:"scheduled",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:5});
    config(id);
  };
  add();
  return {store,evidence,values,bindings,config,add,watchtower,github,gate,
    get chat(){return chat;},get coordinator(){return coordinator;},
    reads:()=>reads,refreshes:()=>refreshes,clock:t=>{now=t;},
    restart:()=>{chat=makeChat();coordinator=makeCoordinator();return coordinator;},
    ready:async()=>{now=NOW+60_000;await coordinator.tick();now+=1000;return coordinator.tick();}};
}

test("inspection timers never become unconditional commands; one stable reply uses existing one-shot claim/ACK",async()=>{
  const f=fixture();try{
    f.clock(NOW+60_000);
    assert.equal(f.chat.tick().length,0);assert.equal(f.chat.commands().length,0);
    assert.equal((await f.coordinator.tick())[0].decision.nextAction,"INSPECT_AGAIN");
    f.clock(NOW+61_000);const result=await f.coordinator.tick();
    assert.ok(result[0].command);assert.equal(f.chat.commands().length,1);
    assert.equal(f.chat.tick().length,0);
    const command=f.chat.claim(ext);assert.ok(command);assert.equal(f.chat.claim(ext),null);
    assert.equal(f.chat.acknowledge(ext,command.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED").state,"sent");
    assert.equal(f.coordinator.state.latest("work").decision.nextAction,"CONTINUE");
    f.clock(NOW+122_000);await f.coordinator.tick();f.clock(NOW+123_000);await f.coordinator.tick();
    assert.equal(f.chat.commands().length,1);
  }finally{f.store.close();}
});

test("CI waits persist an independent external timer and no prompt; exact reviewed success releases one",async()=>{
  const f=fixture({watched:true});try{
    f.values.set("work",{ciWaitCue:true});
    Object.assign(f.evidence.watchtower.results[0],{decision:"WAIT_EXTERNAL",ciState:"RUNNING"});
    await f.coordinator.tick();f.clock(NOW+60_000);await f.coordinator.tick();
    f.clock(NOW+61_000);let r=await f.coordinator.tick();
    assert.equal(r[0].decision.nextAction,"WAIT_CI");assert.equal(f.chat.commands().length,0);
    const schedule=f.coordinator.get("work");assert.equal(schedule.next_external_check_at,NOW+65_000);
    assert.equal(schedule.next_inspect_at,NOW+62_000);
    Object.assign(f.evidence.watchtower.results[0],{decision:"VERIFY_GITHUB",ciState:"SUCCESS"});
    f.clock(NOW+65_000);r=await f.coordinator.tick();
    assert.ok(r[0].command);assert.ok(f.chat.claim(ext));assert.equal(f.chat.commands().length,1);
  }finally{f.store.close();}
});

test("external reinspection does not change response inspection or dispatch due time",async()=>{
  const f=fixture({watched:true,policyPatch:{inspectIntervalMs:60_000,maxAgeMs:120_000}});try{
    f.values.set("work",{ciWaitCue:true});
    Object.assign(f.evidence.watchtower.results[0],{decision:"WAIT_EXTERNAL",ciState:"QUEUED"});
    await f.coordinator.tick();const due=f.chat.config("work").nextDueAt;
    assert.equal(f.reads(),1);f.clock(NOW+5000);await f.coordinator.tick();
    assert.equal(f.reads(),1);assert.equal(f.coordinator.get("work").next_inspect_at,NOW+60_000);
    assert.equal(f.chat.config("work").nextDueAt,due);assert.equal(f.chat.commands().length,0);
    assert.equal(f.coordinator.get("work").next_external_check_at,NOW+10_000);
  }finally{f.store.close();}
});

test("wrong Track/attempt, stale source, open PR or unavailable Watchtower never queues",async()=>{
  for(const mutate of [f=>{f.evidence.watchtower.results[0].workTrackKey="other";},
    f=>{f.evidence.watchtower.results[0].attempt=1;},f=>{f.evidence.github.results[0].state="CHECKS_PASSED_NOT_MERGED";},
    f=>{f.evidence.watchtower.status="unavailable";},f=>{f.evidence.watchtower.checkedAt=NOW-200_000;
      f.watchtower.refresh=async()=>{f.evidence.watchtower.checkedAt=NOW-200_000;};}]){
    const f=fixture({watched:true});try{mutate(f);await f.ready();assert.equal(f.chat.commands().length,0);}finally{f.store.close();}
  }
});

test("claim rechecks the latest response, user draft, external evidence and freshness",async()=>{
  for(const mutate of [async f=>{f.values.set("work",{composerHasDraft:true});f.clock(NOW+62_000);await f.coordinator.tick();},
    async f=>{f.values.set("work",{replyFingerprint:"d".repeat(64)});f.clock(NOW+62_000);await f.coordinator.tick();},
    async f=>{f.evidence.watchtower.results[0].attempt=1;},async f=>f.clock(NOW+72_000)]){
    const f=fixture({watched:true});try{
      await f.ready();assert.equal(f.chat.commands().length,1);await mutate(f);
      assert.equal(f.chat.claim(ext),null);assert.equal(f.chat.commands()[0].state,"blocked");
    }finally{f.store.close();}
  }
});

test("restart retains inspection/CI schedule and consumes the same reply at most once",async()=>{
  const f=fixture();try{
    await f.ready();const cmd=f.chat.claim(ext);f.chat.acknowledge(ext,cmd.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    const schedule=f.coordinator.get("work");f.restart();
    assert.deepEqual(f.coordinator.get("work"),schedule);
    assert.equal(f.coordinator.state.reconcile(),0);
    f.clock(NOW+122_000);await f.coordinator.tick();f.clock(NOW+123_000);await f.coordinator.tick();
    assert.equal(f.chat.commands().length,1);
  }finally{f.store.close();}
});

test("unresolved claim after restart remains UNKNOWN even for a fresh different reply",async()=>{
  const f=fixture();try{
    await f.ready();assert.ok(f.chat.claim(ext));f.clock(NOW+190_000);f.chat.reconcile();f.restart();
    assert.equal(f.chat.commands()[0].state,"unknown");
    f.values.set("work",{replyFingerprint:"d".repeat(64)});await f.coordinator.tick();
    assert.equal(f.chat.commands().length,1);
    assert.throws(()=>f.config("work"),/APPROVAL_REQUIRED/);
  }finally{f.store.close();}
});

test("duplicate MV3 ticks while inspection is pending do not race or create duplicate observations",async()=>{
  let release;
  const f=fixture({read:(_id,now)=>new Promise(resolve=>{release=()=>resolve(observation({observedAt:now}));})});
  try{
    const first=f.coordinator.tick();await Promise.resolve();await Promise.resolve();
    assert.deepEqual(await f.coordinator.tick(),[]);release();await first;
    assert.equal(f.reads(),1);
    assert.equal(f.store.db.prepare("SELECT count(*) n FROM autopilot_observations").get().n,1);
  }finally{f.store.close();}
});

test("one failed observer only pauses its own axis; another can queue; source refresh coalesces",async()=>{
  const f=fixture({read:(id,now)=>id==="work"?Promise.reject(Error("PRIVATE_FAILURE")):
    observation({observedAt:now,bindingFingerprint:"d".repeat(64)})});
  try{
    f.add("other","d".repeat(64));await f.ready();
    assert.equal(f.chat.commands().length,1);assert.equal(f.chat.commands()[0].workstreamId,"other");
    assert.doesNotMatch(JSON.stringify(f.store.events()),/PRIVATE_FAILURE/);
    await Promise.all([f.coordinator.refreshExternal(),f.coordinator.refreshExternal()]);
    assert.equal(f.refreshes(),2);
  }finally{f.store.close();}
});

test("four-hour sleep never catches up old message slots and expired approval stays closed",async()=>{
  const f=fixture();try{
    f.clock(NOW+4*3_600_000);await f.coordinator.tick();await f.coordinator.tick();
    assert.equal(f.chat.commands().length,0);assert.equal(f.reads(),1);
    assert.ok(f.coordinator.get("work").next_inspect_at>NOW+4*3_600_000);
  }finally{f.store.close();}
});

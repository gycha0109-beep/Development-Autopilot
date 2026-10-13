import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatContinuation} from "../local/chat-continuation.js";

const ext="abcdefghijklmnopabcdefghijklmnop";
const session="registered-existing-chat";
function setup({watched=false,reviewed=false}={}){
  const store=new WorkstreamStore();
  let now=1_000_000,online=true,connected=true;
  store.create({id:"work",name:"BuildMap",projectKey:"build",repository:"owner/buildmap",
    intervalMinutes:35},now-1000);
  const bridge={getSnapshot:()=>({
    clients:[{extensionId:ext,status:online?"online":"offline"}],
    links:[{workstreamId:"work",extensionId:ext,sessionKey:session,
      status:connected?"connected":"stale"}],
    sessions:[{extensionId:ext,sessionKey:session,
      status:connected?"connected":"stale",origin:"https://chatgpt.com"}]
  })};
  const targets=()=>watched?[{workstreamId:"work"}]:[];
  const watchtower={targets:{list:targets}};
  const github={targets:{list:()=>[]}};
  const gate={one:()=>({decision:reviewed?"REVIEWED":"UNKNOWN"})};
  const chat=new ChatContinuation(store,{bridge,watchtower,github,gate,now:()=>now});
  return {store,chat,ext,session,
    clock:x=>{now=x},disconnect:()=>{online=false},stale:()=>{connected=false},
    close:()=>store.close()};
}
function approved(x,mode="scheduled",maxMessages=3,hours=8){
  return x.chat.configure("work",{enabled:true,mode,
    message:"확인하고 계속 진행",hours,maxMessages});
}
test("default is disabled; opt-in stores exact user-approved message and limits",()=>{
  const x=setup();try{
    assert.deepEqual(x.chat.configs(),[]);
    const cfg=approved(x);
    assert.equal(cfg.enabled,true);
    assert.equal(cfg.mode,"scheduled");
    assert.equal(cfg.message,"확인하고 계속 진행");
    assert.equal(cfg.nextDueAt,1_000_000+35*60_000);
    assert.equal(cfg.maxMessages,3);
    assert.equal(x.chat.tick().length,0);
  }finally{x.close()}
});
test("a scheduled due session yields one command and extension can claim it exactly once",()=>{
  const x=setup();try{
    approved(x);
    x.clock(1_000_000+35*60_000);
    const commands=x.chat.tick();
    assert.equal(commands.length,1);
    assert.equal(x.chat.tick().length,0);
    assert.equal(x.chat.claim("other-extension"),null);
    const job=x.chat.claim(x.ext);
    assert.equal(job.sessionKey,x.session);
    assert.equal(job.message,"확인하고 계속 진행");
    assert.equal(x.chat.claim(x.ext),null);
    const ack=x.chat.acknowledge(x.ext,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    assert.equal(ack.state,"sent");
    assert.equal(x.chat.config("work").sentCount,1);
    assert.equal(x.chat.config("work").statusReason,"MESSAGE_SUBMITTED_NOT_RESPONSE_VERIFIED");
    assert.throws(()=>x.chat.acknowledge(x.ext,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED"),
      /NOT_CLAIMED/);
  }finally{x.close()}
});
test("manual first send is immediate, but repeated immediate send is blocked by interval",()=>{
  const x=setup();try{
    approved(x,"manual");
    assert.equal(x.chat.tick().length,0);
    const first=x.chat.queue("work",{manual:true});
    assert.ok(first?.id);
    const command=x.chat.claim(x.ext);
    x.chat.acknowledge(x.ext,command.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    assert.equal(x.chat.queue("work",{manual:true}),null);
    x.clock(1_000_000+35*60_000);
    assert.ok(x.chat.queue("work",{manual:true})?.id);
  }finally{x.close()}
});
test("STOP and pause prevent any future new command",()=>{
  const x=setup();try{
    approved(x);
    x.clock(1_000_000+35*60_000);
    x.store.setStopped(true,2_000_000);
    assert.equal(x.chat.tick().length,0);
    x.store.setStopped(false,2_000_001);
    x.store.configure("work",{paused:true},2_000_001);
    assert.equal(x.chat.tick().length,0);
    x.chat.stop("work");
    assert.equal(x.chat.config("work").enabled,false);
    assert.equal(x.chat.tick().length,0);
  }finally{x.close()}
});
test("offline, lost URL mapping, or human-pending CI gate prevent opt-in or dispatch",()=>{
  for(const opt of [{watched:true,reviewed:false},{watched:false,reviewed:true}]){
    const x=setup(opt);try{
      if(opt.watched)assert.throws(()=>approved(x),/CI_PR_GATE_NOT_REVIEWED/);
      else{
        x.disconnect();
        assert.throws(()=>approved(x),/CHAT_SESSION_NOT_CONNECTED/);
      }
    }finally{x.close()}
  }
  const x=setup();try{
    approved(x);
    x.stale();
    x.clock(1_000_000+35*60_000);
    assert.equal(x.chat.tick().length,0);
    assert.equal(x.chat.commands().length,0);
  }finally{x.close()}
});
test("CI-bound session may send only when explicitly reviewed and exact target remains valid",()=>{
  const x=setup({watched:true,reviewed:true});try{
    approved(x);
    x.clock(1_000_000+35*60_000);
    const pending=x.chat.tick();
    assert.equal(pending.length,1);
    assert.ok(x.chat.claim(x.ext));
  }finally{x.close()}
});
test("lost acknowledgement is UNKNOWN after lease expires and NEVER automatically redelivered",()=>{
  const x=setup();try{
    approved(x);
    x.clock(1_000_000+35*60_000);
    const job=x.chat.tick()[0];
    assert.equal(x.chat.claim(x.ext).id,job.id);
    x.clock(1_000_000+35*60_000+120_001);
    assert.equal(x.chat.reconcile(),1);
    assert.equal(x.chat.config("work").enabled,false);
    assert.equal(x.chat.commands()[0].state,"unknown");
    assert.equal(x.chat.claim(x.ext),null);
    assert.equal(x.chat.tick().length,0);
    assert.throws(()=>x.chat.acknowledge(x.ext,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED"),/NOT_CLAIMED/);
  }finally{x.close()}
});
test("blocked or uncertain browser injection disables schedule rather than retrying",()=>{
  const x=setup();try{
    approved(x);
    x.clock(1_000_000+35*60_000);
    x.chat.tick();
    const job=x.chat.claim(x.ext);
    x.chat.acknowledge(x.ext,job.id,"blocked","COMPOSER_HAS_UNSENT_TEXT");
    assert.equal(x.chat.config("work").status,"blocked");
    assert.equal(x.chat.config("work").enabled,false);
    assert.equal(x.chat.tick().length,0);
  }finally{x.close()}
});
test("approval expiry and max count stop future prompts",()=>{
  const x=setup();try{
    approved(x,"scheduled",1,1);
    x.clock(1_000_000+35*60_000);
    x.chat.tick();
    const job=x.chat.claim(x.ext);
    x.chat.acknowledge(x.ext,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    x.clock(1_000_000+70*60_000);
    assert.equal(x.chat.tick().length,0);
    assert.equal(x.chat.config("work").enabled,false);
    assert.equal(x.chat.config("work").status,"expired");
  }finally{x.close()}
});
test("must not accept credentials, unbounded message volume, or shortened schedule",()=>{
  const x=setup();try{
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"x",hours:25,maxMessages:6}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"x".repeat(801),hours:8,maxMessages:6}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"go",hours:8,maxMessages:13}),/INVALID/);
    x.store.configure("work",{intervalMinutes:1},1000);
    assert.throws(()=>approved(x),/SCHEDULE_MIN_INTERVAL/);
  }finally{x.close()}
});


test("a scheduled consent retains exact CI fingerprint beyond short review TTL, but never bypasses changed checks",()=>{
  const x=setup({watched:true,reviewed:true});
  try{
    let evidence={decision:"REVIEWED",evidenceHash:"known-ci-sha-checkset"};
    x.chat.gate.one=()=>evidence;
    const cfg=approved(x);
    assert.equal(cfg.evidenceHash,"known-ci-sha-checkset");
    x.clock(1_000_000+35*60_000);
    evidence={decision:"WAIT_HUMAN",evidenceHash:"known-ci-sha-checkset"};
    assert.equal(x.chat.tick().length,1);
    const cmd=x.chat.claim(x.ext);
    assert.ok(cmd);
    x.chat.acknowledge(x.ext,cmd.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    x.clock(1_000_000+70*60_000);
    evidence={decision:"WAIT_HUMAN",evidenceHash:"CHANGED_REQUIRED_CHECKS"};
    assert.equal(x.chat.tick().length,0);
    assert.equal(x.chat.config("work").statusReason,"CI_PR_EVIDENCE_CHANGED_OR_STALE");
    assert.equal(x.chat.commands().length,1);
  }finally{x.close()}
});

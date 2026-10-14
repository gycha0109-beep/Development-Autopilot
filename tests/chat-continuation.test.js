import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {ChatContinuation} from "../local/chat-continuation.js";

const ext="abcdefghijklmnopabcdefghijklmnop";
const session="registered-existing-chat";
function setup({watched=false,reviewed=false}={}){
  const store=new WorkstreamStore();
  let now=1_000_000,online=true,connected=true,build="composer-2026-10-14-r8";
  store.create({id:"work",name:"BuildMap",projectKey:"build",repository:"owner/buildmap",
    intervalMinutes:35},now-1000);
  const bridge={getSnapshot:()=>({
    clients:[{extensionId:ext,status:online?"online":"offline",composerBuild:build}],
    links:[{workstreamId:"work",extensionId:ext,sessionKey:session,
      status:connected?"connected":"stale"}],
    sessions:[{extensionId:ext,sessionKey:session,
      status:connected?"connected":"stale",origin:"https://chatgpt.com"}]
  })};
  const targets=()=>watched?[{workstreamId:"work"}]:[];
  const watchtower={targets:{list:targets}};
  const github={targets:{list:()=>[]}};
  const gate={one:()=>({decision:reviewed?"REVIEWED":"UNKNOWN",evidenceHash:"a".repeat(64)})};
  const chat=new ChatContinuation(store,{bridge,watchtower,github,gate,now:()=>now});
  return {store,chat,ext,session,
    clock:x=>{now=x},disconnect:()=>{online=false},stale:()=>{connected=false},setBuild:x=>{build=x},
    close:()=>store.close()};
}
function approved(x,mode="scheduled",maxMessages=3,hours=8,intervalMinutes=35){
  return x.chat.configure("work",{enabled:true,mode,
    message:"확인하고 계속 진행",intervalMinutes,hours,maxMessages});
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
    assert.equal(cfg.intervalMinutes,35);
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
test("must not accept missing period/message, invalid values or unbounded volume",()=>{
  const x=setup();try{
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"x",intervalMinutes:10,hours:25,maxMessages:6}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"x".repeat(801),intervalMinutes:10,hours:8,maxMessages:6}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"go",intervalMinutes:10,hours:8,maxMessages:13}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      message:"go",hours:8,maxMessages:6}),/INVALID/);
    assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
      intervalMinutes:10,hours:8,maxMessages:6}),/INVALID/);
    for(const intervalMinutes of [0,-1,1441,1.5,"10",null]){
      assert.throws(()=>x.chat.configure("work",{enabled:true,mode:"scheduled",
        message:"go",intervalMinutes,hours:8,maxMessages:6}),/INVALID/);
    }
    x.store.configure("work",{intervalMinutes:1},1000);
    const config=approved(x,"scheduled",3,8,10);
    assert.equal(config.intervalMinutes,10);
    assert.equal(config.nextDueAt,1_000_000+10*60_000);
  }finally{x.close()}
});


test("a scheduled consent retains exact CI fingerprint beyond short review TTL, but never bypasses changed checks",()=>{
  const x=setup({watched:true,reviewed:true});
  try{
    let evidence={decision:"REVIEWED",evidenceHash:"a".repeat(64)};
    x.chat.gate.one=()=>evidence;
    const cfg=approved(x);
    assert.equal(cfg.evidenceHash,"a".repeat(64));
    x.clock(1_000_000+35*60_000);
    evidence={decision:"WAIT_HUMAN",evidenceHash:"a".repeat(64)};
    assert.equal(x.chat.tick().length,1);
    const cmd=x.chat.claim(x.ext);
    assert.ok(cmd);
    x.chat.acknowledge(x.ext,cmd.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    x.clock(1_000_000+70*60_000);
    evidence={decision:"WAIT_HUMAN",evidenceHash:"b".repeat(64)};
    assert.equal(x.chat.tick().length,0);
    assert.equal(x.chat.config("work").statusReason,"CI_PR_EVIDENCE_CHANGED_OR_STALE");
    assert.equal(x.chat.commands().length,1);
  }finally{x.close()}
});


test("user-specified 10-minute interval and custom message override workstream schedule",()=>{
  const x=setup();try{
    x.store.configure("work",{intervalMinutes:120},1_000_000);
    const msg="점검하고 다음 단계 진행";
    const cfg=x.chat.configure("work",{
      enabled:true,mode:"scheduled",message:msg,intervalMinutes:10,hours:8,maxMessages:3
    });
    assert.equal(cfg.message,msg);
    assert.equal(cfg.intervalMinutes,10);
    assert.equal(cfg.nextDueAt,1_600_000);
    x.clock(1_599_999);
    assert.deepEqual(x.chat.tick(),[]);
    x.clock(1_600_000);
    assert.equal(x.chat.tick().length,1);
    const job=x.chat.claim(x.ext);
    assert.equal(job.message,msg);
    x.chat.acknowledge(x.ext,job.id,"sent","SEND_BUTTON_CLICKED_UNVERIFIED");
    assert.equal(x.chat.config("work").nextDueAt,2_200_000);
    assert.equal(x.store.get("work").interval_minutes,120);
  }finally{x.close()}
});

test("legacy continuation without explicit chat interval is deactivated and requires reapproval",()=>{
  const x=setup();try{
    approved(x);
    x.store.db.prepare(
      "UPDATE chat_continuation_settings SET interval_minutes=NULL WHERE workstream_id='work'"
    ).run();
    const next=new ChatContinuation(x.store,{
      bridge:x.chat.bridge,watchtower:x.chat.watchtower,github:x.chat.github,
      gate:x.chat.gate,now:()=>1_000_000
    });
    const config=next.config("work");
    assert.equal(config.enabled,false);
    assert.equal(config.statusReason,"INTERVAL_REQUIRES_EXPLICIT_REAPPROVAL");
    assert.throws(()=>next.queue("work",{manual:true}),/NOT_APPROVED/);
    const replaced=next.configure("work",{enabled:true,mode:"manual",
      intervalMinutes:10,message:"다시 확인",hours:8,maxMessages:2});
    assert.equal(replaced.enabled,true);
    assert.equal(replaced.intervalMinutes,10);
  }finally{x.close()}
});

test("old Chrome background worker is not allowed to queue or claim approved prompts",()=>{
  const x=setup();
  try {
    x.setBuild(null);
    assert.throws(()=>approved(x),/CHAT_SESSION_NOT_CONNECTED/);
    x.setBuild("composer-2026-10-14-r8");
    approved(x);
    x.clock(1_000_000+35*60_000);
    const command=x.chat.tick()[0];
    assert.ok(command?.id);
    x.setBuild(null);
    assert.equal(x.chat.claim(x.ext),null);
    const record=x.chat.commands().find(c=>c.id===command.id);
    assert.equal(record.state,"blocked");
    assert.equal(record.reason,"SAFETY_PRECONDITION_CHANGED");
    assert.equal(x.chat.config("work").enabled,false);
  } finally { x.close(); }
});

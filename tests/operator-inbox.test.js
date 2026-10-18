import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {WorkstreamStore} from "../local/store.js";
import {OperatorInbox} from "../local/operator-inbox.js";
import {FakeMessenger} from "../local/fake-messenger.js";
import {AutopilotState} from "../local/autopilot-state.js";
import {ChatContinuation} from "../local/chat-continuation.js";
import {CHAT_COMPOSER_BUILD} from "../extension/chat-page.js";
import {NOW,SHA} from "../test-support/autopilot-fixture.js";

const action="a".repeat(64),sender="owner-phone",ext="abcdefghijklmnopabcdefghijklmnop";
function fixture({outcome="sent"}={}){
  const store=new WorkstreamStore();let now=NOW;
  for(const id of ["work","other"])store.create({id,name:id,projectKey:"project",repository:"owner/repo"},now);
  let current={verified:true,checkedAt:NOW,actionFingerprint:action,headSha:SHA,taskRevision:1};
  const opts={allowedSenders:[sender],now:()=>now,currentTarget:async()=>current};
  let inbox=new OperatorInbox(store,opts);
  const messenger=new FakeMessenger({outcome});
  const open=()=>inbox.open("work",{reasonCategory:"cost",reasonCode:"HUMAN_ACTION_CUE",actionFingerprint:action,
    headSha:SHA,evidenceTimestamp:now,expiresAt:now+600_000});
  const command=(request,kind="approve",patch={})=>({requestId:request.requestId,commandId:randomUUID(),command:kind,
    actionFingerprint:request.actionFingerprint,headSha:request.headSha,taskRevision:request.taskRevision,
    nonce:messenger.messages.at(-1)?.nonce,...patch});
  const deliver=async()=>{const request=open();await inbox.deliver(request.requestId,messenger);return request;};
  return {store,messenger,open,deliver,command,get inbox(){return inbox;},clock:at=>{now=at;},target:patch=>{current={...current,...patch};},
    restart:()=>{inbox=new OperatorInbox(store,opts);return inbox;},
    approve:async()=>{const request=await deliver();await inbox.receive(messenger.sign(sender,command(request)),messenger);return request;}};
}

test("local Inbox is canonical, deduplicates the action, pauses only its axis and acknowledgment is not approval",()=>{
  const f=fixture();try{
    const request=f.open();assert.equal(f.open().requestId,request.requestId);assert.equal(f.inbox.list().length,1);
    assert.equal(f.store.get("work").paused,true);assert.equal(f.store.get("other").paused,false);
    assert.equal(f.inbox.acknowledge(request.requestId).state,"pending");
    assert.ok(new AutopilotState(f.store).pending("work"));assert.equal(new AutopilotState(f.store).pending("other"),null);
  }finally{f.store.close();}
});

test("one authenticated exact approval yields at most one receipt; no execution or auto-resume",async()=>{
  const f=fixture();try{
    const request=await f.deliver(),body=f.command(request),envelope=f.messenger.sign(sender,body);
    assert.equal((await f.inbox.receive(envelope,f.messenger)).accepted,true);
    assert.equal((await f.inbox.receive(envelope,f.messenger)).accepted,false);
    const target={actionFingerprint:action,headSha:SHA,taskRevision:1};
    const receipts=await Promise.all([f.inbox.consumeApproval(request.requestId,target),f.inbox.consumeApproval(request.requestId,target)]);
    assert.equal(receipts.filter(Boolean).length,1);assert.equal(f.inbox.list()[0].state,"consumed");
    assert.equal(f.store.get("work").paused,true);assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("forged transport or disallowed sender cannot approve",async()=>{
  const f=fixture();try{
    const request=await f.deliver(),valid=f.messenger.sign(sender,f.command(request));
    for(const envelope of [{...valid,signature:"0".repeat(64)},f.messenger.sign("attacker",f.command(request)),
      {...valid,payload:valid.payload.replace(sender,"other")},{payload:"bad",signature:"bad"}]){
      assert.equal((await f.inbox.receive(envelope,f.messenger)).reasonCode,"SENDER_NOT_AUTHENTICATED");
    }
    assert.equal(f.inbox.list()[0].state,"pending");
  }finally{f.store.close();}
});

test("wrong action/SHA/revision/nonce, expiry and malicious command shapes are rejected",async()=>{
  const f=fixture();try{
    const request=await f.deliver();
    for(const patch of [{actionFingerprint:"b".repeat(64)},{headSha:"b".repeat(40)},{taskRevision:2},
      {nonce:"0".repeat(64)},{requestId:{}},{commandId:{}},{commandId:42},{command:"merge"}]){
      assert.equal((await f.inbox.receive(f.messenger.sign(sender,f.command(request,"approve",patch)),f.messenger)).accepted,false);
    }
    f.clock(NOW+600_000);
    assert.equal((await f.inbox.receive(f.messenger.sign(sender,f.command(request)),f.messenger)).reasonCode,"REQUEST_EXPIRED");
    assert.equal(f.inbox.list()[0].state,"expired");
  }finally{f.store.close();}
});

test("hold and resume preserve the approval requirement and global STOP",async()=>{
  const f=fixture();try{
    const request=await f.deliver();f.store.setStopped(true,NOW);
    for(const [kind,state] of [["hold","held"],["resume","pending"]]){
      const body=f.command(request,kind),envelope=f.messenger.sign(sender,body);
      assert.equal((await f.inbox.receive(envelope,f.messenger)).request.state,state);
      assert.equal((await f.inbox.receive(envelope,f.messenger)).reasonCode,"COMMAND_ALREADY_USED");
    }
    assert.equal(f.store.isStopped(),true);assert.equal(f.store.get("work").paused,true);
    assert.equal(await f.inbox.consumeApproval(request.requestId,{actionFingerprint:action,headSha:SHA,taskRevision:1}),null);
  }finally{f.store.close();}
});

test("approval consumption requires fresh independent current-target verification and no global STOP",async()=>{
  for(const patch of [{verified:false},{headSha:"b".repeat(40)},{actionFingerprint:"b".repeat(64)},
    {checkedAt:NOW-31_000},{taskRevision:2}]){
    const f=fixture();try{const request=await f.approve();f.target(patch);
      assert.equal(await f.inbox.consumeApproval(request.requestId,{actionFingerprint:action,headSha:SHA,taskRevision:1}),null);
    }finally{f.store.close();}
  }
  const f=fixture();try{const request=await f.approve();f.store.setStopped(true,NOW);
    assert.equal(await f.inbox.consumeApproval(request.requestId,{actionFingerprint:action,headSha:SHA,taskRevision:1}),null);
    f.store.setStopped(false,NOW);f.inbox.currentTarget=null;
    assert.equal(await f.inbox.consumeApproval(request.requestId,{actionFingerprint:action,headSha:SHA,taskRevision:1}),null);
  }finally{f.store.close();}
});

test("fake delivery has a prior durable intent; duplicate notification and uncertain delivery cannot replay",async()=>{
  const f=fixture();try{
    const request=f.open(),original=f.messenger.deliver.bind(f.messenger);
    f.messenger.deliver=async payload=>{assert.equal(f.inbox.row(request.requestId).delivery_state,"recorded");return original(payload);};
    assert.equal((await f.inbox.deliver(request.requestId,f.messenger)).sent,true);
    assert.equal((await f.inbox.deliver(request.requestId,f.messenger)).sent,false);assert.equal(f.messenger.messages.length,1);
  }finally{f.store.close();}
  const g=fixture();try{const request=g.open();g.messenger.deliver=async()=>{throw Error("PRIVATE_MESSENGER_FAILURE");};
    assert.equal((await g.inbox.deliver(request.requestId,g.messenger)).reasonCode,"DELIVERY_UNKNOWN");
    g.restart();await g.inbox.deliver(request.requestId,g.messenger);assert.equal(g.inbox.list()[0].deliveryAttempts,1);
    assert.equal(g.store.get("other").paused,false);assert.doesNotMatch(JSON.stringify(g.store.events()),/PRIVATE_/);
  }finally{g.store.close();}
});

test("definitely-not-sent delivery retries have a cap; real transport is blocked",async()=>{
  const f=fixture({outcome:"not_sent"});try{
    const request=f.open();for(let i=0;i<5;i++)await f.inbox.deliver(request.requestId,f.messenger);
    assert.equal(f.messenger.messages.length,3);assert.equal(f.inbox.list()[0].deliveryAttempts,3);
    await assert.rejects(f.inbox.deliver(request.requestId,{kind:"telegram"}),/NOT_IMPLEMENTED_OR_APPROVED/);
  }finally{f.store.close();}
});

test("restart during delivery records UNKNOWN and a late successful ACK cannot resurrect it",async()=>{
  const f=fixture();let release;
  try{
    const request=f.open();f.messenger.deliver=payload=>new Promise(resolve=>{release=()=>resolve({deliveryId:payload.deliveryId,status:"sent"});});
    const pending=f.inbox.deliver(request.requestId,f.messenger);
    f.restart();assert.equal(f.inbox.reconcile(),1);assert.equal(f.inbox.reconcile(),0);
    release();assert.equal((await pending).reasonCode,"DELIVERY_ALREADY_RECONCILED");
    assert.equal(f.inbox.list()[0].deliveryState,"unknown");assert.equal(f.inbox.list()[0].deliveryAttempts,1);
  }finally{f.store.close();}
});

test("nonce/body/signature never appear in canonical view, logs or stored plaintext; local close grants no approval",async()=>{
  const f=fixture();try{
    const request=await f.deliver(),nonce=f.messenger.messages[0].nonce;
    assert.equal(JSON.stringify(f.inbox.list()).includes(nonce),false);
    assert.equal(JSON.stringify(f.store.events()).includes(nonce),false);
    assert.equal(JSON.stringify(f.inbox.row(request.requestId)).includes(nonce),false);
    f.inbox.close(request.requestId,action);assert.equal(f.inbox.list()[0].state,"closed");
    assert.equal(f.store.get("work").paused,true);
    assert.equal(await f.inbox.consumeApproval(request.requestId,{actionFingerprint:action,headSha:SHA,taskRevision:1}),null);
  }finally{f.store.close();}
});

test("existing continuation cannot bypass a pending Inbox request by unpausing only",()=>{
  const f=fixture();try{
    const bridge={getSnapshot:()=>({clients:[{extensionId:ext,status:"online",composerBuild:CHAT_COMPOSER_BUILD}],
      links:[{workstreamId:"work",extensionId:ext,sessionKey:"session",status:"connected"}],
      sessions:[{extensionId:ext,sessionKey:"session",status:"connected",origin:"https://chatgpt.com"}]})};
    const source={targets:{list:()=>[]}};
    const chat=new ChatContinuation(f.store,{bridge,watchtower:source,github:source,gate:{one:()=>null},now:()=>NOW});
    chat.configure("work",{enabled:true,mode:"manual",message:"계속 진행",intervalMinutes:1,hours:1,maxMessages:2});
    chat.queue("work",{manual:true});f.open();f.store.configure("work",{paused:false},NOW);
    assert.equal(chat.claim(ext),null);assert.equal(chat.commands()[0].state,"blocked");
  }finally{f.store.close();}
});

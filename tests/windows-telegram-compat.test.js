import test from "node:test";
import assert from "node:assert/strict";
import {WorkstreamStore} from "../local/store.js";
import {HumanApprovalAlerts} from "../local/human-approval-alerts.js";
import {TelegramBotTransport} from "../local/telegram-bot-transport.js";
import {notificationSourceValidity} from "../local/notification-source-validation.js";
import {WindowsTelegramCompatibility,sendWindowsTelegramText}
  from "../local/windows-telegram-compat.js";

const fakeTransport=()=>new TelegramBotTransport({
  getCredential:async()=>({token:("123456:"+"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"),chatId:"1234567"}),
  fetchImpl:async()=>({ok:true,json:async()=>({ok:true,result:{message_id:1}})})
});
function setup(enabled=true){
  const store=new WorkstreamStore();
  let clock=100_000;
  store.db.prepare("INSERT INTO workstreams("+
    "id,name,project_key,repository,mode,state,enabled,paused,"+
    "interval_minutes,task_revision,created_at,updated_at) "+
    "VALUES('one','One','one','owner/repo','observe','READY',1,0,35,1,?,?)"
  ).run(clock,clock);
  const compat=new WindowsTelegramCompatibility(store,{
    enabled,transport:fakeTransport(),now:()=>clock,sendText:async()=>true
  });
  return {store,compat,advance:()=>clock+=10_000,close:()=>store.close()};
}
test("disabled Windows channel never enqueues notifications or attaches a sender",()=>{
  const a=setup(false);
  try{
    const approvals=new HumanApprovalAlerts(a.store);
    a.compat.attachApprovals(approvals);
    assert.equal(approvals.externalSenderConfigured,false);
    a.store.db.exec("UPDATE workstreams SET state='BLOCKED'");
    assert.equal(a.compat.observeBlockers(),0);
    assert.equal(a.compat.snapshot().telegramDelivery.enabled,false);
    assert.equal(a.compat.snapshot().notifications.length,0);
  }finally{a.close();}
});
test("new blocked state produces one durable intent, never repeats for unchanged state",()=>{
  const a=setup();
  try{
    a.store.db.exec("UPDATE workstreams SET state='BLOCKED'");
    assert.equal(a.compat.observeBlockers(),1);
    assert.equal(a.compat.observeBlockers(),0);
    const intent=a.store.db.prepare("SELECT * FROM notification_intents").get();
    assert.equal(intent.source_kind,"blocker");
    assert.equal(intent.reason_code,"WORKSTREAM_BLOCKED");
    assert.equal(notificationSourceValidity(a.store.db,intent,100_000),"VALID");
    const claimed=a.compat.delivery.claim(intent.intent_id);
    assert.equal(claimed.state,"CLAIMED");
    assert.equal(claimed.payload.sourceKind,"blocker");
    assert.equal(claimed.payload.workstreamName,"One");
  }finally{a.close();}
});
test("resolved blocker cannot be sent, and reopening produces a new revision",()=>{
  const a=setup();
  try{
    a.store.db.exec("UPDATE workstreams SET state='BLOCKED'");
    a.compat.observeBlockers();
    const first=a.store.db.prepare("SELECT * FROM notification_intents").get();
    a.store.db.exec("UPDATE workstreams SET state='READY'");
    a.compat.observeBlockers();
    assert.equal(notificationSourceValidity(a.store.db,first,100_000),
      "SOURCE_RESOLVED_OR_REPLACED");
    assert.equal(a.compat.delivery.claim(first.intent_id).state,"SUPPRESSED");
    a.store.db.exec("UPDATE workstreams SET state='BLOCKED',task_revision=task_revision+1");
    a.compat.observeBlockers();
    const intents=a.store.db.prepare("SELECT * FROM notification_intents ORDER BY source_revision").all();
    assert.equal(intents.length,2);
    assert.equal(intents[1].source_revision,2);
    assert.equal(notificationSourceValidity(a.store.db,intents[1],100_000),"VALID");
  }finally{a.close();}
});
test("restart keeps historical blocker records without fabricating a new alert",()=>{
  const a=setup();
  try{
    a.store.db.exec("UPDATE workstreams SET state='BLOCKED'");
    a.compat.observeBlockers();
    const reopened=new WindowsTelegramCompatibility(a.store,{
      enabled:true,transport:fakeTransport(),now:()=>100_000
    });
    assert.equal(reopened.observeBlockers(),0);
    assert.equal(reopened.snapshot().notifications.length,1);
  }finally{a.close();}
});
test("secure Windows-credential sender never stores a bot token",async()=>{
  let target,body;
  const token=("123456:"+"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk");
  const delivered=await sendWindowsTelegramText("Review required",{
    credentials:async()=>({token,chatId:"1234567"}),
    fetchImpl:async(url,init)=>{
      target=url;body=JSON.parse(init.body);
      assert.equal(init.method,"POST");
      assert.equal(init.redirect,"error");
      return {ok:true,json:async()=>({ok:true,result:{message_id:42}})};
    }
  });
  assert.equal(delivered,true);
  assert.ok(target.endsWith("/sendMessage"));
  assert.equal(body.text,"Review required");
  assert.equal(body.chat_id,"1234567");
  assert.equal(Object.hasOwn(body,"token"),false);
});
test("Windows sender marks an ambiguous provider response as uncertain",async()=>{
  await assert.rejects(sendWindowsTelegramText("Approve",{
    credentials:async()=>({
      token:("123456:"+"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk"),chatId:"1234567"}),
    fetchImpl:async()=>({ok:true,json:async()=>({ok:false})})
  }),/TELEGRAM_SEND_UNCERTAIN/);
});
test("opted-in compatibility attaches sender to new human-approval alerts",()=>{
  const a=setup();
  try{
    const approvals=new HumanApprovalAlerts(a.store);
    assert.equal(approvals.configured(),false);
    a.compat.attachApprovals(approvals);
    assert.equal(approvals.configured(),true);
    assert.equal(approvals.externalSenderConfigured,true);
  }finally{a.close();}
});

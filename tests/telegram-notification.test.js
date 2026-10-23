import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {WorkstreamStore} from "../local/store.js";
import {CiIncidentLedger} from "../local/ci-incident-ledger.js";
import {OperatorInbox} from "../local/operator-inbox.js";
import {SmsDeliveryDispatcher} from "../local/sms-delivery-dispatcher.js";
import {TelegramNotificationDispatcher} from "../local/telegram-notification-dispatcher.js";
import {TelegramBotTransport,telegramNotificationText} from "../local/telegram-bot-transport.js";

const NOW=Date.parse("2026-10-24T04:00:00Z"),TOKEN="12345678:"+("A".repeat(35));
const CONFIG={token:TOKEN,chatId:"123456789"};
const STATUS_BODY={ok:true,result:{message_id:800,chat:{id:123456789,type:"private"}}};
const resp=(status=200,data=STATUS_BODY)=>({
  status,ok:status>=200&&status<300,async json(){return data;}
});
function fixture({path=":memory:",enabled=true,fetchImpl=async()=>resp(),
  getCredential=async()=>CONFIG,config={},initialTime=NOW}={}){
  let now=initialTime;
  const store=new WorkstreamStore(path);
  for(const id of ["saju","myeongha"])if(!store.get(id))
    store.create({id,name:id,repository:"owner/"+id,projectKey:id},NOW);
  const clock=()=>now;
  const inbox=new OperatorInbox(store,{now:clock});
  const incidents=new CiIncidentLedger(store,{inbox,now:clock});
  const transport=new TelegramBotTransport({getCredential,fetchImpl,timeoutMs:3000});
  const telegram=new TelegramNotificationDispatcher(store,{
    transport,enabled,now:clock,...config
  });
  return {store,inbox,incidents,transport,telegram,
    advance:delta=>{now+=delta;},now:clock,
    blocker:(id="saju",detail="first")=>incidents.addBlocker(id,{
      reasonCode:"CI_REPAIR_EXHAUSTED",evidenceKey:detail
    }),
    approval:(id="saju")=>inbox.open(id,{
      reasonCategory:"approval",reasonCode:"HUMAN_CONFIRM_REQUIRED",
      actionFingerprint:"a".repeat(64),headSha:"b".repeat(40),
      evidenceTimestamp:now,expiresAt:now+600_000
    })};
}
const target=f=>f.incidents.notificationIntents().find(x=>x.state==="pending");
const status=(f,id)=>f.store.db.prepare(
  "SELECT * FROM telegram_delivery_states WHERE intent_id=?").get(id);
const attempts=(f,id)=>f.store.db.prepare(
  "SELECT * FROM telegram_delivery_attempts WHERE intent_id=?").all(id);

test("disabled Telegram channel only exposes read-only intent state, never sends",async()=>{
  let calls=0;const f=fixture({enabled:false,fetchImpl:async()=>{calls++;return resp();}});
  try{
    f.blocker();
    assert.equal(f.telegram.snapshot().enabled,false);
    assert.equal((await f.telegram.dispatch(target(f).intentId)).state,"NOT_ENABLED");
    assert.deepEqual(await f.telegram.drain(),[]);
    assert.equal(calls,0);
    assert.equal(attempts(f,target(f).intentId).length,0);
    assert.equal(f.store.operations().length,0);
    assert.equal(f.telegram.snapshot().repliesGrantApproval,false);
  }finally{f.store.close();}
});
test("enabled flag with missing OS secret does not claim or contact Telegram",async()=>{
  let calls=0;
  const f=fixture({getCredential:async()=>{throw Error("private credential details");},
    fetchImpl:async()=>{calls++;throw Error("should not run");}});
  try{
    f.blocker();const id=target(f).intentId;
    assert.deepEqual(await f.telegram.drain(),[]);
    assert.equal(status(f,id),undefined);
    assert.equal(calls,0);
    assert.equal(f.telegram.snapshot().configuredState,"CREDENTIAL_NOT_CONFIGURED");
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("Telegram sendMessage POST uses free mode, verified private destination, safe body and no approval controls",async()=>{
  const calls=[];
  const f=fixture({fetchImpl:async(url,opts)=>{
    calls.push({url,opts});return resp();
  }});
  try{
    f.blocker();const id=target(f).intentId;
    assert.equal((await f.telegram.dispatch(id)).state,"ACCEPTED");
    assert.equal(calls.length,1);
    assert.equal(calls[0].url,"https://api.telegram.org/bot"+TOKEN+"/sendMessage");
    assert.equal(calls[0].opts.method,"POST");
    assert.equal(calls[0].opts.redirect,"error");
    const payload=JSON.parse(calls[0].opts.body);
    assert.equal(payload.chat_id,CONFIG.chatId);
    assert.equal(payload.allow_paid_broadcast,false);
    assert.match(payload.text,/Development Autopilot/);
    assert.match(payload.text,/PC의 Operator Inbox/);
    assert.doesNotMatch(payload.text,/12345678:/);
    assert.equal(f.telegram.snapshot().records[0].deliveryState,"ACCEPTED");
    assert.equal(f.telegram.snapshot().realHandsetDeliveryVerified,false);
    assert.equal((await f.telegram.dispatch(id)).state,"ACCEPTED");
    assert.equal(calls.length,1);
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});

test("first Operator Inbox request stops its axis and can send its own notification",async()=>{
  const texts=[];
  const f=fixture({fetchImpl:async(_,o)=>{
    texts.push(JSON.parse(o.body).text);return resp();
  }});
  try{
    const req=f.approval("saju");
    assert.equal(req.state,"pending");
    assert.equal(f.store.get("saju").paused,true);
    assert.equal(f.store.get("myeongha").paused,false);
    const result=await f.telegram.dispatch(target(f).intentId);
    assert.equal(result.state,"ACCEPTED");
    assert.match(texts[0],/승인 확인 필요/);
    assert.equal(f.inbox.list()[0].state,"pending");
    assert.equal(f.store.operations().length,0);
  }finally{f.store.close();}
});
test("Telegram 429 is definitely rejected; respects server retry_after and max retry cap",async()=>{
  let calls=0;const f=fixture({config:{backoffMs:1000},fetchImpl:async()=>{
    calls++;return resp(429,{ok:false,error_code:429,
      parameters:{retry_after:3}});
  }});
  try{
    f.blocker();const id=target(f).intentId;
    const first=await f.telegram.dispatch(id);
    assert.equal(first.state,"NOT_SENT");
    assert.equal(first.retryAt,NOW+3000);
    assert.equal((await f.telegram.dispatch(id)).state,"BACKOFF");
    f.advance(3000);
    assert.equal((await f.telegram.dispatch(id)).state,"NOT_SENT");
    f.advance(3000);
    assert.equal((await f.telegram.dispatch(id)).state,"EXHAUSTED");
    f.advance(300000);
    assert.equal((await f.telegram.dispatch(id)).state,"EXHAUSTED");
    assert.equal(calls,3);
    assert.equal(attempts(f,id).length,3);
  }finally{f.store.close();}
});
test("Telegram API 403 is permanent, not resent; HTTP 500 and lost response are UNKNOWN",async()=>{
  for(const [fetchImpl,expected] of [
    [async()=>resp(403,{ok:false,error_code:403}),"PERMANENT_FAILURE"],
    [async()=>resp(500,{ok:false}),"UNKNOWN"],
    [async()=>{throw Error("SENSITIVE_INTERNAL_URL");},"UNKNOWN"],
    [async()=>resp(200,{ok:true,result:{message_id:900,chat:{id:-1001,type:"supergroup"}}}),"UNKNOWN"],
    [async()=>({status:200,ok:true,json:async()=>{throw Error("bad data");}}),"UNKNOWN"]
  ]){
    let count=0;const f=fixture({fetchImpl:async(...args)=>{
      count++;return fetchImpl(...args);
    }});
    try{
      f.blocker();const id=target(f).intentId;
      assert.equal((await f.telegram.dispatch(id)).state,expected);
      f.advance(5*86_400_000);
      assert.equal((await f.telegram.dispatch(id)).state,expected);
      assert.equal(count,1);
      assert.equal(f.store.operations().length,0);
      assert.doesNotMatch(JSON.stringify(f.telegram.snapshot()),/SENSITIVE_INTERNAL_URL/);
    }finally{f.store.close();}
  }
});
test("resolved blocker, old generation, expired approval and coalesced pause are suppressed",async()=>{
  let calls=0;const f=fixture({fetchImpl:async()=>{calls++;return resp();}});
  try{
    const blocker=f.blocker(),first=target(f);
    f.incidents.resolveBlocker("saju",blocker.blockerKey);
    assert.equal((await f.telegram.dispatch(first.intentId)).state,"SUPPRESSED");
    f.blocker();
    assert.equal((await f.telegram.dispatch(first.intentId)).state,"SUPPRESSED");
    const current=f.incidents.notificationIntents().find(x=>x.sourceKind==="blocker"&&x.sourceRevision===2);
    assert.equal((await f.telegram.dispatch(current.intentId)).state,"ACCEPTED");

    const req=f.approval("myeongha");
    const approval=f.incidents.notificationIntents().find(x=>x.sourceKind==="approval");
    assert.equal(req.state,"pending");
    f.advance(600_000);
    assert.equal((await f.telegram.dispatch(approval.intentId)).state,"SUPPRESSED");
    f.incidents.addBlocker("saju",{reasonCode:"DATA_CORRUPTION",
      evidenceKey:"urgent",severity:"critical"});
    const episode=f.incidents.notificationIntents().find(x=>x.sourceKind==="pause");
    assert.equal((await f.telegram.dispatch(episode.intentId)).state,"COALESCED");
    assert.equal(calls,1);
  }finally{f.store.close();}
});
test("concurrent drain and independent SQLite DB connections only commit one Telegram attempt",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-tg-multi-"));
  const path=join(dir,"telegram.sqlite3");
  let a=null,b=null,count=0,release;
  const fetchImpl=async()=>{
    count++;await new Promise(resolve=>{release=resolve;});
    return resp();
  };
  try{
    a=fixture({path,fetchImpl});
    a.blocker();const id=target(a).intentId;
    b=fixture({path,fetchImpl});
    const first=a.telegram.dispatch(id);
    while(!release)await new Promise(resolve=>setImmediate(resolve));
    const second=await b.telegram.dispatch(id);
    assert.equal(second.state,"IN_FLIGHT");
    release();
    assert.equal((await first).state,"ACCEPTED");
    assert.equal(count,1);
    assert.equal(attempts(a,id).length,1);
    assert.equal(a.store.operations().length,0);
  }finally{a?.store.close();b?.store.close();rmSync(dir,{recursive:true,force:true});}
});
test("startup expired lease reconciles UNKNOWN; never blindly replays old Telegram message",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"autopilot-tg-restart-"));
  const path=join(dir,"telegram.sqlite3"),fetchImpl=async()=>{throw Error("SHOULD_NOT_SEND");};
  let a;
  try{
    a=fixture({path,fetchImpl,config:{leaseMs:1000}});
    a.blocker();const id=target(a).intentId;
    assert.equal(a.telegram.claim(id).state,"CLAIMED");
    a.store.close();
    a=fixture({path,fetchImpl,config:{leaseMs:1000},initialTime:NOW+1000});
    assert.equal(a.telegram.snapshot().records[0].deliveryState,"UNKNOWN");
    assert.equal((await a.telegram.dispatch(id)).state,"UNKNOWN");
    assert.equal(attempts(a,id).length,1);
  }finally{a?.store.close();rmSync(dir,{recursive:true,force:true});}
});
test("daily/per-workstream budgets apply before transport, and 20 Workstreams do not cross-contaminate",async()=>{
  let calls=0;const f=fixture({config:{maxDaily:2,maxWorkstreamDaily:1,maxBatch:1},
    fetchImpl:async()=>{calls++;return resp();}});
  try{
    f.blocker("saju","a");f.blocker("saju","b");f.blocker("myeongha","c");
    const items=f.incidents.notificationIntents();
    const one=items.find(x=>x.workstreamId==="saju");
    const two=items.find(x=>x.workstreamId==="saju"&&x.intentId!==one.intentId);
    const three=items.find(x=>x.workstreamId==="myeongha");
    assert.equal((await f.telegram.dispatch(one.intentId)).state,"ACCEPTED");
    assert.equal((await f.telegram.dispatch(two.intentId)).state,"BUDGET_LIMIT");
    assert.equal((await f.telegram.dispatch(three.intentId)).state,"ACCEPTED");
    assert.equal(calls,2);
  }finally{f.store.close();}
  const multi=fixture({config:{maxDaily:40,maxWorkstreamDaily:2,maxBatch:1}});
  try{
    for(let i=0;i<20;i++){
      multi.store.create({id:"parallel-"+i,name:"Parallel "+i,repository:"owner/x",
        projectKey:"project"},NOW);
      multi.blocker("parallel-"+i,"same");
    }
    const results=await Promise.all(Array.from({length:20},()=>multi.telegram.drain()));
    // Mutex prevents concurrent drains from issuing competing Telegram sends.
    assert.equal(results.flat().length,1);
    assert.equal(multi.store.db.prepare(
      "SELECT count(*) AS n FROM telegram_delivery_attempts").get().n,1);
    assert.equal(multi.incidents.notificationIntents().length,20);
  }finally{multi.store.close();}
});
test("tokens and chat IDs never become SQLite values, snapshots or fake SMS receipts",async()=>{
  const f=fixture();
  try{
    f.blocker();const id=target(f).intentId;
    await f.telegram.dispatch(id);
    new SmsDeliveryDispatcher(f.store);
    const all=f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map(x=>x.name);
    for(const table of all){
      if(!/^[_a-z][a-z0-9_]*$/.test(table))continue;
      const values=f.store.db.prepare('SELECT * FROM "'+table+'"').all();
      const json=JSON.stringify(values);
      assert.ok(!json.includes(TOKEN),table+" has token");
      assert.ok(!json.includes(CONFIG.chatId),table+" has private chat id");
    }
    assert.ok(!JSON.stringify(f.telegram.snapshot()).includes(TOKEN));
    assert.ok(!JSON.stringify(f.telegram.snapshot()).includes(CONFIG.chatId));
  }finally{f.store.close();}
});
test("message formatting strips control characters, validates event and never emits reply approval",()=>{
  const message=telegramNotificationText({workstreamName:"sa\nju\t\u0000 long",
    sourceKind:"approval",severity:"normal",reasonCode:"USER_REVIEW"});
  assert.doesNotMatch(message,/\u0000/);
  assert.match(message,/Operator Inbox/);
  assert.match(message,/텔레그램 회신만으로/);
  assert.throws(()=>telegramNotificationText({
    workstreamName:"x",sourceKind:"other",reasonCode:"USER_REVIEW",severity:"normal"
  }),/TELEGRAM_EVENT_INVALID/);
});
test("Windows credential parser self-test does not enroll an account or reveal secrets",()=>{
  if(process.platform!=="win32")return;
  const out=execFileSync("powershell.exe",["-NoProfile","-NonInteractive",
    "-ExecutionPolicy","Bypass","-File",
    join(process.cwd(),"local","telegram-credentials.ps1"),"-Mode","SelfTest"],
    {encoding:"utf8",timeout:10000,windowsHide:true});
  assert.equal(out.trim(),"TELEGRAM_CREDENTIAL_SELFTEST_PASS");
});

test("stale pre-enrollment backlog older than seven days is suppressed, never bulk-sent",async()=>{
  let calls=0;
  const f=fixture({fetchImpl:async()=>{calls++;return resp();}});
  try{
    f.blocker();const id=target(f).intentId;
    f.advance(8*86_400_000);
    const result=await f.telegram.dispatch(id);
    assert.equal(result.state,"SUPPRESSED");
    assert.equal(result.reason,"HISTORICAL_INTENT_TOO_OLD");
    assert.equal(calls,0);
    assert.equal(attempts(f,id).length,0);
  }finally{f.store.close();}
});

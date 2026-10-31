// Compatibility adapter for the pre-existing Windows Credential Manager Telegram path.
// Keeps the old notification ledger, delivery receipts and opt-in guard intact.
import {createHash} from "node:crypto";
import {NotificationIntents} from "./notification-intents.js";
import {TelegramBotTransport,getWindowsTelegramCredential} from "./telegram-bot-transport.js";
import {TelegramNotificationDispatcher} from "./telegram-notification-dispatcher.js";

const key=id=>createHash("sha256").update(JSON.stringify([id,"telegram-workstream-blocker"])).digest("hex");
const recorded=(ws)=>({state:ws.state,revision:ws.task_revision,mode:ws.mode,enabled:ws.enabled});

export async function sendWindowsTelegramText(message,{
  credentials=getWindowsTelegramCredential,fetchImpl=fetch
}={}){
  if(typeof message!=="string"||!message||message.length>4096)
    throw Error("TELEGRAM_MESSAGE_INVALID");
  const {token,chatId}=await credentials();
  if(!/^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$/.test(token||"")||
     !/^[1-9][0-9]{4,19}$/.test(chatId||""))
    throw Error("TELEGRAM_CREDENTIAL_NOT_CONFIGURED");
  const response=await fetchImpl("https://api.telegram.org/bot"+token+"/sendMessage",{
    method:"POST",redirect:"error",
    headers:{"Content-Type":"application/json","Accept":"application/json"},
    body:JSON.stringify({chat_id:chatId,text:message,
      disable_web_page_preview:true,allow_paid_broadcast:false}),
    signal:AbortSignal.timeout(12000)
  });
  if(!response.ok)throw Error("TELEGRAM_HTTP_"+response.status);
  const result=await response.json();
  if(result?.ok!==true||!Number.isSafeInteger(result.result?.message_id))
    throw Error("TELEGRAM_SEND_UNCERTAIN");
  return true;
}

export class WindowsTelegramCompatibility {
  constructor(store,{enabled=process.env.AUTOPILOT_TELEGRAM_ENABLED==="1",
    transport=new TelegramBotTransport(),sendText=sendWindowsTelegramText,
    now=()=>Date.now()}={}){
    this.store=store;this.db=store.db;this.now=now;
    this.enabled=enabled===true;
    this.sendText=sendText;
    this.notifications=new NotificationIntents(store,{now});
    this.delivery=new TelegramNotificationDispatcher(store,{enabled:this.enabled,transport,now});
    this.db.exec("CREATE TABLE IF NOT EXISTS ci_blockers("+
      "workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,"+
      "blocker_key TEXT NOT NULL,reason_code TEXT NOT NULL,"+
      "severity TEXT NOT NULL CHECK(severity IN ('normal','critical')),"+
      "state TEXT NOT NULL CHECK(state IN ('open','resolved')),"+
      "created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,"+
      "PRIMARY KEY(workstream_id,blocker_key)) STRICT");
    // Do not notify about pre-upgrade blocked states. New transitions only.
    this.lastKnown=new Map(store.list().map(ws=>[ws.id,recorded(ws)]));
  }
  attachApprovals(approvals){
    if(!this.enabled)return;
    approvals.useExternalSender(message=>this.sendText(message));
  }
  observeBlockers(){
    if(!this.enabled)return 0;
    let created=0;
    for(const ws of this.store.list()){
      const before=this.lastKnown.get(ws.id);
      this.lastKnown.set(ws.id,recorded(ws));
      if(!before)continue;
      if(before.state===ws.state&&before.revision===ws.task_revision)continue;
      const blockerKey=key(ws.id);
      if(ws.state==="BLOCKED"&&ws.mode==="observe"&&ws.enabled){
        this.store.transaction(()=>{
          const prior=this.db.prepare("SELECT state FROM ci_blockers "+
            "WHERE workstream_id=? AND blocker_key=?").get(ws.id,blockerKey);
          if(prior?.state==="open")return;
          const time=this.now();
          this.db.prepare("INSERT INTO ci_blockers "+
            "(workstream_id,blocker_key,reason_code,severity,state,created_at,updated_at) "+
            "VALUES(?,?,?,'normal','open',?,?) ON CONFLICT(workstream_id,blocker_key) "+
            "DO UPDATE SET reason_code=excluded.reason_code,severity='normal',"+
            "state='open',updated_at=excluded.updated_at"
          ).run(ws.id,blockerKey,"WORKSTREAM_BLOCKED",time,time);
          this.notifications.record({workstreamId:ws.id,sourceKind:"blocker",
            sourceKey:blockerKey,
            sourceRevision:this.notifications.nextRevision("blocker",blockerKey),
            reasonCode:"WORKSTREAM_BLOCKED",severity:"normal"});
          created++;
        });
      }else if(before.state==="BLOCKED"&&ws.state!=="BLOCKED"){
        this.db.prepare("UPDATE ci_blockers SET state='resolved',updated_at=? "+
          "WHERE workstream_id=? AND blocker_key=? AND state='open'"
        ).run(this.now(),ws.id,blockerKey);
      }
    }
    return created;
  }
  async tick(){
    this.observeBlockers();
    return this.delivery.drain();
  }
  snapshot(){
    return {tracks:[],alerts:[],
      notifications:this.notifications.list(200),
      telegramDelivery:this.delivery.snapshot(),
      delivery:"telegram_opt_in_sms_disabled"};
  }
}

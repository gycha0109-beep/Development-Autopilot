import { randomUUID } from "node:crypto";

// Permission-gate notifications are advisory, never an authority to click
// "Allow once", "Always allow", or to control another session.
const TOOL=/^[^<>\r\n\x00-\x1f]{1,90}$/u;
const BOT=/^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT=/^-?[0-9]{4,20}$/;
export class HumanApprovalAlerts {
  constructor(store,{now=()=>Date.now(),token=process.env.AUTOPILOT_TELEGRAM_BOT_TOKEN||
      process.env.TELEGRAM_BOT_TOKEN||"",chatId=process.env.AUTOPILOT_TELEGRAM_CHAT_ID||
      process.env.TELEGRAM_CHAT_ID||"",send}={}){
    this.store=store;this.db=store.db;this.now=now;
    this.token=token;this.chatId=chatId;this.testSender=typeof send==="function";
    this.sender=send||this.sendTelegram.bind(this);
    this.delivering=false;
    this.db.exec("CREATE TABLE IF NOT EXISTS chat_tool_permission_alerts("+
      "id TEXT PRIMARY KEY,workstream_id TEXT NOT NULL REFERENCES workstreams(id) ON DELETE CASCADE,"+
      "extension_id TEXT NOT NULL,session_key TEXT NOT NULL,tool TEXT NOT NULL,"+
      "active INTEGER NOT NULL CHECK(active IN (0,1)),"+
      "first_seen_at INTEGER NOT NULL,absent_since INTEGER,"+
      "resolved_at INTEGER,notify_state TEXT NOT NULL,"+
      "attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL DEFAULT 0,"+
      "sent_at INTEGER,reason TEXT NOT NULL DEFAULT '') STRICT");
    this.db.exec("CREATE INDEX IF NOT EXISTS chat_tool_permission_pending "+
      "ON chat_tool_permission_alerts(workstream_id,active,first_seen_at)");
    // Telegram offers no idempotency token: never replay an interrupted send.
    this.db.prepare("UPDATE chat_tool_permission_alerts SET notify_state='unknown',"+
      "reason='DELIVERY_RESULT_UNKNOWN_NO_RETRY' WHERE notify_state='sending'").run();
  }
  updateCredentials(token,chatId){this.token=token;this.chatId=chatId;}
  configured(){return this.testSender||(BOT.test(this.token)&&CHAT.test(this.chatId));}
  status(){
    return {configured:BOT.test(this.token)&&CHAT.test(this.chatId),
      alerts:this.db.prepare("SELECT workstream_id,tool,active,first_seen_at,"+
        "resolved_at,notify_state,attempts,reason FROM chat_tool_permission_alerts "+
        "ORDER BY first_seen_at DESC LIMIT 20").all().map(x=>({
          workstreamId:x.workstream_id,tool:x.tool,active:Boolean(x.active),
          detectedAt:x.first_seen_at,resolvedAt:x.resolved_at,
          notification:x.notify_state,attempts:x.attempts,reason:x.reason
        }))};
  }
  active(workstreamId){
    return !!this.db.prepare("SELECT id FROM chat_tool_permission_alerts "+
      "WHERE workstream_id=? AND active=1 LIMIT 1").get(workstreamId);
  }
  observe(workstreamId,extensionId,sessionKey,observation){
    const status=observation?.toolApproval;
    if(observation?.verified!==true || status?.observed!==true)return {accepted:false};
    const now=this.now();
    const current=this.db.prepare("SELECT * FROM chat_tool_permission_alerts "+
      "WHERE workstream_id=? AND active=1 ORDER BY first_seen_at DESC LIMIT 1")
      .get(workstreamId);
    if(status.pending===true){
      if(status.kind!=="tool_permission"||!TOOL.test(status.tool||""))
        return {accepted:false};
      // Separate episode only after the prior popup disappears. Repeated
      // observations of the same popup never create repeated notifications.
      if(current&&current.extension_id===extensionId&&
         current.session_key===sessionKey&&current.tool===status.tool){
        this.db.prepare("UPDATE chat_tool_permission_alerts SET absent_since=NULL "+
          "WHERE id=?").run(current.id);
        return {accepted:true,pending:true,newAlert:false};
      }
      if(current)this.db.prepare("UPDATE chat_tool_permission_alerts SET active=0,"+
        "resolved_at=?,reason='SUPERSEDED_BY_NEW_TOOL_GATE' WHERE id=?").run(now,current.id);
      const alertId=randomUUID();
      this.db.prepare("INSERT INTO chat_tool_permission_alerts "+
        "(id,workstream_id,extension_id,session_key,tool,active,first_seen_at,"+
        "notify_state,reason) VALUES(?,?,?,?,?,1,?,'pending','WAITING_HUMAN_APPROVAL')")
        .run(alertId,workstreamId,extensionId,sessionKey,status.tool,now);
      return {accepted:true,pending:true,newAlert:true};
    }
    if(status.pending!==false||!current)return {accepted:true,pending:false};
    if(current.extension_id!==extensionId||current.session_key!==sessionKey)
      return {accepted:false};
    // Two trustworthy no-popup observations, 15s apart, are required to clear.
    // Generation may still be busy: response-completion gates remain separate.
    if(observation.uiAmbiguous!==false || observation.connectionWarning!==false ||
       observation.providerRestriction!==false || observation.otherWarning!==false)
      return {accepted:true,pending:true};
    if(current.absent_since===null){
      this.db.prepare("UPDATE chat_tool_permission_alerts SET absent_since=? WHERE id=?")
        .run(now,current.id);
      return {accepted:true,pending:true};
    }
    if(now-current.absent_since<15_000)return {accepted:true,pending:true};
    this.db.prepare("UPDATE chat_tool_permission_alerts SET active=0,resolved_at=?,"+
      "reason='APPROVAL_UI_CLEARED' WHERE id=?").run(now,current.id);
    return {accepted:true,pending:false,cleared:true};
  }
  async sendTelegram(message){
    if(!BOT.test(this.token)||!CHAT.test(this.chatId))
      throw Error("TELEGRAM_CREDENTIAL_NOT_CONFIGURED");
    const res=await fetch("https://api.telegram.org/bot"+this.token+"/sendMessage",{
      method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({chat_id:this.chatId,text:message,
        disable_web_page_preview:true}),signal:AbortSignal.timeout(12000)
    });
    if(!res.ok)throw Error("TELEGRAM_HTTP_"+res.status);
    const data=await res.json();
    if(data.ok!==true)throw Error("TELEGRAM_DELIVERY_NOT_CONFIRMED");
    return true;
  }
  async flush(){
    if(this.delivering)return {busy:true};
    if(!this.configured())return {configured:false};
    // Test-injected sender can run without real credentials.
    this.delivering=true;
    let attempted=0;
    try{
      for(const row of this.db.prepare("SELECT * FROM chat_tool_permission_alerts "+
        "WHERE active=1 AND notify_state IN ('pending','failed') AND "+
        "next_attempt_at<=? ORDER BY first_seen_at LIMIT 10").all(this.now())){
        const ws=this.store.mustGet(row.workstream_id);
        const now=this.now();
        this.db.prepare("UPDATE chat_tool_permission_alerts SET notify_state='sending',"+
          "attempts=attempts+1 WHERE id=? AND notify_state IN ('pending','failed')").run(row.id);
        const message=["🚨 Autopilot 도구 승인 요청","프로젝트: "+ws.name,
          "요청 도구: "+row.tool,"발생: "+new Date(row.first_seen_at).toLocaleString(
            "ko-KR",{timeZone:"Asia/Seoul"}),"PC에서 직접 허용 또는 거부해 주세요.",
          "승인 전까지 해당 대화의 자동 전송은 중지됩니다.",
          "※ 텔레그램 알림은 승인 권한을 부여하지 않습니다."].join("\n");
        attempted++;
        try{
          await this.sender(message);
          this.db.prepare("UPDATE chat_tool_permission_alerts SET notify_state='sent',"+
            "sent_at=?,reason='TELEGRAM_SENT' WHERE id=?")
            .run(this.now(),row.id);
        }catch(error){
          const code=String(error?.message||"").slice(0,80);
          // Requests with unknown delivery outcome are never automatically
          // replayed, preventing duplicate permission notifications.
          const unknown=!/^TELEGRAM_(?:HTTP_[0-9]{3}|CREDENTIAL_NOT_CONFIGURED)$/.test(code);
          this.db.prepare("UPDATE chat_tool_permission_alerts SET notify_state=?,"+
            "reason=?,next_attempt_at=? WHERE id=?")
            .run(unknown?"unknown":"failed",unknown?
              "DELIVERY_RESULT_UNKNOWN_NO_RETRY":code,
              now+Math.min(900_000,30_000*2**Math.min(row.attempts,5)),row.id);
        }
      }
      return {attempted};
    }finally{this.delivering=false;}
  }
}

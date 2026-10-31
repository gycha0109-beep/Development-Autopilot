import {promisify} from "node:util";
import {execFile} from "node:child_process";
import {fileURLToPath} from "node:url";

const run=promisify(execFile);
const credentialScript=fileURLToPath(new URL("./telegram-credentials.ps1",import.meta.url));
const BOT_TOKEN=/^[0-9]{5,15}:[A-Za-z0-9_-]{30,}$/;
const PRIVATE_CHAT=/^[1-9][0-9]{4,19}$/;
const EVENT_REASON=/^[A-Z][A-Z0-9_]{1,99}$/;

function safeCredential(value){
  return value&&typeof value==="object"&&
    BOT_TOKEN.test(value.token||"")&&PRIVATE_CHAT.test(value.chatId||"");
}

export async function getWindowsTelegramCredential(){
  if(process.platform!=="win32")throw Error("TELEGRAM_CREDENTIAL_UNAVAILABLE");
  try {
    const {stdout}=await run("powershell.exe",[
      "-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass",
      "-File",credentialScript,"-Mode","Read"
    ],{windowsHide:true,timeout:7000,maxBuffer:4096});
    const value=JSON.parse(stdout);
    if(!safeCredential(value))throw Error("INVALID_CREDENTIAL");
    return {token:value.token,chatId:value.chatId};
  }catch{
    // No exception, stderr or subprocess command line is ever forwarded.
    throw Error("TELEGRAM_CREDENTIAL_UNAVAILABLE");
  }
}
const cleanName=value=>String(value??"").replace(/[\r\n\t\x00-\x1f\x7f]/g," ")
  .replace(/\s+/g," ").trim().slice(0,64)||"Autopilot";
export function telegramNotificationText({workstreamName,sourceKind,severity,reasonCode}={}){
  if(!["blocker","approval","pause","test"].includes(sourceKind)||
     !EVENT_REASON.test(reasonCode||"")||
     !["normal","critical"].includes(severity))
    throw Error("TELEGRAM_EVENT_INVALID");
  const header=sourceKind==="test"?"연결 테스트":
    sourceKind==="approval"?"승인 확인 필요":
    sourceKind==="pause"?"작업 자동 중단":
    severity==="critical"?"긴급 블로커":"블로커 발생";
  const lines=[
    "[Development Autopilot] "+header,
    "작업: "+cleanName(workstreamName),
    "상태: "+reasonCode,
    "중요도: "+(severity==="critical"?"긴급":"일반"),
    "조치: PC의 Operator Inbox에서 확인하십시오.",
    "이 알림 또는 텔레그램 회신만으로 작업을 승인·재개하지 않습니다."
  ];
  return lines.join("\n");
}

export class TelegramBotTransport {
  constructor({fetchImpl=fetch,getCredential=getWindowsTelegramCredential,
    timeoutMs=8000}={}){
    if(typeof fetchImpl!=="function"||typeof getCredential!=="function"||
       !Number.isSafeInteger(timeoutMs)||timeoutMs<1000||timeoutMs>30000)
      throw Error("INVALID_TELEGRAM_TRANSPORT");
    this.kind="telegram";
    this.fetchImpl=fetchImpl;
    this.getCredential=getCredential;
    this.timeoutMs=timeoutMs;
  }
  async ready(){
    let configuration;
    try {configuration=await this.getCredential();}
    catch {throw Error("TELEGRAM_CREDENTIAL_UNAVAILABLE");}
    if(!safeCredential(configuration))throw Error("TELEGRAM_CREDENTIAL_UNAVAILABLE");
    return configuration;
  }
  async send(item,credentials=null){
    const config=credentials??await this.ready();
    if(!safeCredential(config))return {status:"permanent_failure",reason:"CREDENTIAL_INVALID"};
    // Telegram does not support a Bot API sendMessage idempotency key; an
    // uncertain HTTP result is intentionally unretryable by our dispatcher.
    const message=telegramNotificationText(item);
    try{
      const response=await this.fetchImpl(
        "https://api.telegram.org/bot"+config.token+"/sendMessage",{
          method:"POST",redirect:"error",
          headers:{"Content-Type":"application/json","Accept":"application/json"},
          body:JSON.stringify({
            chat_id:config.chatId,text:message,
            disable_web_page_preview:true,allow_paid_broadcast:false
          }),
          signal:AbortSignal.timeout(this.timeoutMs)
        }
      );
      // A response may be truncated, not JSON, or forged. No response body
      // or URL is ever copied into an error or operator-visible log.
      let data;
      try{data=await response.json();}catch{return {status:"unknown"};}
      if(response.status===429){
        const sec=data?.parameters?.retry_after;
        return {status:"not_sent",retryAfterMs:
          Number.isSafeInteger(sec)&&sec>=1&&sec<=3600?sec*1000:60_000};
      }
      if(response.status>=400&&response.status<500)return {
        status:"permanent_failure",reason:"TELEGRAM_HTTP_CLIENT_ERROR"
      };
      if(!response.ok||data?.ok!==true)return {status:"unknown"};
      const msg=data?.result;
      const providerMessageId=msg?.message_id;
      if(!Number.isSafeInteger(providerMessageId)||providerMessageId<1||
         msg?.chat?.type!=="private"||String(msg?.chat?.id)!==config.chatId)
        return {status:"unknown"};
      return {status:"accepted",providerMessageId:String(providerMessageId)};
    }catch{
      return {status:"unknown"};
    }
  }
}

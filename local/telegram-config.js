import {spawnSync} from "node:child_process";
import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync,unlinkSync} from "node:fs";
import {dirname} from "node:path";
import {randomUUID} from "node:crypto";

const BOT=/^[0-9]{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT=/^-?[0-9]{4,20}$/;
const PS_ENCRYPT='$ErrorActionPreference="Stop";$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd()) -AsPlainText -Force;[Console]::Out.Write((ConvertFrom-SecureString -SecureString $s))';
const PS_DECRYPT='$ErrorActionPreference="Stop";$s=ConvertTo-SecureString -String ([Console]::In.ReadToEnd());$p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p)}';
function powershell(script,input){
  if(process.platform!=="win32")throw Error("TELEGRAM_WINDOWS_DPAPI_REQUIRED");
  const p=spawnSync("powershell.exe",["-NoProfile","-NonInteractive","-Command",script],{
    input,encoding:"utf8",windowsHide:true,timeout:8000,maxBuffer:256*1024
  });
  if(p.error||p.status!==0||!p.stdout?.trim())
    throw Error("TELEGRAM_CREDENTIAL_PROTECTION_FAILED");
  return p.stdout.trim();
}
async function api(token,method,data,{fetchImpl=fetch}={}){
  const controller=new AbortController();
  const timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const res=await fetchImpl("https://api.telegram.org/bot"+token+"/"+method,{
      method:data?"POST":"GET",
      headers:{"Content-Type":"application/json"},
      ...(data?{body:JSON.stringify(data)}:{}),
      signal:controller.signal
    });
    if(!res.ok)throw Error("TELEGRAM_PROVIDER_HTTP_"+res.status);
    const result=await res.json();
    if(result?.ok!==true)throw Error("TELEGRAM_PROVIDER_RESPONSE_INVALID");
    return result.result;
  }catch(error){
    if(/^TELEGRAM_PROVIDER_/.test(error.message||""))throw error;
    throw Error("TELEGRAM_PROVIDER_UNREACHABLE");
  }finally{clearTimeout(timeout);}
}

export class TelegramLocalConfig {
  constructor(file,{fetchImpl=fetch,seal,unseal,botName="Johnny0109bot"}={}){
    this.file=file;this.fetchImpl=fetchImpl;this.seal=seal||((secret)=>powershell(PS_ENCRYPT,secret));
    this.unseal=unseal||((encrypted)=>powershell(PS_DECRYPT,encrypted));
    this.botName=botName;this.meta=null;
  }
  status(approvals){
    return {configured:!!this.meta&&approvals.configured(),
      botUsername:this.meta?.botUsername||null,
      chatIdSuffix:this.meta?.chatId?.slice(-4)||null,
      encryptedAt:this.meta?.encryptedAt||null};
  }
  restore(approvals){
    if(!existsSync(this.file))return false;
    try{
      const obj=JSON.parse(readFileSync(this.file,"utf8"));
      if(obj.schema!==1||typeof obj.protectedToken!=="string"||
         !CHAT.test(obj.chatId)||obj.botUsername!==this.botName)
        throw Error("TELEGRAM_CREDENTIAL_FILE_INVALID");
      const token=this.unseal(obj.protectedToken);
      if(!BOT.test(token))throw Error("TELEGRAM_DECRYPT_FAILED");
      approvals.updateCredentials(token,obj.chatId);
      this.meta={chatId:obj.chatId,botUsername:obj.botUsername,encryptedAt:obj.encryptedAt};
      return true;
    }catch{
      approvals.updateCredentials("","");
      this.meta=null;
      return false;
    }
  }
  async configure({botToken,chatId}={},approvals){
    if(typeof botToken!=="string"||!BOT.test(botToken))
      throw Error("TELEGRAM_BOT_TOKEN_INVALID");
    const me=await api(botToken,"getMe",null,{fetchImpl:this.fetchImpl});
    if(me?.is_bot!==true||me.username!==this.botName)
      throw Error("TELEGRAM_UNEXPECTED_BOT_USERNAME");
    let recipient=chatId==null||chatId===""?null:String(chatId);
    if(recipient!==null&&!CHAT.test(recipient))
      throw Error("TELEGRAM_CHAT_ID_INVALID");
    if(!recipient){
      const updates=await api(botToken,"getUpdates?limit=100&timeout=0",null,{fetchImpl:this.fetchImpl});
      const ids=[...new Set((Array.isArray(updates)?updates:[]).map(u=>
        u.message?.chat?.type==="private"&&
        u.message?.chat?.id!=null ? String(u.message.chat.id):null)
        .filter(x=>x&&CHAT.test(x)))];
      if(ids.length!==1)
        throw Error(ids.length?"TELEGRAM_MULTIPLE_RECIPIENTS_ENTER_CHAT_ID":
          "TELEGRAM_RECIPIENT_NOT_FOUND_SEND_START");
      recipient=ids[0];
    }
    const testMessage=[
      "✅ Development Autopilot 텔레그램 연결 테스트",
      "도구 승인 알림 수신 설정을 확인했습니다.",
      "앞으로 승인 요청이 나타나면 해당 대화를 중단하고 알립니다.",
      "권한 승인은 PC에서 직접 진행합니다."
    ].join("\n");
    await api(botToken,"sendMessage",{
      chat_id:recipient,text:testMessage,disable_web_page_preview:true
    },{fetchImpl:this.fetchImpl});
    const protectedToken=this.seal(botToken);
    if(typeof protectedToken!=="string"||protectedToken.length<20)
      throw Error("TELEGRAM_CREDENTIAL_PROTECTION_FAILED");
    const record={schema:1,protectedToken,chatId:recipient,
      botUsername:me.username,encryptedAt:Date.now()};
    mkdirSync(dirname(this.file),{recursive:true});
    const temp=this.file+"."+randomUUID()+".tmp";
    writeFileSync(temp,JSON.stringify(record),{encoding:"utf8",mode:0o600,flag:"wx"});
    renameSync(temp,this.file);
    approvals.updateCredentials(botToken,recipient);
    this.meta={chatId:recipient,botUsername:me.username,encryptedAt:record.encryptedAt};
    return {configured:true,botUsername:me.username,
      chatIdSuffix:recipient.slice(-4),testMessageSent:true};
  }
  clear(approvals){
    if(existsSync(this.file))unlinkSync(this.file);
    approvals.updateCredentials("","");
    this.meta=null;
    return {configured:false};
  }
}

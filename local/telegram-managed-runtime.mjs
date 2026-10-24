// SUN-managed Telegram runtime for a locally installed Autopilot copy.
// Opt-in notification worker + server, with NO credentials in argv, disk or log.
// A SHA-256 of a previously exposed key (not the key) is stored outside Git.
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {existsSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {Socket} from "node:net";
import {getWindowsTelegramCredential} from "./telegram-bot-transport.js";

const APP=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const HOME=resolve(APP,"..");
const PORT=48173;
const DATA=join(HOME,"data","autopilot.sqlite3");
const LOGDIR=join(HOME,"run");
const STATUS=join(LOGDIR,"status.json");
const BLOCKED_HASH=join(HOME,"config","exposed-token.sha256");
const USER_APPROVAL=join(HOME,"config","allow-existing-token.flag");
const APPROVAL_TEXT="USER_APPROVED_EXISTING_TELEGRAM_BOT_TOKEN";
const EXPECTED_BOT="johnny0109bot";
const RETRY_MS=60_000;
let stopping=false;
let child=null;
let lastState="";
mkdirSync(LOGDIR,{recursive:true});
const checksum=v=>createHash("sha256").update(v).digest("hex");
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function mark(state,additional={}){
  if(state!==lastState){console.log("[Telegram managed] "+state);lastState=state;}
  writeFileSync(STATUS,JSON.stringify({
    state,updatedAt:new Date().toISOString(),
    port:PORT,autopilotDatabase:"isolated-user-profile",
    ...additional
  })+"\n",{encoding:"utf8"});
}
function blockedTokenDigest(){
  if(!existsSync(BLOCKED_HASH))return null;
  const value=readFileSync(BLOCKED_HASH,"utf8").trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(value)?value:null;
}
function approvedExistingToken(){
  try{return readFileSync(USER_APPROVAL,"utf8").trim()===APPROVAL_TEXT;}
  catch{return false;}
}
function tokenStatus(token,exposed,approved=false){
  if(!exposed)return "ROTATION_GUARD_NOT_INSTALLED";
  if(checksum(token)!==exposed)return "ROTATED";
  return approved?"OPERATOR_APPROVED_EXISTING_TOKEN":
    "EXPOSED_TOKEN_ROTATION_REQUIRED";
}
const isReady=state=>state==="READY"||
  state==="READY_APPROVED_EXISTING_TOKEN";
async function credentialStatus({verifyOnline=true}={}){
  const exposed=blockedTokenDigest();
  if(!exposed)return "ROTATION_GUARD_NOT_INSTALLED";
  let credential;
  try{credential=await getWindowsTelegramCredential();}
  catch{return "WINDOWS_CREDENTIAL_NOT_READY";}
  const mode=tokenStatus(credential.token,exposed,approvedExistingToken());
  if(mode!=="ROTATED"&&mode!=="OPERATOR_APPROVED_EXISTING_TOKEN")
    return mode;
  if(!verifyOnline)return mode==="ROTATED"?"ROTATED_NOT_LIVE_VERIFIED":
    "EXISTING_TOKEN_APPROVED_NOT_LIVE_VERIFIED";
  try{
    const response=await fetch(
      "https://api.telegram.org/bot"+credential.token+"/getMe",{
        method:"POST",redirect:"error",
        headers:{"Content-Type":"application/json"},
        body:"{}",signal:AbortSignal.timeout(10_000)
      });
    if(!response.ok)return "BOT_IDENTITY_UNAVAILABLE";
    const data=await response.json();
    if(data?.ok!==true||data?.result?.is_bot!==true||
      String(data?.result?.username||"").toLowerCase()!==EXPECTED_BOT)
      return "BOT_IDENTITY_MISMATCH";
    return mode==="ROTATED"?"READY":"READY_APPROVED_EXISTING_TOKEN";
  }catch{return "BOT_IDENTITY_UNAVAILABLE";}
}
async function portBusy(){
  return await new Promise(resolve=>{
    const socket=new Socket();
    let done=false;
    const finish=busy=>{
      if(done)return;done=true;socket.destroy();resolve(busy);
    };
    socket.once("connect",()=>finish(true));
    socket.once("error",()=>finish(false));
    socket.setTimeout(1000,()=>finish(true));
    socket.connect(PORT,"127.0.0.1");
  });
}
async function health(){
  try{
    const response=await fetch("http://127.0.0.1:"+PORT+"/api/v1/snapshot",{
      signal:AbortSignal.timeout(2500),redirect:"error"
    });
    if(!response.ok)return null;
    const body=await response.json();
    return body?.version===1?body:null;
  }catch{return null;}
}
async function launch(telegramEnabled,initialGuardState){
  let settle;
  const ended=new Promise(resolve=>{settle=resolve;});
  const env={...process.env,
    AUTOPILOT_PORT:String(PORT),AUTOPILOT_DB:DATA,
    AUTOPILOT_TELEGRAM_ENABLED:telegramEnabled?"1":"0"};
  const next=spawn(process.execPath,["local/server.js"],{
    cwd:APP,env,stdio:["ignore","ignore","ignore"],windowsHide:true
  });
  child=next;
  let terminated=false;
  next.once("error",()=>{terminated=true;child=null;settle("SERVER_START_FAILED");});
  next.once("exit",code=>{
    terminated=true;child=null;
    settle(code===0?"SERVER_EXITED":"SERVER_EXITED_UNEXPECTEDLY");
  });
  for(let i=0;i<8&&!terminated&&!stopping;i++){
    const snapshot=await health();
    if(snapshot?.ciSupervision?.telegramDelivery?.enabled===telegramEnabled){
      mark(telegramEnabled?"RUNNING_TELEGRAM_ENABLED":"RUNNING_TELEGRAM_DISABLED",{
        globalStopped:snapshot.globalStopped,
        guardState:initialGuardState,
        workstreamCount:snapshot.workstreams?.length??0
      });
      break;
    }
    await delay(1000);
  }
  // Credentials are rechecked in the manager, never inside the running
  // server. A private rotated credential OR the explicit local operator
  // approval of the existing credential may enable notifications.
  while(!terminated&&!stopping){
    await Promise.race([delay(RETRY_MS),ended]);
    if(terminated||stopping)break;
    const state=await credentialStatus();
    if(isReady(state)!==telegramEnabled){
      mark(isReady(state)?"TOKEN_APPROVED_RESTARTING_ENABLED":
        "TELEGRAM_CREDENTIAL_GUARD_STOPPING_ENABLED_SERVER");
      try{next.kill();}catch{}
      await Promise.race([ended,delay(3000)]);
      return "MODE_TRANSITION";
    }
    const snapshot=await health();
    if(!snapshot||snapshot.ciSupervision?.telegramDelivery?.enabled!==telegramEnabled){
      mark("AUTOPILOT_HEALTH_UNAVAILABLE");
    }else{
      mark(telegramEnabled?"RUNNING_TELEGRAM_ENABLED":"RUNNING_TELEGRAM_DISABLED",{
        globalStopped:snapshot.globalStopped,
        guardState:state,
        workstreamCount:snapshot.workstreams?.length??0
      });
    }
  }
  return await Promise.race([ended,delay(3000).then(()=>"SERVER_STOP_PENDING")]);
}
process.on("SIGINT",()=>{
  stopping=true;
  if(child){try{child.kill();}catch{}}
});
process.on("SIGTERM",()=>{
  stopping=true;
  if(child){try{child.kill();}catch{}}
});
if(process.argv.includes("--selftest")){
  const fake="123456789:"+("A".repeat(35));
  if(tokenStatus(fake,checksum(fake),false)!=="EXPOSED_TOKEN_ROTATION_REQUIRED"||
     tokenStatus(fake,checksum(fake),true)!=="OPERATOR_APPROVED_EXISTING_TOKEN"||
     tokenStatus(fake,checksum("other"))!=="ROTATED"||
     tokenStatus(fake,null)!=="ROTATION_GUARD_NOT_INSTALLED")
    throw Error("GUARD_SELFTEST_FAILED");
  console.log("TELEGRAM_MANAGED_ROTATION_GUARD_SELFTEST_PASS");
}else if(process.argv.includes("--check")){
  const state=await credentialStatus({verifyOnline:false});
  mark(state);
  console.log("TELEGRAM_MANAGED_CHECK="+state);
  if(!["ROTATED_NOT_LIVE_VERIFIED",
    "EXISTING_TOKEN_APPROVED_NOT_LIVE_VERIFIED"].includes(state))process.exitCode=2;
}else{
  mark("STARTING_GUARD");
  while(!stopping){
    const credential=await credentialStatus();
    if(await portBusy()){
      mark("PORT_48173_OCCUPIED");
      await delay(RETRY_MS);
      continue;
    }
    const enableTelegram=isReady(credential);
    // Start the isolated dashboard with Telegram enabled only when the
    // selected credential has either been rotated or explicitly approved by
    // this user on SUN, and the Telegram bot identity has been verified.
    mark(enableTelegram?"STARTING_TELEGRAM_ENABLED":"STARTING_TELEGRAM_DISABLED",{
      guardState:credential
    });
    const result=await launch(enableTelegram,credential);
    if(stopping)break;
    if(result!=="MODE_TRANSITION")mark(result);
    await delay(result==="MODE_TRANSITION"?1000:RETRY_MS);
  }
  mark("STOPPED");
}

const $=id=>document.getElementById(id);
const model={tabs:[],registered:[],configs:[],paired:false,stopped:false,busy:false};
let selectionKey=null;

async function request(type,extras={}){
  const response=await chrome.runtime.sendMessage({type,...extras});
  if(!response?.ok)throw Error(response?.error||"확장 프로그램 응답 오류");
  return response.data;
}
function selectedTab(){return model.tabs.find(t=>String(t.id)===$("chat").value)||null;}
function registeredTab(){
  const tab=selectedTab();
  const rows=model.registered.filter(s=>s.tabId===tab?.id);
  return rows.length===1?rows[0]:null;
}
function changedIdentity(){
  const tab=selectedTab();
  const rows=model.registered.filter(s=>s.tabId===tab?.id);
  return rows.length>1||rows.length===1&&rows[0].url!==tab?.url;
}
function session(){return changedIdentity()?null:registeredTab();}
function config(){
  const key=session()?.key||registeredTab()?.key;
  return model.configs.find(c=>c.sessionKey===key)||null;
}
function awaitingReply(c){
  return ["WAIT_NEXT_REPLY","WAIT_POST_SEND_REPLY"].includes(c?.reason);
}
function blocked(c){
  return c?.status==="migrating"||c?.reason==="USER_APPROVAL_OR_PROVIDER_BLOCKER"||
    c?.reason==="GENERIC_MIGRATION_NEEDS_ATTENTION"||c?.reason==="AUTO_MIGRATION_NEEDS_ATTENTION";
}
function notice(message,error=false){
  $("status").textContent=message;
  $("status").classList.toggle("error",error);
}
function description(){
  const cfg=config();
  if(!model.paired)return "서버 연결이 필요합니다. 관리 화면에서 연결해 주세요.";
  if(changedIdentity())return "채팅 주소가 변경되었습니다. 중복 등록 방지를 위해 시작을 차단했습니다.";
  if(!selectedTab())return "열려 있는 ChatGPT 채팅방이 없습니다.";
  if(blocked(cfg))return "승인 또는 이관 확인이 필요합니다. 관리 화면에서 상태를 확인해 주세요.";
  if(cfg?.enabled)return "자동화 "+cfg.status+" · "+cfg.reason;
  if(cfg)return "중지됨 · "+cfg.reason;
  return "최초 등록이 필요합니다. 시작하면 연결하고, GitHub 저장소는 고급 설정에서 지정합니다.";
}
function paint(){
  const cfg=config(),canUse=model.paired&&!model.busy&&selectedTab()&&!changedIdentity();
  $("connection").textContent=model.paired?"Chrome 연결됨":"연결 필요";
  $("connection").classList.toggle("online",model.paired);
  const key=session()?.key||registeredTab()?.key||("tab:"+selectedTab()?.id);
  if(key!==selectionKey){
    selectionKey=key;
    $("macro").value=["general","roadmap","ci_red"].includes(cfg?.preferredMacroKey)?
      cfg.preferredMacroKey:"general";
  }
  $("start").disabled=!canUse||model.stopped||blocked(cfg);
  $("stop").disabled=!model.paired||model.busy||!registeredTab()||!cfg?.enabled;
  $("once").disabled=!canUse||blocked(cfg)||awaitingReply(cfg)||model.stopped;
  if(!$("status").classList.contains("error"))notice(description());
}
async function refresh(){
  const [discovered,local,bridge,state]=await Promise.all([
    request("AP_POPUP_DISCOVER"),request("AP_GET"),
    request("AP_BRIDGE_STATUS"),request("AP_POPUP_MACRO",{action:"state"})
  ]);
  const previous=$("chat").value;
  model.tabs=(discovered.tabs||[]).slice().sort((a,b)=>Number(b.active)-Number(a.active));
  model.registered=local.registry?.sessions||[];
  model.configs=state.sessions||[];
  model.paired=bridge.paired===true;
  model.stopped=state.globalStopped===true;
  $("chat").replaceChildren();
  for(const tab of model.tabs){
    const option=document.createElement("option");
    option.value=String(tab.id);
    option.textContent=tab.title||tab.url;
    $("chat").append(option);
  }
  if(!model.tabs.length){
    const option=document.createElement("option");
    option.value="";option.textContent="등록 가능한 채팅 없음";$("chat").append(option);
  }
  if(model.tabs.some(t=>String(t.id)===previous))$("chat").value=previous;
  model.busy=false;
  $("status").classList.remove("error");
  paint();
}
async function run(action){
  if(model.busy)return;
  model.busy=true;paint();
  try{
    const result=await action();
    await refresh();
    if(result)notice(result);
  }catch(error){
    model.busy=false;paint();
    notice(error.message,true);
  }
}
async function ensureRegistered(){
  if(changedIdentity())throw Error("기존 채팅 주소가 달라 신규 등록을 차단했습니다.");
  const tab=selectedTab();
  if(!tab)throw Error("채팅방을 선택해 주세요.");
  if(session())return session().key;
  await request("AP_POPUP_ENROLL",{tabId:tab.id});
  const local=await request("AP_GET");
  model.registered=local.registry?.sessions||[];
  if(!session())throw Error("채팅 등록을 확인하지 못했습니다.");
  return session().key;
}
$("chat").addEventListener("change",()=>{$("status").classList.remove("error");paint();});
$("macro").addEventListener("change",()=>{$("status").classList.remove("error");paint();});
$("start").addEventListener("click",()=>void run(async()=>{
  if(changedIdentity())throw Error("채팅 주소 변경: 관리 화면에서 복구해 주세요.");
  const before=config();
  if(blocked(before))throw Error("기존 승인 또는 이관이 해결되기 전에는 시작할 수 없습니다.");
  if(model.stopped)throw Error("전체 자동화 중지 상태입니다.");
  const macroKey=$("macro").value,key=await ensureRegistered();
  const old=config();
  if(!old?.repository)throw Error("CI 저장소 연결이 없습니다. 관리 화면에서 최초 1회 지정한 뒤 시작해 주세요.");
  await request("AP_POPUP_MACRO",{action:"configure",payload:{
    sessionKey:key,enabled:true,mode:"auto",intervalMinutes:old.intervalMinutes||5,
    preferredMacroKey:macroKey
  }});
  return "자동화 시작 설정 완료 · 확인된 답변과 CI 조건에 따라 진행됩니다.";
}));
$("stop").addEventListener("click",()=>void run(async()=>{
  const key=registeredTab()?.key;
  if(!key)throw Error("등록된 채팅방을 선택해 주세요.");
  await request("AP_POPUP_MACRO",{action:"stop",payload:{sessionKey:key}});
  return "선택한 채팅의 자동화를 중지했습니다.";
}));
$("once").addEventListener("click",()=>void run(async()=>{
  if(changedIdentity()||blocked(config())||awaitingReply(config())||model.stopped)
    throw Error("답변 수신 또는 안전 확인이 끝나지 않아 수동 실행을 차단했습니다.");
  const keyToSend=$("macro").value;
  if(!confirm("선택한 채팅에 '"+$("macro").selectedOptions[0].textContent+
    "' 매크로를 한 번 전송하시겠습니까?"))return "";
  const key=await ensureRegistered(),old=config();
  if(!old?.enabled){
    await request("AP_POPUP_MACRO",{action:"configure",payload:{
      sessionKey:key,enabled:true,mode:"manual",intervalMinutes:5,
      preferredMacroKey:"general"
    }});
  }
  await request("AP_POPUP_MACRO",{action:"send",payload:{sessionKey:key,macroKey:keyToSend}});
  return "수동 전송 요청 등록 · 실제 ChatGPT 수신 여부는 별도 확인이 필요합니다.";
}));
$("manage").addEventListener("click",async()=>{
  await chrome.runtime.openOptionsPage();
  window.close();
});
void refresh().catch(error=>{model.paired=false;paint();notice("상태 조회 실패: "+error.message,true);});

const stats = document.getElementById("popup-stats");
const button = document.getElementById("open-dashboard");

button.addEventListener("click", async () => {
  await chrome.runtime.openOptionsPage();
  window.close();
});

async function init() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "AP_GET" });
    if (!response?.ok) throw new Error(response?.error || "상태를 불러올 수 없습니다.");
    const { overview } = response.data;
    stats.replaceChildren();
    const counts = [
      ["감지된 그룹", overview.discoveredGroups],
      ["등록된 탭", overview.registeredTabs],
      ["활성 연결", overview.activeTabs],
      ["확인 필요", overview.attention]
    ];
    for (const [label, value] of counts) {
      const card = document.createElement("div");
      card.className = "popup-stat";
      const strong = document.createElement("strong");
      strong.textContent = String(value);
      const caption = document.createElement("span");
      caption.textContent = label;
      card.append(strong, caption);
      stats.append(card);
    }
  } catch (error) {
    stats.textContent = "상태 조회 실패: " + error.message;
  }
}
void init();



const el=id=>document.getElementById(id);
let quickState=null,quickRegistry=null,quickBridgePaired=false;
let quickDiscovery={tabs:[],groups:[]};
let macroState=null;
const macroLabels={
  general:"일반 진행",ci_red:"CI 레드",roadmap:"로드맵 현황 보고",
  blocker:"블로커·승인",network:"네트워크 오류",
  disconnect:"연결 해제",migration:"채팅 길이제한·이관"
};
function currentMacroSessionKey(){
  const tab=selectedQuickTab();
  return quickRegistry?.registry?.sessions?.find(s=>s.tabId===tab?.id&&s.url===tab?.url)?.key||null;
}
function macroStatus(){
  const key=currentMacroSessionKey();
  const cfg=macroState?.sessions?.find(s=>s.sessionKey===key);
  const stopped=macroState?.globalStopped===true;
  const status=el("macro-state");
  status.textContent=stopped?"전체 자동화 정지 중 · 설정 가능, 전송 불가":
    cfg?.enabled?"관제: "+cfg.mode+" / "+cfg.status+" · "+cfg.reason:
    cfg?"관제 중지: "+cfg.reason:"채팅을 등록하면 작업축 없이 매크로를 사용할 수 있습니다.";
  if(cfg&&document.activeElement!==el("macro-mode"))el("macro-mode").value=cfg.mode;
  if(cfg&&document.activeElement!==el("macro-interval"))
    el("macro-interval").value=String(cfg.intervalMinutes);
  el("macro-send").disabled=stopped||!selectedQuickTab();
  el("macro-stop").disabled=!cfg?.enabled;
  const prompt=el("macro-prompt");
  if(document.activeElement!==prompt)
    prompt.value=macroState?.templates?.[el("macro-key").value]||"";
}
async function ensureMacroChat(){
  const tab=selectedQuickTab();
  if(!tab)throw Error("전송할 ChatGPT 채팅을 선택해 주세요.");
  let key=currentMacroSessionKey();
  if(key)return key;
  const result=await popupRequest("AP_POPUP_ENROLL",{tabId:tab.id});
  const state=await popupRequest("AP_GET");
  quickRegistry=state;
  key=state.registry?.sessions?.find(s=>s.tabId===tab.id&&s.url===tab.url)?.key||
    result?.sessionKey;
  if(!key)throw Error("채팅 등록 상태를 확인하지 못했습니다.");
  return key;
}

async function popupRequest(type,extra={}){
  const r=await chrome.runtime.sendMessage({type,...extra});
  if(!r?.ok)throw Error(r?.error||"확장 프로그램이 응답하지 않습니다.");
  return r.data;
}
function quickNotice(message,error=false){
  el("quick-state").textContent=message;
  el("quick-state").classList.toggle("error",error);
}
function choices(id,items,value,label){
  const control=el(id),old=control.value;
  control.replaceChildren();
  for(const item of items){
    const option=document.createElement("option");
    option.value=String(value(item));
    option.textContent=label(item);
    control.append(option);
  }
  if(!items.length){
    const fallback=document.createElement("option");
    fallback.value="";
    fallback.textContent=id==="quick-tab"?"선택할 채팅 없음":
      id==="quick-group"?"같은 창에 기존 그룹 없음":"작업 목록 조회 필요";
    control.append(fallback);
  }
  if([...control.options].some(option=>option.value===old))control.value=old;
  control.disabled=items.length===0;
}
function selectedQuickTab(){
  return quickDiscovery.tabs.find(t=>String(t.id)===el("quick-tab").value);
}
function refreshGroupChoices(){
  const tab=selectedQuickTab();
  const groups=(quickDiscovery.groups||[]).filter(g=>g.windowId===tab?.windowId)
    .sort((a,b)=>a.id-b.id);
  choices("quick-group",groups,g=>g.id,
    g=>(g.title||"이름 없는 그룹")+(g.id===tab?.groupId?" (현재 그룹)":""));
  el("quick-attach-group").disabled=!tab||!groups.length;
}
async function refreshPairingStatus(){
  const health=el("quick-bridge-health");
  try{
    const status=await popupRequest("AP_BRIDGE_STATUS");
    quickBridgePaired=status.paired===true;
    health.textContent=quickBridgePaired?
      (status.error?"연결 정보 있음 · 동기화 오류":"연결됨"):"연결 필요";
    health.classList.toggle("error",Boolean(status.error));
  }catch{
    quickBridgePaired=false;
    health.textContent="상태 조회 실패";
    health.classList.toggle("error",true);
  }
}
async function quickRefresh(){
  try{
    await refreshPairingStatus();
    const discovered=await popupRequest("AP_POPUP_DISCOVER");
    quickDiscovery=discovered;
    choices("quick-tab",(discovered.tabs||[]).sort((a,b)=>Number(b.active)-Number(a.active)),
      t=>t.id,t=>t.title||t.url);
    refreshGroupChoices();
    let server;
    try{
      server=await popupRequest("AP_POPUP_CONTROL",{action:"state"});
    }catch(error){
      if(quickBridgePaired){
        const health=el("quick-bridge-health");
        health.textContent="연결 정보 있음 · 서버 확인 필요";
        health.classList.toggle("error",true);
      }
      throw error;
    }
    quickState=server;
    choices("quick-workstream",server.workstreams,w=>w.id,w=>w.name);
    const local=await popupRequest("AP_GET");
    quickRegistry=local;
    try{macroState=await popupRequest("AP_POPUP_MACRO",{action:"state"});}
    catch{macroState=null;}
    macroStatus();
    let migration={tracks:[]};
    try{migration=await popupRequest("AP_AUTO_MIGRATION_STATE");}catch{}
    const id=el("quick-workstream").value;
    const link=server.links.find(l=>l.workstreamId===id);
    const cfg=server.configs.find(c=>c.workstreamId===id);
    if(cfg&&el("quick-message").value==="")el("quick-message").value=cfg.message||"";
    if(cfg)el("quick-interval").value=cfg.intervalMinutes;
    const migrationIssue=(migration.tracks||[])
      .filter(t=>["needs_attention","resume_pending","awaiting_first_reply_after_rename"].includes(t.progress?.stage))
      .map(t=>t.trackTitle+": "+(t.progress?.reason||t.progress?.stage)).join(" / ");
    quickNotice("연결: "+(link?.status||"미연결")+
      " / 자동 진행: "+(cfg?.status||"미설정")+
      (cfg?.statusReason?"\n사유: "+cfg.statusReason:"")+
      (server.stopped?"\n전체 자동화 정지됨":"")+
      (migrationIssue?"\n이관: "+migrationIssue:"")+
      (!(discovered.tabs||[]).length?"\n기존 ChatGPT 채팅을 열어 주십시오.":""));
    await init();
  }catch(error){
    quickNotice("확인 실패: "+error.message,true);
  }
}
async function quickAct(buttonId,fn){
  const btn=el(buttonId);
  btn.disabled=true;
  try{
    const result=await fn();
    await quickRefresh();
    if(result?.notice)quickNotice(result.notice);
  }catch(error){
    quickNotice("실행 불가: "+error.message,true);
  }finally{
    btn.disabled=false;
  }
}
el("quick-tab").addEventListener("change",()=>{
  refreshGroupChoices();macroStatus();
});
el("macro-key").addEventListener("change",macroStatus);
el("macro-configure").addEventListener("click",()=>void quickAct("macro-configure",async()=>{
  const mode=el("macro-mode").value,intervalMinutes=Number(el("macro-interval").value);
  if(!Number.isSafeInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)
    throw Error("전송 간격은 1~1440분이어야 합니다.");
  if(!confirm("선택한 채팅에 "+(mode==="auto"?"자동 진행":"수동 진행")+
    " 매크로를 설정하시겠습니까? 기존 전체 정지는 유지됩니다."))return;
  const key=await ensureMacroChat();
  await popupRequest("AP_POPUP_MACRO",{action:"configure",
    payload:{sessionKey:key,enabled:true,mode,intervalMinutes}});
  return {notice:"작업축 없이 채팅 매크로 설정 완료. 전체 정지는 유지됩니다."};
}));
el("macro-template-save").addEventListener("click",()=>void quickAct("macro-template-save",async()=>{
  const prompt=el("macro-prompt").value.trim();
  if(!prompt)throw Error("매크로 내용을 입력해 주세요.");
  await popupRequest("AP_POPUP_MACRO",{action:"template",
    payload:{macroKey:el("macro-key").value,prompt}});
  return {notice:"매크로 문구 저장 완료"};
}));
el("macro-send").addEventListener("click",()=>void quickAct("macro-send",async()=>{
  const macroKey=el("macro-key").value;
  if(macroState?.globalStopped===true)
    throw Error("전체 자동화가 정지되어 있습니다. 관리 화면에서 별도로 재개해야 합니다.");
  if(!confirm("선택한 채팅에 '"+macroLabels[macroKey]+"' 매크로를 한 번 전송하시겠습니까?"))return;
  const key=await ensureMacroChat();
  if(!macroState?.sessions?.some(s=>s.sessionKey===key&&s.enabled)){
    await popupRequest("AP_POPUP_MACRO",{action:"configure",
      payload:{sessionKey:key,enabled:true,mode:"manual",intervalMinutes:2}});
  }
  await popupRequest("AP_POPUP_MACRO",{action:"send",
    payload:{sessionKey:key,macroKey}});
  return {notice:"매크로 전송 요청 등록. 실제 전송 여부는 상태 화면에서 확인해 주세요."};
}));
el("macro-stop").addEventListener("click",()=>void quickAct("macro-stop",async()=>{
  const key=currentMacroSessionKey();
  if(!key)throw Error("등록된 채팅을 선택해 주세요.");
  await popupRequest("AP_POPUP_MACRO",{action:"stop",payload:{sessionKey:key}});
  return {notice:"이 채팅의 매크로 자동 관제를 중지했습니다."};
}));

el("quick-attach-group").addEventListener("click",()=>void quickAct("quick-attach-group",async()=>{
  const tab=selectedQuickTab(),groupId=Number(el("quick-group").value);
  if(!tab||!el("quick-group").value||!Number.isInteger(groupId))
    throw Error("채팅과 기존 그룹을 선택하십시오.");
  const group=(quickDiscovery.groups||[]).find(g=>g.id===groupId && g.windowId===tab.windowId);
  if(!group)throw Error("동일한 Chrome 창의 그룹만 선택할 수 있습니다.");
  if(!confirm("선택한 채팅을 '"+(group.title||"이름 없는 그룹")+
      "' 그룹에 넣고 등록하시겠습니까?\n자동 진행 설정은 변경하지 않습니다."))return;
  const result=await popupRequest("AP_POPUP_ATTACH_GROUP",{tabId:tab.id,groupId});
  return {notice:"그룹 등록 완료: "+result.groupName+
    (result.preservedSession?"\n기존 채팅 등록 유지":"")+
    (result.syncPending?"\n서버 동기화 대기":"")};
}));
el("quick-pair").addEventListener("click",()=>void quickAct("quick-pair",async()=>{
  const code=el("quick-bridge-code").value.trim();
  if(!/^[a-f0-9]{20}$/i.test(code))
    throw Error("로컬 관리 화면에서 발급한 20자리 연결 코드를 입력하십시오.");
  if(quickBridgePaired && !confirm("기존 서버 연결을 교체하시겠습니까?"+
      "\n기존 작업과 채팅의 연결을 다시 설정해야 할 수 있습니다."))return;
  const result=await popupRequest("AP_POPUP_PAIR",{code});
  if(result?.connected!==true)throw Error(result?.message||"서버 연결에 실패했습니다.");
  el("quick-bridge-code").value="";
  return {notice:result.syncPending?
    "서버 인증 완료 · 채팅 정보 동기화 대기":"로컬 서버 연결 완료"};
}));
el("quick-bridge-code").addEventListener("keydown",event=>{
  if(event.key==="Enter"){
    event.preventDefault();
    el("quick-pair").click();
  }
});
el("quick-refresh").addEventListener("click",()=>void quickRefresh());
el("quick-workstream").addEventListener("change",()=>{
  el("quick-message").value="";
  const id=el("quick-workstream").value;
  const cfg=quickState?.configs?.find(x=>x.workstreamId===id);
  if(cfg){
    el("quick-message").value=cfg.message||"";
    el("quick-interval").value=cfg.intervalMinutes;
  }
  const link=quickState?.links?.find(x=>x.workstreamId===id);
  quickNotice("연결: "+(link?.status||"미연결")+" / "+(cfg?.statusReason||"설정 필요"));
});
el("quick-create-group").addEventListener("click",()=>void quickAct("quick-create-group",async()=>{
  const tab=selectedQuickTab();
  if(!tab)throw Error("채팅을 선택하십시오.");
  if(!confirm("선택한 ChatGPT 채팅을 새 Chrome 그룹으로 만들고 등록하시겠습니까?"))return;
  await popupRequest("AP_POPUP_CREATE_GROUP",{tabId:tab.id});
  return {notice:"새 그룹 생성 및 채팅 등록 완료"};
}));
el("quick-enroll").addEventListener("click",()=>void quickAct("quick-enroll",async()=>{
  const tab=selectedQuickTab();
  if(!tab)throw Error("채팅을 선택하십시오.");
  await popupRequest("AP_POPUP_ENROLL",{tabId:tab.id});
  return {notice:"채팅 등록 완료 · 자동 진행 설정은 변경되지 않았습니다."};
}));
el("quick-link").addEventListener("click",()=>void quickAct("quick-link",async()=>{
  const id=el("quick-workstream").value,tab=selectedQuickTab();
  if(!id||!tab)throw Error("채팅과 작업을 선택하십시오.");
  const registered=quickRegistry?.registry?.sessions||[];
  const session=registered.find(s=>s.tabId===tab.id&&s.url===tab.url);
  if(!session)throw Error("선택한 채팅을 먼저 등록하십시오.");
  const result=await popupRequest("AP_POPUP_CONTROL",{
    action:"link",payload:{workstreamId:id,sessionKey:session.key}
  });
  return {notice:"작업과 채팅 연결 완료"+
    (result.reapprovalRequired?"\n이 채팅에서 자동 진행을 다시 승인하십시오.":"")};
}));
el("quick-configure").addEventListener("click",()=>void quickAct("quick-configure",async()=>{
  const workstreamId=el("quick-workstream").value,message=el("quick-message").value.trim();
  const intervalMinutes=Number(el("quick-interval").value),mode=el("quick-mode").value;
  if(!workstreamId||!message||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)
    throw Error("프롬프트와 1~1440분 전송 간격이 필요합니다.");
  if(!confirm("선택한 작업에 프롬프트를 등록하고 "+
      (mode==="scheduled"?"반복 전송을 활성화":"수동 전송을 승인")+"하시겠습니까?"))return;
  await popupRequest("AP_POPUP_CONTROL",{
    action:"configure",payload:{workstreamId,enabled:true,mode,message,intervalMinutes}
  });
  return {notice:mode==="scheduled"?"자동 진행 설정 완료":"수동 전송 설정 완료"};
}));
el("quick-send").addEventListener("click",()=>void quickAct("quick-send",async()=>{
  const workstreamId=el("quick-workstream").value;
  if(!workstreamId)throw Error("작업을 선택하십시오.");
  if(!confirm("승인된 프롬프트를 지금 전송 요청하시겠습니까?"))return;
  const result=await popupRequest("AP_POPUP_CONTROL",{action:"send",payload:{workstreamId}});
  return {notice:result.command?"전송 요청 접수":"지금은 전송 조건을 충족하지 않습니다."};
}));
el("quick-stop").addEventListener("click",()=>void quickAct("quick-stop",async()=>{
  const workstreamId=el("quick-workstream").value;
  if(!workstreamId)throw Error("작업을 선택하십시오.");
  await popupRequest("AP_POPUP_CONTROL",{action:"stop",payload:{workstreamId}});
  return {notice:"자동 진행 정지 완료"};
}));
void quickRefresh();

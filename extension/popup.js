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
let quickState=null,quickRegistry=null;
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
    const o=document.createElement("option");
    o.value=String(value(item));o.textContent=label(item);control.append(o);
  }
  if(!items.length){
    const fallback=document.createElement("option");
    fallback.value="";
    fallback.textContent=id==="quick-tab"?"\uC120\uD0DD\uD560 \uCC44\uD305\uC774 \uC5C6\uC2B5\uB2C8\uB2E4":"\uC791\uC5C5 \uBAA9\uB85D \uC870\uD68C \uD544\uC694";
    control.append(fallback);
  }
  if([...control.options].some(o=>o.value===old))control.value=old;
}
async function quickRefresh(){
  try{
    const discovered=await popupRequest("AP_POPUP_DISCOVER");
    choices("quick-tab",(discovered.tabs||[]).sort((a,b)=>Number(b.active)-Number(a.active)),
      t=>t.id,t=>t.title||t.url);
    const server=await popupRequest("AP_POPUP_CONTROL",{action:"state"});
    quickState=server;
    choices("quick-workstream",server.workstreams,w=>w.id,w=>w.name);
    const local=await popupRequest("AP_GET");
    quickRegistry=local;
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
      (!el("quick-tab").options.length?"\n등록할 기존 채팅이 보이지 않으면 현재 채팅에서 새 그룹 만들기를 이용하십시오.":""));
    await init();
  }catch(e){quickNotice("확인 실패: "+e.message,true);}
}
async function quickAct(buttonId,fn){
  const btn=el(buttonId);btn.disabled=true;
  try{await fn();await quickRefresh();}
  catch(e){quickNotice("실행 불가: "+e.message,true);}
  finally{btn.disabled=false;}
}
el("quick-refresh").addEventListener("click",()=>void quickRefresh());
el("quick-workstream").addEventListener("change",()=>{
  el("quick-message").value="";
  const id=el("quick-workstream").value;
  const cfg=quickState?.configs?.find(x=>x.workstreamId===id);
  if(cfg){el("quick-message").value=cfg.message||"";el("quick-interval").value=cfg.intervalMinutes;}
  const link=quickState?.links?.find(x=>x.workstreamId===id);
  quickNotice("연결: "+(link?.status||"미연결")+" / "+(cfg?.statusReason||"설정 필요"));
});
el("quick-create-group").addEventListener("click",()=>void quickAct("quick-create-group",async()=>{
  if(!confirm("현재 ChatGPT 탭을 Chrome 그룹으로 묶고 등록하시겠습니까?"))return;
  await popupRequest("AP_POPUP_CREATE_GROUP");
}));
el("quick-enroll").addEventListener("click",()=>void quickAct("quick-enroll",async()=>{
  const tabId=Number(el("quick-tab").value);
  if(!el("quick-tab").value||!Number.isInteger(tabId))throw Error("채팅을 선택하십시오.");
  await popupRequest("AP_POPUP_ENROLL",{tabId});
}));
el("quick-link").addEventListener("click",()=>void quickAct("quick-link",async()=>{
  const id=el("quick-workstream").value,tabId=Number(el("quick-tab").value);
  if(!id||!el("quick-tab").value)throw Error("채팅과 작업을 선택하십시오.");
  const tab=quickRegistry.snapshot.tabs.find(t=>t.id===tabId);
  const session=quickRegistry.registry.sessions.find(s=>s.tabId===tabId&&s.url===tab?.url);
  if(!session)throw Error("선택한 채팅을 먼저 등록하십시오.");
  await popupRequest("AP_POPUP_CONTROL",{action:"link",payload:{workstreamId:id,sessionKey:session.key}});
}));
el("quick-configure").addEventListener("click",()=>void quickAct("quick-configure",async()=>{
  const workstreamId=el("quick-workstream").value,message=el("quick-message").value.trim();
  const intervalMinutes=Number(el("quick-interval").value),mode=el("quick-mode").value;
  if(!workstreamId||!message||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)
    throw Error("프롬프트와 1~1440분 전송 간격이 필요합니다.");
  if(!confirm("선택한 작업에 프롬프트를 등록하고 "+(mode==="scheduled"?"반복 전송을 활성화":"수동 전송을 승인")+"하시겠습니까?"))return;
  await popupRequest("AP_POPUP_CONTROL",{action:"configure",payload:{workstreamId,enabled:true,mode,message,intervalMinutes}});
}));
el("quick-send").addEventListener("click",()=>void quickAct("quick-send",async()=>{
  const workstreamId=el("quick-workstream").value;
  if(!workstreamId)throw Error("작업을 선택하십시오.");
  if(!confirm("승인된 프롬프트를 지금 전송 요청하시겠습니까?"))return;
  await popupRequest("AP_POPUP_CONTROL",{action:"send",payload:{workstreamId}});
}));
el("quick-stop").addEventListener("click",()=>void quickAct("quick-stop",async()=>{
  const workstreamId=el("quick-workstream").value;
  if(!workstreamId)throw Error("작업을 선택하십시오.");
  await popupRequest("AP_POPUP_CONTROL",{action:"stop",payload:{workstreamId}});
}));
void quickRefresh();

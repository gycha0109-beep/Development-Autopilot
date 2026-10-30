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
  if(!r?.ok)throw Error(r?.error||"?? ????? ???? ????.");
  return r.data;
}
function quickNotice(message,error=false){el("quick-state").textContent=message;el("quick-state").classList.toggle("error",error);}
function choices(id,items,value,label){
  const control=el(id),old=control.value;control.replaceChildren();
  for(const item of items){const o=document.createElement("option");o.value=String(value(item));o.textContent=label(item);control.append(o);}
  if([...control.options].some(o=>o.value===old))control.value=old;
}
async function quickRefresh(){
  try{
    const [local,server]=await Promise.all([popupRequest("AP_GET"),popupRequest("AP_POPUP_CONTROL",{action:"state"})]);
    quickState=server;quickRegistry=local;
    let migration={tracks:[]};
    try{migration=await popupRequest("AP_AUTO_MIGRATION_STATE");}catch{}

    choices("quick-tab",local.snapshot.tabs.filter(t=>t.url?.startsWith("https://chatgpt.com/")&&/\/c\//.test(t.url)),t=>t.id,t=>t.title||t.url);
    choices("quick-workstream",server.workstreams,w=>w.id,w=>w.name);
    const id=el("quick-workstream").value;
    const link=server.links.find(l=>l.workstreamId===id);
    const cfg=server.configs.find(c=>c.workstreamId===id);
    const migrationIssue=(migration.tracks||[]).filter(t=>t.progress?.stage==="needs_attention" || t.progress?.stage==="resume_pending" || t.progress?.stage==="awaiting_first_reply_after_rename").map(t=>t.trackTitle+": "+(t.progress?.reason||t.progress?.stage)).join(" / ");
    if(cfg&&el("quick-message").value==="")el("quick-message").value=cfg.message||"";
    if(cfg)el("quick-interval").value=cfg.intervalMinutes;
    quickNotice("??: "+(link?.status||"???")+" / ?? ??: "+(cfg?.status||"???")+(cfg?.statusReason?"\n??: "+cfg.statusReason:"")+(server.stopped?"\n?? ??? ???":"")+(migrationIssue?"\n??: "+migrationIssue:""));
  }catch(e){quickNotice("?? ??: "+e.message,true);}
}
async function quickAct(action,fn){
  const btn=el(action);btn.disabled=true;
  try{await fn();await quickRefresh();}
  catch(e){quickNotice("?? ??: "+e.message,true);}
  finally{btn.disabled=false;}
}
el("quick-refresh").addEventListener("click",()=>void quickRefresh());
el("quick-workstream").addEventListener("change",()=>{el("quick-message").value="";const id=el("quick-workstream").value,cfg=quickState?.configs?.find(x=>x.workstreamId===id);if(cfg){el("quick-message").value=cfg.message||"";el("quick-interval").value=cfg.intervalMinutes;}const link=quickState?.links?.find(x=>x.workstreamId===id);quickNotice("??: "+(link?.status||"???")+" / "+(cfg?.statusReason||"?? ??"));});
el("quick-create-group").addEventListener("click",()=>void quickAct("quick-create-group",async()=>{
  if(!confirm("?? ChatGPT ?? Chrome ???? ?? ?????????"))return;
  await popupRequest("AP_POPUP_CREATE_GROUP");
}));
el("quick-enroll").addEventListener("click",()=>void quickAct("quick-enroll",async()=>{const tabId=Number(el("quick-tab").value);if(!Number.isInteger(tabId)||!el("quick-tab").value)throw Error("??? ??????.");await popupRequest("AP_POPUP_ENROLL",{tabId});}));
el("quick-link").addEventListener("click",()=>void quickAct("quick-link",async()=>{
  const id=el("quick-workstream").value,tabId=Number(el("quick-tab").value);
  if(!id||!el("quick-tab").value)throw Error("??? ??? ??????.");
  const tab=quickRegistry.snapshot.tabs.find(t=>t.id===tabId);
  const session=quickRegistry.registry.sessions.find(s=>s.tabId===tabId&&s.url===tab?.url);
  if(!session)throw Error("??? ??? ?? ??????.");
  await popupRequest("AP_POPUP_CONTROL",{action:"link",payload:{workstreamId:id,sessionKey:session.key}});
}));
el("quick-configure").addEventListener("click",()=>void quickAct("quick-configure",async()=>{
  const workstreamId=el("quick-workstream").value,message=el("quick-message").value.trim();
  const intervalMinutes=Number(el("quick-interval").value),mode=el("quick-mode").value;
  if(!workstreamId||!message||!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)throw Error("????? 1~1440? ?? ??? ?????.");
  if(!confirm("??? ??? ????? ???? "+(mode==="scheduled"?"?? ??? ???":"?? ??? ??")+"???????"))return;
  await popupRequest("AP_POPUP_CONTROL",{action:"configure",payload:{workstreamId,enabled:true,mode,message,intervalMinutes}});
}));
el("quick-send").addEventListener("click",()=>void quickAct("quick-send",async()=>{
  const workstreamId=el("quick-workstream").value;if(!workstreamId)throw Error("??? ??????.");
  if(!confirm("??? ????? ?? ?? ?????????"))return;
  await popupRequest("AP_POPUP_CONTROL",{action:"send",payload:{workstreamId}});
}));
el("quick-stop").addEventListener("click",()=>void quickAct("quick-stop",async()=>{
  const workstreamId=el("quick-workstream").value;if(!workstreamId)throw Error("??? ??????.");
  await popupRequest("AP_POPUP_CONTROL",{action:"stop",payload:{workstreamId}});
}));
void quickRefresh();

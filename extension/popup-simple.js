const $ = id => document.getElementById(id);
const model = {tabs:[],registry:[],configurations:[],repositories:[],connected:false,stopped:false,busy:false};
let renderedSelectionKey=null;
let renderedRepoKey=null;

async function api(type, extras={}){
  let timeout;
  try{
    const response=await Promise.race([
      chrome.runtime.sendMessage({type,...extras}),
      new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(Error("확장 프로그램 상태 조회가 지연되고 있습니다. 관리 화면에서 연결을 확인하세요.")),8000);
      })
    ]);
    if(!response?.ok)throw Error(response?.error||"로컬 연결 또는 확장 프로그램 응답 오류");
    return response.data;
  }finally{clearTimeout(timeout);}
}
function show(message,error=false){
  $("status").textContent=message;
  $("status").classList.toggle("error",error);
}
function tab(){return model.tabs.find(item=>String(item.id)===$("chat").value)||null;}
function tabRegistration(){
  const selected=tab();
  const found=model.registry.filter(item=>item.tabId===selected?.id);
  return found.length===1?found[0]:null;
}
function registrationMismatch(){
  const selected=tab(),record=tabRegistration();
  const ambiguous=model.registry.filter(item=>item.tabId===selected?.id).length>1;
  return ambiguous||Boolean(record&&record.url!==selected?.url);
}
function session(){
  const record=tabRegistration();
  return !registrationMismatch()?record:null;
}
function config(){
  const key=session()?.key||tabRegistration()?.key;
  return model.configurations.find(item=>item.sessionKey===key)||null;
}
function readObservers(){
  return [...$("additional-repositories").querySelectorAll('input[type="checkbox"]:checked')]
    .map(input=>({repository:input.value,branch:"main"}));
}
function configureRepoControls(){
  const cfg=config();
  const selection=session()?.key||tabRegistration()?.key||("tab:"+tab()?.id);
  if(renderedRepoKey===selection)return;
  renderedRepoKey=selection;
  const names=[...new Set([
    ...model.repositories,cfg?.repository,...(cfg?.ciObservers||[]).map(x=>x.repository)
  ].filter(Boolean))].sort((a,b)=>a.localeCompare(b));
  const primary=$("repository");
  primary.replaceChildren();
  const first=document.createElement("option");
  first.value="";first.textContent="CI 저장소 선택";primary.append(first);
  for(const name of names){
    const item=document.createElement("option");
    item.value=name;item.textContent=name;primary.append(item);
  }
  primary.value=cfg?.repository||"";
  $("ci-branch").value=cfg?.ciBranch||"main";
  const extra=$("additional-repositories");
  extra.replaceChildren();
  for(const name of names){
    const label=document.createElement("label");
    label.className="repo-entry";
    const input=document.createElement("input");
    input.type="checkbox";input.value=name;
    input.checked=(cfg?.ciObservers||[]).some(x=>x.repository===name&&x.branch==="main");
    input.disabled=name===primary.value;
    label.append(input);
    const text=document.createElement("span");
    text.textContent=name+" (main)";
    label.append(text);
    extra.append(label);
  }
}
function selectedCi(){
  const repository=$("repository").value;
  const ciBranch=$("ci-branch").value.trim();
  const ciObservers=readObservers();
  if(!repository)throw Error("CI 저장소를 선택하세요.");
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,159}$/.test(ciBranch)||
      ciBranch.includes("..")||ciBranch.includes("//")||
      ciBranch.endsWith("/")||ciBranch.includes("@{"))
    throw Error("CI 브랜치 이름을 확인하세요.");
  if(ciObservers.length>3)throw Error("추가 저장소는 최대 3개까지 선택할 수 있습니다.");
  if(ciObservers.some(x=>x.repository===repository))
    throw Error("기본 CI 저장소를 추가 관측에 중복 등록할 수 없습니다.");
  return {repository,ciBranch,ciObservers};
}
function isApprovalBlocked(cfg){
  return cfg?.status==="paused"&&cfg.reason==="USER_APPROVAL_OR_PROVIDER_BLOCKER";
}
function stateMessage(){
  const cfg=config();
  if(!model.connected)return "로컬 서버가 연결되지 않았습니다. 관리 화면에서 연결을 확인하세요.";
  if(model.stopped)return "전체 자동화가 중지된 상태입니다.";
  if(!tab())return "열려 있는 ChatGPT 채팅방이 없습니다.";
  if(registrationMismatch())return "등록된 채팅의 주소가 변경됐습니다. 중복 등록을 방지하기 위해 시작을 차단했습니다. 관리 화면에서 이관 상태와 연결을 확인하세요.";
  if(!cfg)return "최초 설정이 필요합니다. 시작하면 채팅을 등록하며, CI 저장소 연결은 관리 화면에서 지정합니다.";
  if(cfg.status==="migrating")return "기존 채팅 이관 중입니다. 이관 완료 확인 전에는 다시 시작하지 않습니다.";
  if(isApprovalBlocked(cfg))return "승인 해제 여부를 자동 확인 중입니다. 검증되면 재개합니다.";
  if(cfg.reason==="WAIT_ADDITIONAL_CI")return "추가 CI 저장소의 실행 결과를 확인 중입니다. 모두 SUCCESS여야 이어집니다.";
  if(cfg.enabled)return "자동화 실행 중 · "+cfg.status+" / "+cfg.reason;
  return "자동화 중지됨 · "+cfg.reason;
}
function paint(){
  const cfg=config();
  configureRepoControls();
  const connected=Boolean(model.connected);
  $("connection").textContent=connected?"Chrome 연결됨":"연결 확인 필요";
  $("connection").classList.toggle("online",connected);
  const currentSelectionKey=session()?.key||tabRegistration()?.key||("tab:"+tab()?.id);
  if(renderedSelectionKey!==currentSelectionKey){
    renderedSelectionKey=currentSelectionKey;
    $("macro").value=["general","roadmap","ci_red"].includes(cfg?.preferredMacroKey)?
      cfg.preferredMacroKey:"general";
  }
  $("start").disabled=model.busy||!connected||model.stopped||!tab()||
    registrationMismatch()||cfg?.status==="migrating";
  $("stop").disabled=model.busy||!connected||!tab()||!cfg?.enabled;
  $("once").disabled=model.busy||!connected||!tab()||
    registrationMismatch()||cfg?.status==="migrating"||isApprovalBlocked(cfg);
  if(!$("status").classList.contains("error"))show(stateMessage());
}
async function refresh(){
  try{
    // One read-only fast path, never blocked by migration and send jobs.
    const state=await api("AP_POPUP_SNAPSHOT");
    const previous=$("chat").value;
    model.tabs=(state.tabs||[]).slice().sort((a,b)=>Number(b.active)-Number(a.active));
    model.registry=state.registry?.sessions||[];
    model.configurations=state.sessions||[];
    model.repositories=[...new Set([...(state.repositories||[]),
      ...((state.repositoryDirectory?.repositories||[]).map(x=>x.name))])];
    model.connected=state.connected===true;
    model.stopped=state.globalStopped===true;
    const choices=model.tabs.map(t=>({value:String(t.id),label:t.title||t.url}));
    $("chat").replaceChildren();
    for(const item of choices){
      const opt=document.createElement("option");
      opt.value=item.value;opt.textContent=item.label;
      $("chat").append(opt);
    }
    if(!choices.length){
      const opt=document.createElement("option");
      opt.value="";opt.textContent="열려 있는 채팅방 없음";$("chat").append(opt);
    }
    if(choices.some(t=>t.value===previous))$("chat").value=previous;
    model.busy=false;
    $("status").classList.remove("error");
    paint();
    if(state.error)show("연결 상태: "+state.error,true);
  }catch(error){
    model.connected=false;
    model.busy=false;
    paint();
    show("상태 조회 실패: "+error.message,true);
  }
}
async function perform(fn){
  if(model.busy)return;
  model.busy=true;paint();
  try{
    const message=await fn();
    await refresh();
    if(message)show(message);
  }catch(error){
    model.busy=false;paint();
    show(error.message,true);
  }
}
async function ensureSession(){
  const selected=tab();
  if(!selected)throw new Error("채팅방을 선택하세요.");
  if(registrationMismatch())throw new Error("등록된 탭의 대화 주소가 달라 중복 등록을 차단했습니다. 관리 화면에서 복구하세요.");
  const existing=session();
  if(existing)return existing.key;
  await api("AP_POPUP_ENROLL",{tabId:selected.id});
  const local=await api("AP_GET");
  model.registry=local.registry?.sessions||[];
  const next=session();
  if(!next)throw new Error("채팅 등록 검증에 실패했습니다. 관리 화면을 확인하세요.");
  return next.key;
}
$("chat").addEventListener("change",()=>{
  $("status").classList.remove("error");
  paint();
});
$("repository").addEventListener("change",()=>{
  const primary=$("repository").value;
  for(const input of $("additional-repositories").querySelectorAll('input[type="checkbox"]')){
    if(input.value===primary)input.checked=false;
    input.disabled=input.value===primary;
  }
});
$("macro").addEventListener("change",()=>{
  $("status").classList.remove("error");
  paint();
});
$("start").addEventListener("click",()=>void perform(async()=>{
  if(registrationMismatch())throw new Error("채팅 주소가 변경되어 시작을 차단했습니다. 관리 화면에서 이관 상태를 확인하세요.");
  const prior=config();
  if(isApprovalBlocked(prior)){
    if(!confirm("어드민 채팅의 승인 요청을 실제로 완료하셨습니까? 기존 전송 기록을 보존하고, 새로운 답변과 CI를 다시 확인한 뒤 자동화를 재개합니다."))return "";
    await api("AP_POPUP_MACRO",{action:"resumeApproved",
      payload:{sessionKey:session().key,confirmed:true}});
    return "승인 완료 재확인 요청을 적용했습니다. 안전 검증을 통과해야 실제 전송됩니다.";
  }
  if(prior?.status==="migrating")
    throw new Error("이관 진행 중에는 자동화를 재설정할 수 없습니다.");
  const macroKey=$("macro").value;
  const key=await ensureSession();
  const cfg=config();
  if(!cfg?.repository){
    throw new Error("GitHub 저장소 연결이 없습니다. 관리 화면에서 최초 1회 연결한 뒤 시작하세요.");
  }
  const ciSelection=selectedCi();
  if(cfg&&(cfg.repository!==ciSelection.repository||
     cfg.ciBranch!==ciSelection.ciBranch))
    ciSelection.ciWorkflows=null;
  await api("AP_POPUP_MACRO",{action:"configure",payload:{
    sessionKey:key,enabled:true,mode:"auto",
    intervalMinutes:cfg.intervalMinutes||5,preferredMacroKey:macroKey,
    ...ciSelection
  }});
  return "시작 설정 완료 · CI와 답변이 검증되면 자동 진행합니다.";
}));
$("stop").addEventListener("click",()=>void perform(async()=>{
  const key=session()?.key||tabRegistration()?.key;
  if(!key)throw new Error("등록된 채팅을 선택하세요.");
  await api("AP_POPUP_MACRO",{action:"stop",payload:{sessionKey:key}});
  return "선택한 채팅의 자동화를 중지했습니다.";
}));
$("once").addEventListener("click",()=>void perform(async()=>{
  if(registrationMismatch())throw new Error("채팅 주소가 변경되어 수동 전송을 차단했습니다.");
  const cfg=config();
  if(isApprovalBlocked(cfg)||cfg?.status==="migrating")
    throw new Error("승인 또는 이관이 끝나지 않았습니다. 이 상태에서는 수동 전송도 보류합니다.");
  const macroKey=$("macro").value;
  if(!confirm("선택한 채팅에 '"+$("macro").selectedOptions[0].textContent+
    "' 매크로를 수동으로 한 번만 전송하시겠습니까?"))return "";
  const key=await ensureSession();
  if(!config()?.enabled){
    await api("AP_POPUP_MACRO",{action:"configure",payload:{
      sessionKey:key,enabled:true,mode:"manual",intervalMinutes:5,
      preferredMacroKey:"general",...selectedCi()
    }});
  }
  await api("AP_POPUP_MACRO",{action:"send",payload:{sessionKey:key,macroKey}});
  return "수동 1회 전송 요청을 등록했습니다. 클릭 완료 및 실제 수신은 별도 검증이 필요합니다.";
}));
$("manage").addEventListener("click",async()=>{
  await chrome.runtime.openOptionsPage();
  window.close();
});
void refresh();

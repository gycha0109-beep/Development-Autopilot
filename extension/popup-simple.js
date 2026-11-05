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
function statusLabel(reason){
 const map={
 OBSERVATION_UNVERIFIED:"화면 검증 실패",OBSERVATION_RETRY_PENDING:"재검증 중",
 USER_APPROVAL_OR_PROVIDER_BLOCKER:"승인·권한 확인 필요",
 OPERATOR_APPROVAL_CONFIRMED_REVERIFY:"승인 완료 재검증 중",
 CI_BRANCH_REMOVED_NEEDS_NEW_TARGET:"CI 브랜치 재설정",
 CHAT_IDENTITY_CHANGED_REAPPROVAL:"채팅 주소 확인",
 WAIT_VERIFIED_CI:"CI 대기",WAIT_ADDITIONAL_CI:"추가 CI 대기",
 CI_STATUS_UNAVAILABLE:"CI 확인 불가",WAIT_POST_SEND_REPLY:"답변 대기",
 WAIT_NEXT_REPLY:"다음 답변 대기",OPERATOR_STOPPED:"사용자 중지",
 RECONNECTED_AWAIT_VERIFIED_REPLY:"연결 후 재검증 중"
 };
 return map[reason]||reason||"설정 필요";
}
function ciLabel(ci){
 if(!ci||ci.status!=="observed")return "CI 미확인";
 return {SUCCESS:"성공",FAILURE:"실패",RUNNING:"실행 중"}[ci.ciState]||"미확인";
}
function overviewButton(text,callback){
 const b=document.createElement("button");
 b.textContent=text;b.type="button";b.disabled=model.busy||!model.connected;
 b.addEventListener("click",()=>void perform(callback));
 return b;
}
function renderOverview(){
 const root=$("overview-list");
 root.replaceChildren();
 let active=0,missing=0,blocked=0;
 for(const t of model.tabs){
   const matches=model.registry.filter(r=>r.tabId===t.id);
   const reg=matches.length===1&&matches[0].url===t.url?matches[0]:null;
   const mismatch=matches.length>1||matches.length===1&&!reg;
   const cfg=model.configurations.find(c=>c.sessionKey===reg?.key);
   const item=document.createElement("div");
   item.className="overview-row"+(String(t.id)===$("chat").value?" selected":"");
   const top=document.createElement("div");top.className="overview-title";
   const name=document.createElement("strong");
   name.textContent=(t.groupTitle?t.groupTitle+" · ":"")+t.title;
   const label=document.createElement("span");label.className="overview-state";
   if(mismatch){label.textContent="주소 불일치";blocked++;}
   else if(!reg){label.textContent="미등록";missing++;}
   else if(!cfg){label.textContent="미설정";blocked++;}
   else if(!cfg.enabled){label.textContent="중지";blocked++;}
   else {label.textContent="활성";active++;}
   label.className+=" "+(cfg?.enabled?"good":mismatch||cfg?.reason==="USER_APPROVAL_OR_PROVIDER_BLOCKER"?"bad":"wait");
   top.append(name,label);item.append(top);
   const detail=document.createElement("div");detail.className="overview-detail";
   detail.textContent=mismatch?"등록 주소 불일치 · 관리 화면에서 재연결 필요":
     !reg?"탭 등록 후 자동화 설정 가능":
     !cfg?"매크로와 CI 설정 필요":
     statusLabel(cfg.reason)+(cfg.repository?
       " · "+cfg.repository.split("/").at(-1)+"@"+cfg.ciBranch+": "+ciLabel(cfg.ci):"")+
       (cfg.additionalCi?.length?" · 추가 "+cfg.additionalCi.map(x=>
         x.repository.split("/").at(-1)+": "+ciLabel(x)).join(", "):"");
   item.append(detail);
   const buttons=document.createElement("div");buttons.className="overview-actions";
   buttons.append(overviewButton("설정",async()=>{
     $("chat").value=String(t.id);
     renderedSelectionKey=null;renderedRepoKey=null;paint();
     return t.title+" 설정을 선택했습니다.";
   }));
   if(!reg&&!mismatch){
     buttons.append(overviewButton("탭 등록",async()=>{
       $("chat").value=String(t.id);renderedRepoKey=null;
       await ensureSession();
       return t.title+" 등록 완료. CI와 매크로를 선택해 시작하세요.";
     }));
   }else if(cfg&&!cfg.enabled&&cfg.reason==="OBSERVATION_UNVERIFIED"){
     buttons.append(overviewButton("다시 검증",async()=>{
       if(!confirm(t.title+"의 화면을 다시 검증하시겠습니까? 이전 메시지를 다시 보내지 않습니다."))return "";
       await api("AP_POPUP_MACRO",{action:"resumeObservation",payload:{sessionKey:reg.key}});
       return t.title+" 재검증 활성화. 새 화면 검증 후 진행합니다.";
     }));
   }else if(cfg&&cfg.status==="paused"&&cfg.reason==="USER_APPROVAL_OR_PROVIDER_BLOCKER"){
     buttons.append(overviewButton("승인 완료 반영",async()=>{
       if(!confirm(t.title+"의 실제 승인·권한 처리가 끝났습니까? 미완료라면 취소하세요."))return "";
       await api("AP_POPUP_MACRO",{action:"resumeApproved",payload:{sessionKey:reg.key,confirmed:true}});
       return t.title+" 승인 완료 반영. 새 화면 검증 후 진행합니다.";
     }));
   }
   item.append(buttons);root.append(item);
 }
 $("overview-summary").textContent="전체 "+model.tabs.length+"개 · 활성 "+active+
   "개 · 중지/설정 "+blocked+"개 · 미등록 "+missing+"개";
}
function isApprovalBlocked(cfg){
  return cfg?.status==="paused"&&cfg.reason==="USER_APPROVAL_OR_PROVIDER_BLOCKER";
}
function stateMessage(){
 const cfg=config();
 if(!model.connected)return "로컬 서버 연결이 필요합니다. 관리 화면에서 연결 상태를 확인하세요.";
 if(model.stopped)return "전체 자동화가 중지되어 있습니다.";
 if(!tab())return "열려 있는 ChatGPT 채팅이 없습니다.";
 if(registrationMismatch())return "기존 등록 주소와 실제 탭이 다릅니다. 관리 화면에서 재연결하세요.";
 if(!session())return "미등록 채팅입니다. 위 목록의 탭 등록을 누르세요.";
 if(!cfg)return "채팅 등록 완료. CI 저장소와 매크로를 선택한 뒤 시작하세요.";
 if(cfg.status==="migrating")return "채팅 이관 중입니다. 이관 결과 확인 전에는 전송하지 않습니다.";
 if(isApprovalBlocked(cfg))return "승인 완료 여부를 확인한 뒤 위 목록에서 승인 완료 반영을 선택하세요.";
 if(cfg.reason==="WAIT_ADDITIONAL_CI")return "추가 CI가 모두 성공해야 자동 진행됩니다.";
 if(cfg.enabled)return "자동화 활성 · "+statusLabel(cfg.reason);
 return "자동화 중지 · "+statusLabel(cfg.reason);
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
    $("macro").value=["general","task_unit","roadmap","ci_red"].includes(cfg?.preferredMacroKey)?
      cfg.preferredMacroKey:"general";
  }
  $("start").disabled=model.busy||!connected||model.stopped||!tab()||
    registrationMismatch()||cfg?.status==="migrating";
  $("stop").disabled=model.busy||!connected||!tab()||!cfg?.enabled;
  $("save-ci").disabled=model.busy||!connected||!session()||
    !cfg||cfg.status==="migrating"||registrationMismatch();
  $("once").disabled=model.busy||!connected||!tab()||
    registrationMismatch()||cfg?.status==="migrating"||isApprovalBlocked(cfg);
  renderOverview();
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
  renderedRepoKey=null;
  $("status").classList.remove("error");
  paint();
});
$("reload").addEventListener("click",()=>void refresh());
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
$("save-ci").addEventListener("click",()=>void perform(async()=>{
  const cfg=config(),key=session()?.key;
  if(!key||!cfg)throw Error("\ucc44\ud305 \ub4f1\ub85d\uacfc \ucd08\uae30 \ub9e4\ud06c\ub85c \uc124\uc815\uc774 \ud544\uc694\ud569\ub2c8\ub2e4.");
  const scope=selectedCi();
  await api("AP_POPUP_MACRO",{action:"saveCi",payload:{sessionKey:key,...scope}});
  return "CI \uc800\uc7a5\uc18c\uc640 \ube0c\ub79c\uce58\ub97c \uc800\uc7a5\ud588\uc2b5\ub2c8\ub2e4. \uc790\ub3d9\ud654 \uc2e4\ud589 \uc0c1\ud0dc\ub294 \uc720\uc9c0\ub429\ub2c8\ub2e4.";
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

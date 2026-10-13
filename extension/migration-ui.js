import { sessionStatus } from "./core.js";
import { classifyChatGPTRoute } from "./chat-routes.js";

let state=null;
let requestFn;
let noticeFn;
let busy=false;
let refreshTick=0;
const $=id=>document.getElementById(id);
const stages={
  request_unknown:"원본 이관 요청 결과 불명 · 자동 재전송 금지",
  awaiting_source_reply:"원본 채팅의 이관 답변을 기다리는 중",
  awaiting_manual:"원본에 이관 요청 실패 · 이관문을 직접 붙여넣을 수 있음",
  review:"이관문 준비됨 · 내용을 검토한 뒤 붙여넣기",
  transfer_unknown:"대상 전송 불명 · 자동 재전송 금지",
  transfer_blocked:"대상 전송 차단 · 입력창 및 URL 확인 필요",
  awaiting_first_reply:"새 프로젝트 채팅 첫 답변을 기다리는 중 · 완료 후 제목 변경 시도",
  rename_unknown:"제목 변경 시도 결과 불명 · 수동 확인 필요",
  manual_title_required:"제목 자동 변경 실패 · 새 채팅의 제목을 직접 변경한 뒤 확인",
  title_verified:"제목 변경 확인 · 대상 새 채팅 연결을 확정하십시오",
  completed:"이관 완료 · 등록된 새 대화로 작업을 계속할 수 있음"
};
const eligible=(data,type)=>{
  if(!data?.registry||!data?.snapshot)return [];
  return data.registry.sessions.filter(session=>{
    const group=data.registry.groups.find(x=>x.key===session.groupKey);
    const tab=data.snapshot.tabs.find(t=>t.id===session.tabId);
    if(session.paused||group?.paused||
       sessionStatus(session,data.registry,data.snapshot,data.token)!=="connected")
      return false;
    const route=classifyChatGPTRoute(tab?.url);
    return type==="source"?route==="existing":route==="project-new";
  });
};
function fillSelect(id,list,label){
  const element=$(id),selected=element.value;
  element.replaceChildren();
  const place=document.createElement("option");
  place.value="";place.textContent=list.length?label:"등록된 대상 탭이 없습니다";
  element.append(place);
  for(const session of list){
    const option=document.createElement("option");
    option.value=session.key;
    option.textContent=session.title||session.key.slice(0,12);
    element.append(option);
  }
  element.value=list.some(s=>s.key===selected)?selected:"";
}
export function refreshMigrationSessions(data){
  if(!data)return;
  fillSelect("migration-source",eligible(data,"source"),"원본 대화 선택");
  fillSelect("migration-target",eligible(data,"target"),"프로젝트 새 채팅 선택");
}
function renderState(){
  const s=state;
  $("migration-state").textContent=s?
    "단계: "+s.stage+" — "+(stages[s.stage]||"상태 확인 필요"):
    "이관 대기 중 · 원본과 대상 ChatGPT 탭을 선택하십시오.";
  $("migration-detail").textContent=s?[
    "기존 제목 "+s.trackTitle,
    "새 제목 "+s.nextTitle,
    s.reason?"상태 "+s.reason:null,
    s.sourceAtLimit?"원본에서 길이 제한 경고 확인됨":null,
    s.promptLength?"이관문 "+s.promptLength+"자":null
  ].filter(Boolean).join(" · "):"";
  if(s?.stage==="review"&&typeof s.promptPreview==="string" &&
     !$("migration-body").dataset.userEdited){
    $("migration-body").value=s.promptPreview;
  }
  const formDisabled=!!s||busy;
  for(const id of ["migration-source","migration-target","migration-title","migration-repo"])
    $(id).disabled=formDisabled;
  const permitted={
    "migration-prepare":!s,
    "migration-capture":s?.stage==="awaiting_source_reply",
    "migration-transfer":s?.stage==="review",
    "migration-check":s?.stage==="awaiting_first_reply",
    "migration-rebind":s?.stage==="title_verified",
    "migration-edit":["awaiting_manual","awaiting_source_reply","review"].includes(s?.stage),
    "migration-confirm-title":s?.stage==="manual_title_required",
    "migration-copy":!!$("migration-body").value
  };
  for(const [id,allowed] of Object.entries(permitted))
    $(id).disabled=!allowed||busy;
  $("migration-cancel").disabled=busy||!s;
}
async function run(type,more={}){
  if(busy)return;
  busy=true;renderState();
  try{
    const result=await requestFn({type,...more});
    if(result.error)noticeFn(result.error,true);
    if(Object.hasOwn(result,"migration"))state=result.migration;
    if(state?.stage==="review"&&typeof state.promptPreview==="string"){
      $("migration-body").dataset.userEdited="";
      $("migration-body").value=state.promptPreview;
    }
    if(state?.stage==="manual_title_required")
      noticeFn("자동 제목 변경에 실패했습니다. 새 채팅에서 '"+state.nextTitle+
        "'로 직접 변경한 뒤 아래 확인 버튼을 누르십시오.",true);
    else if(state?.stage==="completed")
      noticeFn("이관 완료. 새 채팅 연결이 복구됐습니다. 해당 작업축의 후속 지시를 승인하면 계속 진행할 수 있습니다.");
    renderState();
  }catch(e){noticeFn(e.message,true);renderState();}
  finally{busy=false;renderState()}
}
export function setupMigrationUI(request,notice){
  requestFn=request;noticeFn=notice;
  $("migration-body").addEventListener("input",()=>{
    $("migration-body").dataset.userEdited="yes";
    renderState();
  });
  $("migration-prepare").addEventListener("click",()=>{
    const sourceKey=$("migration-source").value,targetKey=$("migration-target").value;
    const trackTitle=$("migration-title").value.trim();
    const repository=$("migration-repo").value.trim();
    if(!sourceKey||!targetKey||!trackTitle||!repository)
      return noticeFn("원본·대상 탭, 기존 채팅 제목, 저장소를 모두 입력하십시오.",true);
    if(!confirm("원본 개발 채팅에 로드맵 기반 이관 프롬프트 작성 요청을 한 번 전송합니다. 계속하시겠습니까?"))
      return;
    void run("AP_MIGRATION_PREPARE",{sourceKey,targetKey,trackTitle,repository});
  });
  $("migration-capture").addEventListener("click",()=>void run("AP_MIGRATION_CAPTURE"));
  $("migration-edit").addEventListener("click",()=>{
    const body=$("migration-body").value.trim();
    if(body.length<80)return noticeFn("이관문은 최소 80자 이상이어야 합니다.",true);
    const type=state?.stage==="review"?"AP_MIGRATION_EDIT":"AP_MIGRATION_MANUAL";
    void run(type,{body});
  });
  $("migration-copy").addEventListener("click",async()=>{
    try{await navigator.clipboard.writeText($("migration-body").value);
      noticeFn("이관 프롬프트를 클립보드로 복사했습니다.");}
    catch(e){noticeFn("클립보드 복사 실패: "+e.message,true)}
  });
  $("migration-transfer").addEventListener("click",()=>{
    if($("migration-body").value.trim()!==state?.promptPreview)
      return noticeFn("이관문이 수정되었습니다. '검토한 내용 저장'을 먼저 누르십시오.",true);
    if(!confirm("검토한 이관문을 선택한 프로젝트 새 채팅의 첫 메시지로 단 한 번 전송합니다. 계속하시겠습니까?"))
      return;
    void run("AP_MIGRATION_TRANSFER");
  });
  $("migration-check").addEventListener("click",()=>void run("AP_MIGRATION_POLL"));
  $("migration-confirm-title").addEventListener("click",()=>{
    if(confirm("새 채팅의 제목을 '"+state?.nextTitle+"'로 실제 변경했습니까?"))
      void run("AP_MIGRATION_CONFIRM_TITLE");
  });
  $("migration-rebind").addEventListener("click",()=>void run("AP_MIGRATION_REBIND"));
  $("migration-cancel").addEventListener("click",()=>{
    if(confirm("진행 중인 이관 기록을 초기화합니까? 이미 전송한 메시지는 삭제되지 않습니다.")){
      $("migration-body").value="";void run("AP_MIGRATION_CANCEL");
    }
  });
  // Options page stays open during first response. Poll does not submit new
  // messages; it waits for the first reply, then attempts title rename once.
  setInterval(()=>{
    if(!busy&&state?.stage==="awaiting_first_reply"){
      refreshTick++;
      if(refreshTick%2===0)void run("AP_MIGRATION_POLL");
    }
  },3000);
  void run("AP_MIGRATION_STATE");
}

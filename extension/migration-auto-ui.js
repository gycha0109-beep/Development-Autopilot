import {sessionStatus} from "./core.js";
import {classifyChatGPTRoute} from "./chat-routes.js";
const $=id=>document.getElementById(id);
let request,notice,tracks=[],currentRegistry;
let titleLookupId=0;
let lastRenderedSession="";
async function showDetectedTitle(sessionKey){
  const requestId=++titleLookupId;
  const box=$("auto-migration-title-preview");
  box.textContent=sessionKey?"ChatGPT에서 실제 제목 확인 중…":"등록된 채팅을 선택하십시오.";
  if(!sessionKey)return;
  try{
    const result=await request({type:"AP_CHAT_TITLE",sessionKey});
    if(requestId!==titleLookupId)return;
    if(!result.ok)throw Error(result.reason||"CHAT_TITLE_UNAVAILABLE");
    const title=result.title;
    const number=Number(title.match(/\d+$/)?.[0]);
    box.textContent=title+" → "+title.replace(/\s+\d+$/," "+(number+1))+" (자동 인식)";
  }catch(e){
    if(requestId===titleLookupId)box.textContent="제목 인식 실패: "+e.message;
  }
}
const labels={
  pause_pending:"길이 제한 감지 · 작업축 전송 정지 중",
  request_pending:"길이 제한 감지 · 원본에 이관 프롬프트 요청 준비",
  awaiting_source_reply:"원본 대화에서 실제 작성된 이관문 답변 대기",
  fallback_pending:"이전 대체 경로 중지 · 원본 작성 이관문 필요",
  ready_to_create:"이관문 준비 · 프로젝트 새 채팅 생성",
  awaiting_target_page:"프로젝트 새 채팅 로드 대기",
  awaiting_first_reply:"새 채팅에 이관 완료 · 첫 답변 대기",
  rebind_pending:"첫 답변 확인 · 제목 변경 완료 · 작업축 연결 전환",
  resync_pending:"새 등록 주소 로컬 동기화",
  resume_pending:"기존 자동 전송 주기 복구 중",
  completed:"자동 이관 완료",
  needs_attention:"자동 이관 중지 · 확인 필요"
};
function eligible(data){
  if(!data)return [];
  return data.registry.sessions.filter(s=>{
    const group=data.registry.groups.find(g=>g.key===s.groupKey);
    const tab=data.snapshot.tabs.find(t=>t.id===s.tabId);
    return sessionStatus(s,data.registry,data.snapshot,data.token)==="connected" &&
      !s.paused&&!group?.paused &&
      classifyChatGPTRoute(tab?.url)==="existing" &&
      /^https:\/\/chatgpt\.com\/g\/g-p-[^/]+\/c\//.test(tab?.url||"");
  });
}
export function renderAutoMigrationSessions(data){
  currentRegistry=data;
  const select=$("auto-migration-session");
  const previous=select.value;
  const list=eligible(data);
  select.replaceChildren();
  const empty=document.createElement("option");
  empty.value="";empty.textContent=list.length?"자동 감시할 대화 선택":
    "등록된 프로젝트 대화 없음";
  select.append(empty);
  for(const session of list){
    const option=document.createElement("option");
    option.value=session.key;
    option.textContent=session.title||"대화 "+session.key.slice(0,8);
    select.append(option);
  }
  select.value=list.some(s=>s.key===previous)?previous:"";
  if(select.value && select.value!==lastRenderedSession){
    lastRenderedSession=select.value;
    void showDetectedTitle(select.value);
  }
}
function render(){
  const root=$("auto-migration-status");
  root.replaceChildren();
  if(!tracks.length){
    root.textContent="자동 감시 대상 없음 · 원본 프로젝트 개발 채팅을 등록하고 자동 감시를 켜십시오.";
    return;
  }
  for(const track of tracks){
    const wrapper=document.createElement("p");
    const state=track.progress;
    const stage=state ? labels[state.stage]||state.stage :
      track.enabled?"경고 감시 중":"감시 중지";
    wrapper.textContent=(track.enabled?"● ":"○ ")+track.trackTitle+
      " · "+track.repository+" · "+stage+
      (state?.reason?" · "+state.reason:"");
    root.append(wrapper);
  }
}
async function load(){
  try{
    const reply=await request({type:"AP_AUTO_MIGRATION_STATE"});
    tracks=reply.tracks||[];
    render();
  }catch(error){
    $("auto-migration-status").textContent="자동 감시 상태를 불러오지 못함: "+error.message;
  }
}
export function setupAutoMigrationUI(req,inform){
  request=req;notice=inform;
  $("auto-migration-session").addEventListener("change",()=>{
    const selected=$("auto-migration-session").value;
    const existing=tracks.find(t=>t.sessionKey===selected);
    $("auto-migration-repo").value=existing?.repository||"";
    lastRenderedSession=selected;
    void showDetectedTitle(selected);
  });
  $("auto-migration-enable").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const repository=$("auto-migration-repo").value.trim();
    if(!sessionKey||!repository)
      return notice("프로젝트 채팅과 GitHub 저장소를 지정하십시오. 채팅 제목은 자동으로 인식합니다.",true);
    if(!confirm("이 개발 채팅을 자동 감시하겠습니다. 최대 길이 경고가 발견되면 추가 버튼 없이 로드맵 기반 이관문 요청, 새 프로젝트 채팅 전송, 제목 변경 및 원래 주기 복구를 진행합니다. 기존 승인된 주기 메시지는 이관 중 중지됩니다. 계속하시겠습니까?"))
      return;
    try{
      const r=await request({type:"AP_AUTO_MIGRATION_CONFIG",
        sessionKey,repository,enabled:true});
      tracks=r.tracks||[];render();
      notice("길이 제한 자동 감시를 켰습니다. 경고가 뜨면 같은 프로젝트로 자동 이관합니다.");
    }catch(e){notice(e.message,true)}
  });
  $("auto-migration-disable").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    if(!sessionKey)return notice("중지할 등록 대화를 선택하십시오.",true);
    try{
      const r=await request({type:"AP_AUTO_MIGRATION_CONFIG",sessionKey,enabled:false});
      tracks=r.tracks||[];render();notice("자동 감시를 중지했습니다.");
    }catch(e){notice(e.message,true)}
  });
  $("auto-migration-test").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const track=tracks.find(x=>x.sessionKey===sessionKey);
    if(!track?.enabled)return notice("먼저 테스트용 프로젝트 개발 채팅에 자동 감시를 켜십시오.",true);
    if(!confirm("테스트 경고를 1회 강제 발생시킵니다. 실제 길이 제한은 만들지 않지만, 원본 채팅에 이관문 작성 요청을 보내고 같은 프로젝트에 새 채팅을 생성·전송하며 제목 변경까지 실제 수행합니다. 테스트 전용 프로젝트에서 진행 중입니까?"))return;
    try{
      const result=await request({type:"AP_AUTO_MIGRATION_TEST",sessionKey});
      if(!result.accepted)throw new Error("테스트 실행이 승인되지 않았습니다.");
      notice("가상 경고 1회를 설정했습니다. 확장 동기화 시 실제 자동 이관 절차가 시작됩니다.");
      const synced=await request({type:"AP_BRIDGE_SYNC"});
      if(!synced.connected)throw new Error(synced.message||"확장 동기화 실패");
      await load();
    }catch(e){notice(e.message,true)}
  });
  $("auto-migration-recover").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const target=tracks.find(t=>t.sessionKey===sessionKey);
    if(!target)return notice("먼저 원본 채팅을 선택하십시오.",true);
    const stage=target.progress?.stage;
    if(!["awaiting_source_reply","needs_attention"].includes(stage))
      return notice("이관문 답변 대기 또는 해당 답변 확인 실패 상태에서만 복구할 수 있습니다.",true);
    if(!confirm("원본 채팅에서 작성된 마지막 AI 답변을 확인합니다. AUTOPILOT_MIGRATION_HANDOFF로 시작하는 이관문이 있으면 새 프로젝트 채팅에 그대로 전송하는 단계를 진행합니다. 원본에 이관 요청을 다시 보내지 않습니다. 계속하시겠습니까?"))return;
    try{
      const result=await request({type:"AP_AUTO_MIGRATION_RECOVER_SOURCE",
        sessionKey,confirm:true});
      if(!result.recovered)
        return notice("원본 이관문 확인 실패: "+result.reason+
          " · 원본 답변의 첫 줄과 실제 완료 상태를 확인하십시오.",true);
      const synced=await request({type:"AP_BRIDGE_SYNC"});
      if(!synced.connected)throw Error(synced.message||"로컬 동기화 실패");
      await load();
      notice("원본 이관문을 확인했습니다. 중복 요청 없이 새 프로젝트 채팅 생성 단계로 진행합니다.");
    }catch(e){notice("이관문 복구 실패: "+e.message,true)}
  });
  $("auto-migration-reset").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const target=tracks.find(t=>t.sessionKey===sessionKey);
    if(!target || target.progress?.stage!=="needs_attention")
      return notice("확인 필요 상태인 작업축만 초기화할 수 있습니다.",true);
    if(!confirm("이관 실패 기록을 초기화합니다. 기존 대화 입력창에 남아 있는 전송되지 않은 문구는 직접 확인하고 지운 다음 재시도해야 합니다. 초기화 후 해당 대화의 길이 제한 경고가 여전히 보이면 다음 동기화에서 이관문 작성 지시를 다시 시도합니다. 계속하시겠습니까?"))return;
    try{
      const result=await request({type:"AP_AUTO_MIGRATION_RESET_FAILED",
        sessionKey,confirm:true});
      tracks=result.tracks||[];render();
      notice("이관 실패 기록을 초기화했습니다. 원본 채팅 초안을 확인한 후 동기화하십시오.");
    }catch(e){notice(e.message,true)}
  });
  $("auto-migration-inspect").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    if(!sessionKey)return notice("먼저 등록된 Face Lab 채팅을 선택하십시오.",true);
    const display=$("auto-migration-inspection");
    display.textContent="선택한 원본 채팅의 실제 길이 제한 경고 검사 중…";
    try{
      const result=await request({type:"AP_AUTO_MIGRATION_INSPECT",sessionKey});
      display.textContent=(result.warning?
        "길이 제한 경고 감지됨":"길이 제한 경고 미감지")+
        " · "+(result.reason||"NO_REASON")+
        " · 등록 채팅: "+result.sourceTitle+
        (result.progress?" · 이관 단계: "+result.progress.stage:" · 이관 미시작");
      const synced=await request({type:"AP_BRIDGE_SYNC"});
      if(!synced.connected)throw Error(synced.message||"로컬 동기화 실패");
      await load();
      notice(result.warning?"경고 감지 및 동기화 완료. 이관 진행 상태를 확인하십시오.":
        "현재 페이지에서 경고가 인식되지 않았습니다. 실제 경고가 보이면 직접 시작 버튼을 사용하십시오.");
    }catch(e){display.textContent="검사 실패: "+e.message;notice(e.message,true)}
  });
  $("auto-migration-start").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const track=tracks.find(t=>t.sessionKey===sessionKey);
    if(!track?.enabled)return notice("먼저 등록한 원본 채팅에 자동 감시를 켜십시오.",true);
    if(!confirm("선택한 등록 원본 채팅 '"+track.trackTitle+"'에 실제 이관문 작성 지시를 1회 전송합니다. 현재 경고가 자동 감지되지 않아도 진행하며, 원본에서 작성한 이관 답변을 받기 전에는 새 프로젝트 채팅을 만들지 않습니다. 기존 입력창에 미전송 문구가 없는지 확인하셨습니까?"))return;
    try{
      const result=await request({type:"AP_AUTO_MIGRATION_START",sessionKey,confirm:true});
      if(!result.accepted)throw Error("AUTO_MIGRATION_START_NOT_ACCEPTED");
      const synced=await request({type:"AP_BRIDGE_SYNC"});
      if(!synced.connected)throw Error(synced.message||"로컬 동기화 실패");
      await load();
      notice("원본 채팅의 이관문 작성 요청을 시작했습니다. 다음 동기화에서 실제 전송을 시도합니다.");
    }catch(e){notice("직접 이관 시작 실패: "+e.message,true)}
  });
  $("auto-migration-refresh").addEventListener("click",()=>void load());
  setInterval(()=>void load(),20000);
  void load();
}

import {sessionStatus} from "./core.js";
import {classifyChatGPTRoute} from "./chat-routes.js";
const $=id=>document.getElementById(id);
let request,notice,tracks=[],currentRegistry;
const labels={
  pause_pending:"길이 제한 감지 · 작업축 전송 정지 중",
  request_pending:"길이 제한 감지 · 원본에 이관 프롬프트 요청 준비",
  awaiting_source_reply:"원본 이관문 답변 대기",
  fallback_pending:"원본 길이 제한으로 마지막 답변 기반 자동 대체",
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
    const session=currentRegistry?.registry.sessions.find(s=>s.key===selected);
    $("auto-migration-title").value=existing?.trackTitle||session?.title||"";
    $("auto-migration-repo").value=existing?.repository||"";
  });
  $("auto-migration-enable").addEventListener("click",async()=>{
    const sessionKey=$("auto-migration-session").value;
    const trackTitle=$("auto-migration-title").value.trim();
    const repository=$("auto-migration-repo").value.trim();
    if(!sessionKey||!trackTitle||!repository)
      return notice("등록한 프로젝트 채팅, 기존 제목, GitHub 저장소를 입력하십시오.",true);
    if(!confirm("이 개발 채팅을 자동 감시하겠습니다. 최대 길이 경고가 발견되면 추가 버튼 없이 로드맵 기반 이관문 요청, 새 프로젝트 채팅 전송, 제목 변경 및 원래 주기 복구를 진행합니다. 기존 승인된 주기 메시지는 이관 중 중지됩니다. 계속하시겠습니까?"))
      return;
    try{
      const r=await request({type:"AP_AUTO_MIGRATION_CONFIG",
        sessionKey,trackTitle,repository,enabled:true});
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
  $("auto-migration-refresh").addEventListener("click",()=>void load());
  setInterval(()=>void load(),20000);
  void load();
}

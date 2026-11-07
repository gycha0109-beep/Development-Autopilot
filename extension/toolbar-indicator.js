// Browser-toolbar state is derived from read-only, already-authorized macro
// status. It must never schedule, claim, send, or approve a chat command.
export const TOOLBAR_STATES=Object.freeze({
  running:{color:"#84CC16",letterColor:"#182600",label:"실행 중"},
  waiting:{color:"#FACC15",letterColor:"#352700",label:"대기 중"},
  blocked:{color:"#EF4444",letterColor:"#FFFFFF",label:"오류·승인 필요·중지"}
});

const BUSY_STATUSES=new Set(["running","sending","awaiting_reply","awaiting_response"]);
const BUSY_REASONS=new Set(["WAIT_POST_SEND_REPLY","SOURCE_MIGRATION_REQUEST_SUBMITTED_WAIT_FOR_REPLY"]);
const BLOCKED_STATUSES=new Set(["paused","blocked","needs_attention","failed","error"]);
const BLOCKED_REASONS=new Set([
  "USER_APPROVAL_OR_PROVIDER_BLOCKER","OBSERVATION_UNVERIFIED",
  "CHAT_IDENTITY_CHANGED_REAPPROVAL","CI_BRANCH_REMOVED_NEEDS_NEW_TARGET",
  "CI_STATUS_UNAVAILABLE","RECOVERY_RETRIES_EXHAUSTED",
  "AUTO_MIGRATION_NEEDS_ATTENTION","GENERIC_MIGRATION_NEEDS_ATTENTION",
  "OPERATOR_STOPPED"
]);

export function classifyToolbarState(status){
  const counts={running:0,waiting:0,blocked:0};
  if(status?.connected!==true)
    return {state:"blocked",counts,reason:"로컬 서버 연결 확인 필요"};
  if(status.globalStopped===true)
    return {state:"blocked",counts,reason:"전체 자동 실행 중지"};
  const registrations=Array.isArray(status.registry?.sessions)?
    status.registry.sessions:[];
  const groups=new Map((status.registry?.groups||[]).map(g=>[g.key,g]));
  const tabs=new Map((status.tabs||[]).map(t=>[t.id,t]));
  const macros=new Map((status.sessions||[]).map(m=>[m.sessionKey,m]));
  for(const registration of registrations){
    const group=registration.groupKey?groups.get(registration.groupKey):null;
    const tab=tabs.get(registration.tabId);
    const config=macros.get(registration.key);
    if(registration.paused||registration.groupKey&&(!group||group.paused)||
       !tab||tab.url!==registration.url||
       config&&(!config.enabled||BLOCKED_STATUSES.has(config.status)||
         BLOCKED_REASONS.has(config.reason)||
         config.ci?.ciState==="FAILURE")){
      counts.blocked++;
    }else if(config&&(BUSY_STATUSES.has(config.status)||
      BUSY_REASONS.has(config.reason))){
      counts.running++;
    }else{
      // Armed, next interval, CI running, migration and initial setup
      // are waiting, not proof that a message is currently being sent.
      counts.waiting++;
    }
  }
  const state=counts.blocked?"blocked":counts.running?"running":"waiting";
  const reason=registrations.length?
    `실행 ${counts.running} · 대기 ${counts.waiting} · 중지/오류 ${counts.blocked}`:
    "등록된 채팅 없음";
  return {state,counts,reason};
}

export function drawToolbarIcon(state,size,CanvasCtor){
  if(!Number.isSafeInteger(size)||size<16||!CanvasCtor)
    throw Error("TOOLBAR_ICON_CANVAS_UNAVAILABLE");
  const canvas=new CanvasCtor(size,size);
  const context=canvas.getContext("2d");
  if(!context)throw Error("TOOLBAR_ICON_CONTEXT_UNAVAILABLE");
  const theme=TOOLBAR_STATES[state];
  context.clearRect(0,0,size,size);
  context.fillStyle=theme.color;
  context.beginPath();
  context.roundRect(0,0,size,size,Math.max(3,size*0.17));
  context.fill();
  context.fillStyle=theme.letterColor;
  context.font=`700 ${Math.round(size*0.69)}px Arial, sans-serif`;
  context.textAlign="center";
  context.textBaseline="middle";
  context.fillText("D",size/2,size*0.54);
  return context.getImageData(0,0,size,size);
}

export async function updateToolbarIndicator(chromeApi,status,{
  CanvasCtor=typeof OffscreenCanvas==="function"?OffscreenCanvas:null
}={}){
  const result=classifyToolbarState(status);
  const meta=TOOLBAR_STATES[result.state];
  const action=chromeApi.action;
  if(!action)return result;
  let painted=false;
  if(CanvasCtor&&typeof action.setIcon==="function"){
    try{
      await action.setIcon({imageData:{
        16:drawToolbarIcon(result.state,16,CanvasCtor),
        32:drawToolbarIcon(result.state,32,CanvasCtor)
      }});
      painted=true;
    }catch{
      // Older/unsupported renderers retain an accessible colored badge.
    }
  }
  if(painted){
    await action.setBadgeText({text:""});
  }else{
    await action.setBadgeBackgroundColor({color:meta.color});
    await action.setBadgeText({text:"●"});
  }
  await action.setTitle({
    title:`Development Autopilot · ${meta.label} · ${result.reason}`
  });
  return result;
}

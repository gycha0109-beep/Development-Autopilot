// Migration orchestration is explicitly operator-triggered and scoped to two
// registered ChatGPT tabs. Never infer repositories or silently move projects.
export const MIGRATION_SESSION_KEY = "autopilot.migration.v1";
export const MAX_HANDOFF_CHARS = 30000;
export const MIGRATION_MARKER = "AUTOPILOT_MIGRATION_HANDOFF";

export function incrementTrackTitle(title) {
  if(typeof title!=="string" || title.length>160)throw Error("INVALID_TRACK_TITLE");
  const match=title.trim().match(/^(.*\S)\s+([0-9]{1,3})$/u);
  if(!match || !match[1].trim() || Number(match[2])>=999)
    throw Error("TRACK_TITLE_NUMBER_REQUIRED");
  return match[1]+" "+(Number(match[2])+1);
}

export function migrationPrompt({repository,trackTitle}={}) {
  if(typeof repository!=="string" ||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("MIGRATION_REPOSITORY_REQUIRED");
  const next=incrementTrackTitle(trackTitle);
  return [
    "현재 개발 채팅의 길이 제한으로 다음 채팅에 이관해야 합니다.",
    "GitHub 저장소 "+repository+" 의 로드맵(예: docs/ROADMAP.md)과 현행 코드, PR, CI 근거를 확인하십시오.",
    "로드맵이 없거나 현재 작업을 충분히 설명하지 못한다면 우선 로드맵을 작성·보완해야 한다고 명시하십시오.",
    "지금 작업하던 트랙 '"+trackTitle+"'을 다음 채팅 '"+next+"'에서 끊김 없이 이어갈 수 있도록",
    "새 프로젝트 채팅의 첫 메시지로 그대로 붙여넣을 완성된 **이관 프롬프트**를 작성하십시오.",
    "필수 포함: 저장소 및 정확한 브랜치/PR/커밋, 작업 목적, 확정된 결정, 완료·검증된 사항,",
    "실패·미완료 이슈, 로드맵 위치, 다음 실행 명령과 검증 방법, 외부 도구 필요 조건, 중단 규칙.",
    "추측은 사실로 쓰지 말고 미확인으로 표시하십시오. 위험한 자동 병합은 금지합니다.",
    "응답은 '"+MIGRATION_MARKER+"' 한 줄로 시작하고, 그 아래는 복사할 이관 프롬프트 본문만 출력하십시오.",
    "이관 첫 답변은 요약에 머무르지 않고 로드맵의 다음 미완료 작업을 즉시 실행하도록 지시하십시오.",
    "새 채팅에서 이전 대화를 읽을 수 없다는 전제에서 독립 실행 가능하도록 작성하십시오."
  ].join("\n");
}


export function projectIdFromUrl(value){
  let parsed;
  try{parsed=new URL(value);}catch{return null;}
  if(parsed.origin!=="https://chatgpt.com")return null;
  const m=parsed.pathname.match(/^\/g\/(g-p-[^/]+)(?:\/(?:project|c\/[^/]+))?\/?$/);
  return m?.[1]||null;
}

export function targetIsNewProject(url) {
  try{
    const p=new URL(url);
    return p.origin==="https://chatgpt.com" &&
      /^\/g\/g-p-[^/]+(?:\/project)?\/?$/.test(p.pathname);
  }catch{return false}
}

export function migratedIntoSameProject(before,after) {
  const id=projectIdFromUrl(before);
  if(!id || projectIdFromUrl(after)!==id)return false;
  try {return /^\/g\/g-p-[^/]+\/c\/[^/]+\/?$/.test(new URL(after).pathname);}
  catch{return false}
}


export function fallbackRoadmapHandoff({repository,trackTitle,lastAssistant}={}) {
  const next=incrementTrackTitle(trackTitle);
  if(typeof repository!=="string" ||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("MIGRATION_REPOSITORY_REQUIRED");
  if(typeof lastAssistant!=="string"||!lastAssistant.trim())
    throw Error("MIGRATION_FALLBACK_CONTEXT_REQUIRED");
  const result=[
    "## 개발 채팅 이관 (길이 제한 이후 로드맵 재구성)",
    "",
    "대상 저장소: "+repository,
    "이전 채팅 제목: "+trackTitle,
    "새 채팅 제목 예정: "+next,
    "",
    "기존 ChatGPT 대화의 최대 길이에 도달했기 때문에 이전 대화에 새 이관 요약을 작성해 달라고 요청할 수 없었습니다.",
    "아래는 마지막 assistant 응답에서만 자동 가져온 참고 자료입니다. 전체 대화 요약이 아니며, 사실 검증이 필요합니다.",
    "",
    "### 이전 대화의 마지막 assistant 응답 (미검증 참고)",
    lastAssistant.trim().slice(0,6000),
    "",
    "### 새 채팅의 필수 작업",
    "1. 저장소 "+repository+" 의 현행 로드맵(예: docs/ROADMAP.md), 관련 작업 문서와 실제 코드·PR·CI를 확인하십시오.",
    "2. 로드맵이 없으면 우선 해당 트랙의 로드맵을 작성하십시오. 문서와 현재 구현이 다르면 근거로 차이를 설명하고 보완하십시오.",
    "3. 이전 채팅의 마지막 답변은 참고로만 취급하며 검증되지 않은 작업을 완료로 단정하지 마십시오.",
    "4. 현재 트랙의 브랜치·PR·CI 상태와 최신 커밋을 확인한 뒤, 미완료 문제를 파악하십시오.",
    "5. 로드맵의 다음 작업을 진행하십시오. 외부 권한·실행이 필요하면 사용자에게 요청하십시오.",
    "6. 새 채팅 이름은 '"+next+"'이지만 모델이 실제 UI 제목을 바꾼 것으로 간주하지 마십시오.",
    "7. 검증 결과와 남은 위험을 간결하게 보고하고, 이후 확인하고 계속 진행 지시를 처리하십시오."
  ].join("\n");
  if(result.length>MAX_HANDOFF_CHARS)throw Error("MIGRATION_PROMPT_TOO_LONG");
  return result;
}

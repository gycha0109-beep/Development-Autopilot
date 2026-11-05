// Migration orchestration is explicitly operator-triggered and scoped to two
// registered ChatGPT tabs. Never infer repositories or silently move projects.
export const MIGRATION_SESSION_KEY = "autopilot.migration.v1";
export const MAX_HANDOFF_CHARS = 30000;
export const MIGRATION_MARKER = "AUTOPILOT_MIGRATION_HANDOFF";

export function incrementTrackTitle(title) {
  if(typeof title!=="string" || title.length>160)throw Error("INVALID_TRACK_TITLE");
  const source=title.trim().replace(/\s+/gu," ");
  if(source.length<3||/^(?:ChatGPT|New chat|새 채팅)$/iu.test(source))
    throw Error("INVALID_TRACK_TITLE");
  const match=source.match(/^(.*\S)\s+([0-9]{1,3})$/u);
  // An unnumbered original conversation is generation 1; its successor is 2.
  // Keep invalid/out-of-range numeric suffixes fail-closed, not as new names.
  if(!match&&/(?:\s[-+]?\d+|\s\d{4,})$/u.test(source))
    throw Error("TRACK_TITLE_NUMBER_INVALID");
  if(match&&(!match[1].trim()||Number(match[2])>=999))
    throw Error("TRACK_TITLE_NUMBER_INVALID");
  const next=match?match[1]+" "+(Number(match[2])+1):source+" 2";
  if(next.length>160)throw Error("INVALID_TRACK_TITLE");
  return next;
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

/**
 * A hard-capped source chat cannot author a new handoff. Build a narrowly
 * attributed first-message recovery instruction from ONE independently
 * verified assistant answer; never represent it as a complete transcript.
 */
export function lateLimitMigrationPrompt({repository,trackTitle,sourceBody}={}){
  if(typeof repository!=="string"||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("MIGRATION_REPOSITORY_REQUIRED");
  const next=incrementTrackTitle(trackTitle);
  if(typeof sourceBody!=="string"||sourceBody.length<80||sourceBody.length>18000)
    throw Error("LATE_MIGRATION_SOURCE_EVIDENCE_REQUIRED");
  return [
    MIGRATION_MARKER,
    "자동 이관: 기존 대화가 최대 길이에 도달하여 원본 채팅에서 새 이관문을 작성할 수 없었습니다.",
    "이 프롬프트는 원본 대화의 마지막으로 검증된 assistant 답변 한 개만 근거로 작성한 제한적 복구 문서입니다.",
    "원본 대화 전체나 이전 결정사항을 모두 검증했다고 가정하지 마십시오.",
    "원본 개발 트랙: "+trackTitle,
    "새 개발 트랙: "+next,
    "대상 GitHub 저장소: "+repository,
    "현행 로드맵(docs/ROADMAP.md) 및 실제 파일, PR, CI, 브랜치와 최신 커밋을 먼저 조회해 사실을 검증하십시오.",
    "로드맵이 없거나 부족하면 현재 작업 목적과 미완료 상태를 재구성하고 로드맵 보완을 우선하십시오.",
    "원본 마지막 assistant 답변의 확인 가능한 내용만 아래에 첨부합니다. 모두 재검증 대상이며 현재 시점의 사실로 단정하지 마십시오.",
    "--- 원본 마지막 assistant 답변 시작 ---",
    sourceBody,
    "--- 원본 마지막 assistant 답변 끝 ---",
    "현재 실행 가능한 다음 미완료 작업을 식별하고 검증된 로드맵에 따라 즉시 진행하십시오.",
    "확인 불가한 작업은 추정하지 말고 미확인으로 명시하십시오.",
    "위험한 병합·배포·삭제 또는 자격 증명 노출은 금지하고 승인 필요 사항은 명시하십시오.",
    "이전 대화 전체에 접근할 수 없으므로 근거가 부족할 때는 작업을 지어내지 마십시오."
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

// Explicit operator-approved fallback when a hard-capped source has no readable
// assistant reply. This is NOT a full conversation transfer.
export function repositoryOnlyMigrationPrompt({repository,trackTitle}={}){
  if(typeof repository!=="string"||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("MIGRATION_REPOSITORY_REQUIRED");
  const next=incrementTrackTitle(trackTitle);
  return [
    MIGRATION_MARKER,
    "이 문서는 원본 대화를 복사한 이관문이 아닙니다.",
    "원본 채팅이 길이 제한에 도달했으며 마지막 답변의 출처를 검증하지 못했습니다.",
    "기존 채팅의 의사결정, 완료 상태, 승인 내용은 확인되지 않았습니다.",
    "원본 개발 트랙: "+trackTitle,
    "신규 개발 트랙: "+next,
    "GitHub 저장소: "+repository,
    "이 대화는 사용자가 승인한 저장소 기반 복구로 시작합니다.",
    "저장소의 docs/ROADMAP.md, 실제 브랜치, 열려 있는 PR, 최신 커밋 및 CI 결과를 직접 확인하십시오.",
    "확인 가능한 근거만으로 완료된 작업과 남은 과제를 재구성하십시오.",
    "확인되지 않은 작업이나 과거 채팅의 내용은 사실로 가정하지 마십시오.",
    "새로운 구현이나 위험한 배포 이전에는 현재 진행 중인 작업 및 승인 사항을 먼저 점검하십시오.",
    "확인한 사항, 미확인 사항, 바로 진행 가능한 다음 작업을 간결하게 보고하십시오."
  ].join("\n");
}

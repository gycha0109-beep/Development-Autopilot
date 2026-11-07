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

// Repository documents, not remembered chat claims, are the recovery authority.
// Track-specific filenames vary; never assume docs/ROADMAP.md exists.
export function worklogRoadmapInstructions(){
  return [
    "GitHub 저장소의 현재 브랜치/HEAD, 해당 트랙 최신 WORKLOG(워크로그) 및 ROADMAP(로드맵)을 직접 검색하고 읽으세요.",
    "docs/operations, docs, 각 트랙 디렉터리를 모두 탐색하세요. 파일명을 고정하지 말고 실제 경로·최근 변경 시각·관련 트랙을 대조하세요.",
    "워크로그에서 최신 작업 단위, 완료/미완료/진행 중, 변경 파일·커밋·PR·테스트·CI·블로커·다음 행동을 확인하세요.",
    "로드맵의 미완료 항목과 코드/CI를 교차 검증하세요. 충돌하면 코드·검증 결과를 우선하고 문서 불일치를 명시하세요.",
    "문서가 없거나 부실하면 만들어진 것으로 가정하지 말고 결손을 표시하세요. 현재 위치를 확인하기 전 새 작업을 임의로 시작하지 마세요.",
    "이후 매 작업 단위 종료 시 해당 트랙 WORKLOG를 최신화하고 근거 있는 변경만 커밋하세요. 승인 필요한 배포·결제·파괴적 작업은 멈추세요."
  ];
}

export function migrationPrompt({repository,trackTitle}={}) {
  if(typeof repository!=="string" ||
     !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw Error("MIGRATION_REPOSITORY_REQUIRED");
  const next=incrementTrackTitle(trackTitle);
  return [
    "이 채팅의 길이 한계에 대비해 다음 채팅으로 작업을 이관합니다.",
    "저장소: "+repository+" / 현재 트랙: "+trackTitle+" / 다음 트랙: "+next,
    "가능하면 기존 결정·현재 작업·완료 검증·미완료 사항·차단 요인을 이관용 문서로 작성하세요.",
    "단, 워크로그와 로드맵이 최우선 근거입니다. 실제 최신 파일 경로·브랜치·커밋·PR·CI를 확인하도록 다음 채팅에 지시하세요.",
    "워크로그에 없는 과거 결정을 지어내지 말고 불확실하다고 표시하세요.",
    "응답 첫 줄에 "+MIGRATION_MARKER+"를 쓰고, 새 채팅에서 복사해 바로 실행할 수 있는 이관 프롬프트를 출력하세요.",
    "이관 프롬프트는 저장소의 트랙별 WORKLOG 및 ROADMAP 검색·읽기, 구현 현 지점 대조, 다음 미완료 작업 진행, 작업마다 WORKLOG 갱신을 요구해야 합니다.",
    "승인 없는 병합·배포·파괴적 작업은 금지합니다."
  ].join("\n");
}

/**
 * Tier 2: ONE independently verified completed assistant response is context,
 * never an authoritative full transcript. Always recover actual repository
 * worklog and roadmap first.
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
    "복구 방식: 2단계 — 마지막 검증된 assistant 응답 1개 + GitHub 워크로그·로드맵.",
    "원본 대화 전체를 읽었다고 가정하지 마세요. 마지막 응답은 참고 자료이며 저장소 근거가 우선입니다.",
    "원본 트랙: "+trackTitle,
    "새 트랙: "+next,
    "GitHub 저장소: "+repository,
    ...worklogRoadmapInstructions(),
    "--- 원본 채팅의 마지막 검증된 assistant 응답 시작 (참고 자료) ---",
    sourceBody,
    "--- 마지막 응답 끝 ---",
    "먼저 최신 워크로그·로드맵·코드·CI로 구현 현 지점을 확정한 뒤, 확인된 다음 미완료 작업을 계속하세요.",
    "작업이 완료되면 WORKLOG를 다시 갱신하세요. 미확인 사실을 완료로 쓰지 마세요."
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
    "복구 방식: 3단계 — 원본 대화·마지막 응답을 읽지 못해 GitHub WORKLOG와 ROADMAP만으로 복구합니다.",
    "원본 채팅의 이전 결정, 최종 완료 상태, 맥락을 알고 있다고 주장하지 마세요.",
    "원본 트랙: "+trackTitle,
    "새 트랙: "+next,
    "GitHub 저장소: "+repository,
    ...worklogRoadmapInstructions(),
    "해당 트랙의 최신 워크로그와 로드맵, 구현 파일, PR, CI 결과로 현재 작업 위치를 먼저 확인하세요.",
    "워크로그나 로드맵이 없거나 서로 모순된다면 문서 결손/차이를 보고하고 검증된 사실만 사용하세요.",
    "그 뒤 확인된 다음 미완료 작업을 이어가고, 매 단위작업 완료 후 WORKLOG에 근거·다음 행동을 남기세요.",
    "승인 없이 배포, 병합, 결제, 데이터 삭제, 권한 확대는 실행하지 마세요."
  ].join("\n");
}

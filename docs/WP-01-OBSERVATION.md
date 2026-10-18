# WP-01 — 읽기 전용 관찰 계약과 합성 검증

2026-10-18 KST. 부모 PR #49 `fix/wp00-composer-bridge-compatibility`,
HEAD `e6255f756708455b7e62e19029ee204aac9f2497`; 그 부모는 #48의 상세 로드맵이다.
작업 브랜치 `codex/wp01-readonly-observer`. 기존 미병합 스택을 보존한다.

## 구현 범위

`extension/chat-observer.js`의 `captureChatObservation(request)`는 Chrome 주입 시 직렬화 가능한
자체 완결 함수다. `local/chat-observation.js`는 등록 탭 확인 어댑터와 순수
`classifyObservation()`를 제공한다. 운영 worker/알람/스케줄러/전송/복구/이관과 연결하지 않는다.
새 권한, 외부 호출, 저장 스키마, 등록 변경, 실제 계정 행동은 추가하지 않는다.

`observeRegisteredChat()`는 명시적인 permitted=true와 등록값을 요구한다. 작업축·세션·물리 탭·창·그룹·정확한 URL로
격리 지문을 만들고, 읽기 전후 live tab을 검사한다. 동일 URL의 다른 탭도 거부한다.
실제 `readPage` 구현은 제공하지 않으며 향후 worker가 권한과 enrollment를 검증한 뒤 연결해야 한다.
호출자 boolean은 제공자 권한을 새로 부여하거나 입증하지 않는다.

반환 스키마 v1: source/sourceVersion, verified, observedAt, reasonCode,
bindingFingerprint, replyFingerprint, assistantBusy, composerHasDraft,
stopControlVerified, connectionWarning, lengthWarning, providerRestriction,
otherWarning, uiAmbiguous, contentComplete, ciWaitCue, humanActionCue, scopeCompleteCue.
원문/HTML/전체 URL/오류 메시지는 IPC 결과의 whitelist에 포함되지 않는다.

## 관측의 의미와 경계

| 관측 | 분류 / 의미 |
|---|---|
| 유일한 composer 소속의 명시적 stop control 또는 assistant busy | GENERATING; 후속 실행 권한 없음 |
| 같은 등록 지문과 답변 지문의 두 신선한 정상 표본 | RESPONSE_COMPLETE; assistant 응답 안정화만 의미 |
| 경고 영역의 연결 해제 문구 | DISCONNECTED; 지속 확인/중지 허용/복구 완료를 뜻하지 않음 |
| 경고 영역의 대화 길이 제한 | LENGTH_LIMIT; 기존 이관 실행기를 호출하지 않음 |
| 마지막 assistant의 인용/코드 밖 CI 대기 단서 | CI_WAIT_CUE; 정확한 Watchtower/GitHub 조회 필요 |
| 비용/승인/로컬 테스트/로그인 단서, 제공자 제한 경고 | WAIT_HUMAN; 모델 문장은 승인 권한이 없음 |
| 초안, 숨겨진/접힌/편집 중 본문, role-less DOM, 불명 control, 충돌/실패 | UNKNOWN; 추정 완료나 재시도 없음 |

안정화 정책은 호출자가 `now`, 양수 `stableForMs`, 그 이상인 `maxAgeMs`로 명시한다.
표본 하나·동일 시각 재사용·오래된 표본·미래 표본·다른 세션·이전 busy/초안은 안정화 근거가 아니다.
분류기는 순수 함수이며 `nextAction`, 실행 허가, CI 성공, 제품 목표 완료를 산출하지 않는다.
`scopeCompleteCue` 역시 후속 엔진에서 외부 근거로 검증할 단서다.

편집 영역은 값·textContent·innerText·HTML을 읽지 않고 텍스트 노드 길이/존재만 검사한다.
textarea의 빈 상태를 구조적으로 확인하지 못하면 null이다. 복수 editable은 UNKNOWN이다.
명시적인 마지막 assistant turn과 ID가 없으면 정상 완료를 증명하지 않는다.
최대 2,000개 노드/32,000자 이내의 보이는 마지막 답변만 인메모리에서 해시/최소 단서로 줄인다.
assistant/user 영역에 인용된 경고는 경고 UI 증거가 아니다. 코드/인용문은 의미 단서에서 제외한다.
공급자가 노출하지 않는 role-less/가상화/접힌 본문을 추측해 복원하지 않는다.

이 DOM 계약은 **합성 fixture에서만 검증한 보수적인 최초 어댑터**다.
임의 언어·서술의 모든 비용/승인/CI 요청을 탐지한다고 주장하지 않는다.
명시적 selector/문구가 없는 provider DOM, 이미지/파일/복잡한 Writing Block 등은 지원 검증이 필요하다.
일반 문장이 경고 내용을 설명하거나 승인/CI를 언급할 경우 보수적으로 대기하는 오탐도 가능하다.
실사용 연결 전에 provider 권한·실제 DOM·누락 신호를 WP-08에서 별도 확인해야 한다.

## 검증과 상태

- WP-00 재검증: 로컬 Windows Node v24.14.0, 기존 284/284 PASS. PR #49 정확한 HEAD의 Windows/Ubuntu CI SUCCESS.
- WP-01 직접 회귀: `node --test tests/chat-observer.test.js`, 최종 전체 check에 포함된 28/28 PASS.
- 최초 직접 검사에서 큰 단일 텍스트 노드의 경계 검사 누락 1건을 재현했고, 원문을 읽기 전에 길이를 검사하도록 수정 후 통과.
- 로컬 Windows Node v24.14.0 `npm.cmd run check`: 312/312 PASS, 실패/건너뜀 0. syntax 검사에 두 신규 실행 모듈 포함.
- GitHub Windows/Ubuntu CI는 이 브랜치 정확한 HEAD의 최종 결과/run/attempt를 PR에 기록한다.
- fixture는 Node VM에서 함수를 직렬화해 실행하며 초안 읽기와 DOM 쓰기 API를 throw로 차단한다.
  외부 계정, Playwright/실제 브라우저 DOM, ChatGPT 전송, Watchtower 연결은 실행하지 않는다.
- 실제 Chrome inventory 확인만 수행. 기존 중단 시험 탭이 접근 목록에 없어 DOM 진단은 미실행.
  오류 `SOURCE_MIGRATION_REQUEST_NOT_SENT_COMPOSER_MULTIPLE_VISIBLE`과 원본 요청을 보존한다.
- 코드/합성 검사 상태와 **REAL_ACCEPTANCE_PENDING**을 분리한다. 운영 반영/무인 관제 완성은 아니다.
- 재검토: 실행 경로 연결·중복 정규화·새 상태 저장소·기존 모델의 별칭/우회 경로 없음.
  관측 분류는 WP-02 행동 결정과 구분하며 sourceVersion과 schemaVersion으로 계약을 고정한다.

## 다음 슬라이스

WP-02의 단일 nextAction 순수 엔진·작업축별 영속 관측/이벤트·완료 응답 중복 방지다.
기존 SQLite, 승인/STOP/lease 및 UNKNOWN 송신 기록을 재사용하고 그 게이트를 우회하지 않는다.
실제 DOM 진단은 기존 등록 탭에서 `등록 대화 입력창 진단 (전송 안 함)`을 1회 수행한 구조 JSON이 필요하다.
해당 DOM 증거 없이 composer selector 변경/실패 초기화/원본 재전송을 진행하지 않는다.

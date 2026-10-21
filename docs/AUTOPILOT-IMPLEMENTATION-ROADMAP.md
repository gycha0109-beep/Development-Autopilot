# Development Autopilot — 상세 구현·검증 실행 로드맵

> 2026-10-21 실제 Windows Chrome v0.4.41: `codex_loading_test`의 지속 응답 로딩 오류를 동일 탭 자동 reload 1회로 복구하고, 같은 요청의 정상 완료 응답을 60,049ms 간격의 새 표본 2개로 독립 검증하여 DONE에 도달했다. 기존 이력 보존·추가 전송/재생성 0회. 실제 다중 축 오류/지속 실패/복구 후 후속 전송은 이 수락에 포함하지 않는다. [증거·검증 경계](WINDOWS-LOADING-RELOAD-2026-10-21.md).

> 2026-10-21 로딩 실패 후속: `이 응답을 불러오지 못했습니다`에서 읽기 재확인과 제한된 동일 탭 reload, 독립 응답 검증을 운영 server/worker에 연결했다. 전송/이관/복구 충돌과 불명 재실행을 막고, 정상 감시는 독립 유지한다. 실제 원인과 복구 효과를 분리하여 [검증 기록](WINDOWS-LOADING-RELOAD-2026-10-21.md)에 남긴다.

> 2026-10-21 WP-04 B: 운영 coordinator→영속 Stop/보고→등록 탭 worker→독립 관찰→재판단을 연결했다. 축 간 감시 정체와 기존 DB 큐 정책 업그레이드를 수정했다. 실제 v0.4.40 worker와 새 축 재연결·응답 로딩 오류 수신·자동 진행 활성화 거부는 확인했다. Reload/공식 재생성 후에도 실제 응답 오류가 지속되어 Stop/보고/계속 진행은 보내지 않았다. 복구는 축별 opt-in이며 실제 경고 복구 완주는 미검증이다. [코드·격리·실기기 경계](WINDOWS-DISCONNECT-EXECUTION-2026-10-21.md).

> WP-06 후속: 로컬 Inbox 운영 화면의 보류/승인 기록/거절/상태/재검사/감시 재개를 연결했다. 실제 Windows Chrome 1개 테스트 축에서 미해결 재개 차단과 정상 복구 후 읽기 감시 재개를 확인했으며 전송 권한은 늘리지 않았다. 메신저와 복구·이관 실행기 연결은 별도 미완료다. [검증 기록과 제한](WINDOWS-INBOX-ACCEPTANCE-2026-10-20.md).

> 2026-10-20 WP-03/WP-08 실제 원본 Chrome 테스트 **CI 자동 재개 1회 통과**: 기존 등록 재연결 후 정상 CI 대기 관찰 → 정확한 Attempt 2 실행 중 차단/재검사 → 성공·병합·필수 체크 확인 → 자동 `계속 진행` 1회 → 다음 답변 완료 및 중복 방지까지 확인했다. 원본 정상/복제 탭 오류를 구분해 앞선 보고를 정정했다. 실패·장기 대기·연결 복구·이관·메신저·다중 축 실기기 수락은 별도 미완료다. [실기기 기록](WINDOWS-CI-RESUME-ACCEPTANCE-2026-10-20.md).

> 2026-10-20 새 격리 대화에서도 실제 응답/대화 로딩 오류를 재현했다. 안내문 1회만 사용했으며 CI 재실행·자동 재개는 미사용이다. 전체 대화 실패의 전용 진단과 작업축별 Inbox 차단을 보완했다. [실기기 결과·미완료 경계](WINDOWS-CI-RECOVERY-TEST-2026-10-20.md).

> 2026-10-20 후속: 실제 ChatGPT 로딩 오류와 확장 전달 실패를 분리해 진단했다. 관찰 요청의 대기·수신·시간 초과·취소 영속 기록과 운영 화면을 보완했다. 실제 로딩 오류 및 CI 자동 재개는 미해결이며 [현재 실기기 경계](WINDOWS-RESPONSE-LOADING-DIAGNOSIS-2026-10-20.md)에 기록한다.

> 2026-10-20 WP-03 실제 연결: Windows keyring UTF-16LE 해독 수정 후 Watchtower 인증·Registry·Chrome localhost 화면 확인. 실제 GitHub 인증·정확한 CI 대상 교차 검증·승인된 안내문 전송은 완료했다. 재생성 1회 후에도 실제 ChatGPT 응답 불러오기 오류가 지속되어 CI 재실행/자동 재개는 미수행이다. 확정된 대화의 확장 Reload 재연결 결함도 수정했다. [최신 실기기 경계](WINDOWS-CI-APPROVED-TEST-2026-10-20.md) · [초기 연결 기록](WINDOWS-CI-ACCEPTANCE-2026-10-20.md).
> WP-03 후속: 정확한 GitHub Run/Attempt 및 PR 연관 검증, 재시작 후 유지되는 장기/불명 CI 대기 Inbox, pending 상태에서의 명시적 대상별 조건부 재개 승인을 구현했다. 코드·격리 검증과 실기기 CI→채팅 전송 미검증 경계를 위 기록에 분리했다.

> 수립: 2026-10-15 (KST)
> 지위: `docs/ROADMAP.md`의 Phase 2–8을 실행 가능한 작업 패키지(WP)로 분해한 **목표/계획 문서**. 코드 변경이나 Windows 실기기 성공을 뜻하지 않는다.
> 핵심 목표: Windows 로컬 관리자 + 사용자가 등록한 Chrome 개발 채팅 **10~20개 이상**을 독립 관찰하고, 정상 완료에서만 조건부 후속 지시를 발송한다. CI 대기·연결 끊김·길이 제한은 자동 분기하며, 사람이 필요한 특이사항만 인증된 메신저로 알린다.
> 관련: [상위 로드맵](ROADMAP.md) · [Codex 실행 프롬프트](CODEX-IMPLEMENTATION-PROMPT.md) · [아키텍처](ARCHITECTURE.md) · [운영 정책](OPERATING-POLICY.md) · [검증 기준](VALIDATION.md) · [기존 대화 실행기](PHASE-04-CHATGPT-SESSION.md) · [자동 이관 실기기 검증](CHAT-MIGRATION-SYNTHETIC-ACCEPTANCE.md)

## 0. 제품 경계·운영 원칙

### 0.1 사용자가 원하는 실제 경험

Windows PC에서 프로그램, CI Watchtower 및 Chrome을 실행해 놓고 휴대폰에서 다른 일을 한다. Autopilot은 각 등록 채팅의 마지막 출력/상태를 **주기적으로 확인**하며 다음과 같이 반응한다.

- 작업이 안정적으로 끝났고 승인된 후속 개발 범위가 남아 있으면 `계속 진행` 등의 사용자 지정 후속 지시를 **정확히 한 번** 보낸다.
- `병합 후 CI 확인 중`, `CI가 장기 실행 중이므로 대기 중` 등의 문장은 실제 CI 완료 증거가 아니라 **Watchtower 조회를 시작하는 신호**다. 실제 매핑된 PR·SHA·run·attempt가 queued/running이면 ChatGPT 입력은 중단하고 다음 **CI 재검사 시각**을 예약한다.
- 길이 제한 경고가 검증되면 **원본에서 이관문을 작성**해 같은 프로젝트의 새 대화로 **동일한 물리적 Chrome 탭**에서 이관하고 제목 N+1, 기존 작업축, 감시 상태 및 재개 가능한 기존 일정을 안전하게 계승한다.
- 화면에 `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.`가 지속되고 실제 중지 컨트롤이 검증되면 **중지 → 중단 확인 → 현황 보고 요청 → 답변 확인 → 재판단 → 조건부 계속 진행**을 실행한다. 단, 사용량/로그인/권한 제한을 우회하거나 불확실한 클릭/발송을 재시도해서는 안 된다.
- 결제/추가 비용, 로컬 Windows 테스트, 로그인, PR 병합/배포 승인, 중요 설계 결정, 장기 복구 실패는 **해당 작업축만** WAIT_HUMAN으로 만들고 로컬 Inbox와 인증된 메신저(초기 후보 Telegram)로 호출한다.
- 하나의 채팅이 대기·오류·이관 중이어도 다른 10~20개 등록 채팅은 각자의 타이머와 정책에 따라 진행한다.

### 0.2 반드시 구분할 타이머

1. **관찰 시각 (`nextInspectAt`):** 채팅 상태/다른 증거를 다시 검사하는 시각. 실행 허가가 아니다.
2. **후속 전송 가능 시각 (`nextEligibleDispatchAt`):** 승인 범위·최소 간격·중복 방지·CI/사람 승인·현재 응답 완료 등 모든 게이트를 통과한 뒤에만 적용한다.
3. **외부 증거 재검사 시각 (`nextExternalCheckAt`):** CI Watchtower/GitHub 대기에서 독립적으로 갱신된다.
4. **오류 복구 재검사 시각 (`nextRecoveryAt`):** 연결 오류 재확인/쿨다운용. 기존 '계속 진행' 전송 예약과 혼동하지 않는다.

35분이라는 과거 예시는 필수 기본값이 아니다. 사용자가 지정한 간격 및 승인 제약을 존중한다. 백그라운드 MV3 알람의 실제 동작 주기는 구현과 실기기 확인 대상이다.

### 0.3 절대 불변 조건

- **기존 등록 관계 유지:** 동일 Workstream ID/Session key, 원래 Chrome 탭/그룹, Watchtower Track 귀속을 가정으로 덮어쓰지 않는다. 대상 교체는 검증·승인이 필요하다.
- **한 행동은 최대 한 번:** 전송/중지 버튼/채팅 이관/원격 승인 전에 operation ID와 의도를 영속 저장한다. 클릭·ACK·브라우저 전환 불명은 UNKNOWN; 추측 재실행 금지.
- **증거 분리:** AI 문장 ≠ 코드 변경·CI 통과·병합 증거. 정확한 GitHub/Watchtower 관측이 우선한다.
- **작업축별 격리:** 개별 대기·실패가 전체 STOP으로 승격되지 않는다. 단, 사용자가 지정한 전역 STOP은 전부 차단한다.
- **승인 불변:** 비용, 결제, 권한, 병합/배포, 로컬 검증 대리확인, 범위 확대는 모델 출력만으로 허가하지 않는다.
- **개인정보 최소화:** 기본은 구조적 UI 상태, 완료 여부, 제한적 상태 문구/지문. 원문 전체 대화/초안/토큰/개인 메시지를 외부 로그/메신저에 전달하지 않는다. 제공자별 관측/자동화 권한·약관은 별도 검토한다.
- **제한 존중:** 전송량 제한·로그인·인증·서비스 정책을 우회하지 않는다. 연결 끊김은 곧바로 서비스 제한이라고 단정하지도 않는다.
- **테스트와 실기기 구분:** 합성 DOM/CI 성공은 실제 Windows Chrome에서 작업이 성공했다는 뜻이 아니다. 실패 상태는 임의 초기화하지 않는다.
- **PR/병합:** 구현은 작은 PR 단위로 진행. 사용자가 명시적으로 지시하지 않으면 병합·운영 배포하지 않는다.

## 1. 현행 코드·증거의 출발점 (구현과 목표 혼동 금지)

| 현재 요소 | 확인 가능한 파일/역할 | 현재 한계 또는 연결할 확장점 |
|---|---|---|
| Windows localhost 관리자·SQLite Workstream | `local/server.js`, `local/store.js` | 기존 상태/타이머를 재사용해야 하며 관찰/후속 행동의 통합 분기 엔진은 목표 상태 |
| 모의 스케줄러 | `local/scheduler.js` | 현재는 모의 실행 및 관찰 due 검사; 다중 실제 응답 기반 행동 결정과 별개 |
| 예약 전송·claim·ACK | `local/chat-continuation.js`, `extension/background.js`, `extension/chat-page.js` | 전송 버튼 클릭 ACK는 assistant 완료/개발 완료의 증거가 아님 |
| CI 검증 | `local/watchtower-observer.js`, `local/github-observer.js`, `local/decision-gate.js` | 정확한 대상/증거 게이트가 존재하지만 응답의 CI 대기 → 독립 재검사 → 정상 후속 전송 전 구간은 미검증 |
| 자동 이관·수동 복구 | `extension/migration-auto.js`, `extension/migration-page.js` | 누적 PR 코드/합성 회귀 존재. **자동 이관 Windows 실기기 완주 미검증**. 기존 중단된 '자동 이관 검증 1' 보존 |
| 상세 입력창 읽기 전용 진단 | `extension/chat-page.js`, 확장 옵션 | PR #46/v0.4.32에서 편집 영역의 구조 진단 추가. 실제 편집기 2개 원인 결과 미수집 |
| 사람 호출 / Telegram | 상위 운영 정책에 목표 반영 | 메신저 발송·회신/승인 구현, 실기기 검증 **아직 없음** |
| 동시 10~20개 탭 실운영 | 등록/스케줄 구조의 기반만 존재 | 공정 스케줄·스로틀링·비정상 상태 격리·Windows 장기 실험 필요 |

**베이스라인 주의:** 코드상 `extension/chat-page.js`의 입력창 엔진 서명과 `local/chrome-bridge.js`의 `REQUIRED_COMPOSER_BUILD`가 최신 브랜치에서 일치하는지 **WP-00에서 실제 코드 기준으로 점검**한다. 최근 브랜치에서는 `r16` / `r14` 값의 불일치가 관찰됐으므로 실제 브리지 동작을 먼저 검증하고 필요하면 작은 별도 변경으로 수정한다. 기존 테스트 문서의 오래된 버전 표기도 현재 실행 상태와 대조한다. 문서의 예전 문구만 보고 무조건 코드를 갈아엎지 않는다.

**미병합 PR 스택:** 이 상세 계획은 #47 제품 방향 문서 위에 추가된다. 이전 #25–#47은 누적 브랜치로 남아 있으므로 main의 완료 기능으로 주장하지 않는다. Codex는 실행 당시 최신 Git/PR 상태를 재조회해야 한다.

## 2. 전체 상태 전이·우선순위 계약

### 2.1 한 작업축의 주기적 관찰

1. 작업축별 `nextInspectAt` 도래 → **등록 탭 식별/권한/전역 STOP** 확인.
2. 같은 작업축에 이미 송신/이관/복구 명령이 진행 또는 결과 불명이면 **검사·화면 갱신만 허용**하고 중복 외부 행동은 금지.
3. 관측 가능한 범위의 화면 UI + 응답 생성 상태 + 마지막 결과(응답 지문, 타임스탬프/출처)를 구조화한다. 신호가 불명확하면 UNKNOWN.
4. 입력이 없어도 다른 증거(Watchtower 변화, 메신저 회신, 작업축 pause 해제)가 있을 때는 다시 평가한다.
5. 하나의 **결정 함수**가 정확히 하나의 `nextAction`을 산출한다. 실행기는 다시 최신 탭/증거/권한을 검사한다.
6. 검증된 행동 1회와 ACK/관측 결과를 별도 저장한다. 다음 검사 시각을 예약한다.

### 2.2 우선순위와 처리 테이블

| 우선 | 관측/게이트 | 결정 | 자동 외부 행동 |
|---|---|---|---|
| 0 | 전역/개별 STOP, 허용 범위 위반, 공급자 제한, 명시적 승인 필요 | `PAUSED / WAIT_HUMAN / BLOCKED` | 없음, 필요한 경우 Inbox/메신저 |
| 1 | 이미 명령 진행/클릭 결과 불명, 사용자 입력 중, 충돌하는 신호 | `RUNNING / UNKNOWN` | 없음, 안전한 재관측만 |
| 2 | **지속되는 연결 해제 오류** + 해당 응답의 중지 컨트롤 검증 | `RECOVER_DISCONNECT` | 기록된 단계에 맞는 중지/보고 중 **한 행동만** |
| 3 | 검증된 길이 제한 UI | `HANDOFF` | 기존 동일 탭 이관 상태머신의 다음 확인된 행동 |
| 4 | CI 대기/병합 확인 문구·PR 상태가 불확실 | `CHECK_CI / WAIT_EXTERNAL` | Watchtower/GitHub 조회, 필요한 경우 재검사 타이머 |
| 5 | 답변 여전히 생성 중 | `WAIT_RESPONSE` | 새 메시지 전송하지 않음 |
| 6 | 안정적으로 완료된 답변 + 승인 후속 작업 범위 존재 | `CONTINUE` | 확인된 사용자 지정 후속 지시 정확히 1회 |
| 7 | 승인된 페이즈/제품 목표 최종 완료 | `COMPLETE` | 후속 지시 금지; 필요 시 결과 보고 |

**복합 상태 주의:** 스크린샷의 연결 해제 화면에는 노란색 중지 버튼이 *남아 있으므로*, `응답 생성 중`이라는 단순 추정만으로 연결 오류 분기를 영구 차단해서는 안 된다. 최상위 0·1 안전 게이트를 우선 적용한 후, **증명된 연결 경고는 일반 생성 중 판단보다 먼저 검사**하되, 경고/중지 버튼의 진위를 확인하지 못하면 클릭하지 않는다. CI 문구/길이 제한 등이 함께 검출되어 모순되면 자동으로 임의 우선처리하지 말고 이유 있는 UNKNOWN/재관측을 기록한다.

### 2.3 내부 관측 스키마 초안 (API/DB 확정 전 테스트)

- 식별: `workstreamId`, `sessionKey`, `registeredTabId`, `registeredConversationUrlFingerprint`, `observedAt`, `sourceVersion`.
- UI: `assistantBusy`, `assistantStable`, `composerHasDraft`, `connectionWarning`, `lengthWarning`, `stopControlEvidence`, `uiAmbiguous`.
- 선택적 의미 신호: `ciWaitCue`, `humanActionCue`, `scopeCompleteCue` (정확한 출처와 스키마/정책 버전을 포함하고, 원문 전체 대신 최소 분류 결과만 저장).
- 외부 사실: `repository`, `project/track binding`, `prNumber`, `headSha`, `runId`, `attempt`, `checkedAt`, `evidenceFreshUntil`.
- 지속 상태: `observationFingerprint`, `lastCompletedAssistantFingerprint`, `lastConfirmedDispatchOperation`, `decision`, `reasonCode`, `nextInspectAt`, `nextExternalCheckAt`, `recoveryStage`.

필수 규칙: 사용자의 마지막 메시지, 숨겨진 글쓰기 본문, 화면의 임의 aria-label을 **그대로 원격으로 유출하지 않는다**. 관측 어댑터는 실제 provider-supported/승인된 능력에 따라 대체 가능해야 하며 제한된 UI 환경에서는 'unknown'을 정확히 반환한다.

### 2.4 CI 분기 결정 계약

- AI 출력의 `CI 확인 중` 같은 문장을 읽더라도 **조회 트리거**일 뿐 CI 완료·병합 여부를 증명하지 않는다.
- Watchtower Project/Track 귀속 + GitHub repo/PR/head SHA + runId/attempt + 최신 필수 체크를 교차 검증한다.
- queued/pending/running: `WAIT_EXTERNAL`, `nextExternalCheckAt` 예약, ChatGPT 송신 금지.
- success: 필수 체크/병합/작업 범위를 독립 검증하고 다른 대기 게이트가 없을 때만 다음 지시 가능.
- failure: 승인 범위 내 실패 원인 분석·수정 지시 또는 사용자 승인 대기; CI 무제한 재실행 금지.
- stale/unavailable/mismatch: `UNKNOWN`, 읽기 전용 재조회. 오래 지속되면 설정된 임계치로 묶어서 알림.
- Watchtower 자체 폴링과 Autopilot 스케줄을 중복 폭주시켜서는 안 된다.

### 2.5 연결 해제 복구 단계

`SUSPECTED → RECHECK_WARNING → STOP_INTENT_RECORDED → STOP_RESULT_VERIFIED → STATUS_REPORT_INTENT_RECORDED → REPORT_RESPONSE_VERIFIED → REEVALUATE_GATES → NORMAL / WAIT_EXTERNAL / WAIT_HUMAN / BLOCKED`.

각 전이의 공통 검사:
- 동일 등록 물리적 탭·프로젝트 대화·원래 작업축 일치.
- 경고 `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.`가 실제 활성 화면의 **경고 영역**에 나타나며 아직 지속 중인지 확인. 일반 assistant 인용문에 등장한 같은 텍스트는 제외.
- 정지 컨트롤은 유일하고 클릭 가능하며 해당 응답의 중지 생성 버튼이라는 **DOM/상태 출처 증거**가 있어야 한다. 버튼 색만으로 판단하지 않는다.
- 중지 클릭의 '시도'부터 기록; 중단 완료가 확인되기 전 현황 보고 지시를 보내지 않는다.
- 현황 보고는 **정확히 1회** 전송. 보고가 완료됐을 때 CI/비용/사용자 승인 요구가 나오면 그 분기로 이탈하며 무조건 `계속 진행`을 보내지 않는다.
- 반복·불명·제한 징후는 사용자/작업축별 정책 상한·쿨다운·백오프 적용. 로그인/사용량/정책 제한을 중지/재시도로 우회하지 않는다.

## 3. 작업 패키지 및 의존관계

`WP-00(현 상태·Chrome 증거) → WP-01(관측 계약) → WP-02(단일 결정 엔진) → WP-03(독립 타이머/CI 조회) → WP-04(연결 복구) → WP-05(자동 이관 연속성) → WP-06(사용자 예외/메신저) → WP-07(10~20개 동시성) → WP-08(Windows 실기기) → WP-09(배포/운영화)`

병행 가능한 항목: WP-06의 **로컬 Inbox/가짜 메신저**는 WP-02의 `WAIT_HUMAN` 계약 이후, WP-05의 이관 출처/진단 작업은 WP-00 완료 뒤 독립 PR로 개발 가능하다. 단, 장시간 실운영은 모든 안전 게이트의 검증 이후에만 진행한다.

### WP-00 — 베이스라인 동결·실제 Chrome 문제 재현 (P0, 가장 먼저)

**목적:** 미병합 PR들과 실제 Windows 환경 간의 차이를 확정하고, 예전 버그를 추측으로 또 수정하지 않는다.

- 작업 00-A: 현재 checkout/브랜치/PR 스택/미병합 상태/실행 중 확장 버전/로컬 bridge 기대 엔진·저장소 테스트 버전을 비교해 **truth table** 작성. 특히 `REQUIRED_COMPOSER_BUILD`와 `CHAT_COMPOSER_BUILD` 일치 여부를 검사.
- 작업 00-B: 이미 중지된 `자동 이관 검증 1` 원본 채팅을 **재전송/재등록/초기화하지 않고** v0.4.32의 `등록 대화 입력창 진단 (전송 안 함)`으로 실제 편집 영역 2개에 대한 메타데이터 수집. DOM을 수집하지 못하면 실기기 수동 확인 BLOCKED로 기록하고 다음 코딩은 합성 환경에서 진행.
- 작업 00-C: 예전 `docs/CHAT-MIGRATION-SYNTHETIC-ACCEPTANCE.md`의 현재와 맞지 않는 탭 생성 방식·확장 버전·실행 명령을 실제 코드/PR에 대조한 뒤 근거 있는 문서 정리.
- 작업 00-D: 브리지/옵션/서비스 워커 버전 드리프트가 있으면 **최소 수정 별도 PR**, 실패 원인 재현 회귀 테스트 추가.
- 예상 위치: `extension/chat-page.js`, `extension/options.js`, `extension/background.js`, `local/chrome-bridge.js`, `tests/chat-runtime-diagnostics.test.js`, `tests/chrome-worker-handshake.test.js`.
- **완료 기준:** 실행 중인 버전·브리지 호환성·미재전송 상태에 대한 기록이 존재하고, 결정적인 버전 불일치 검증 테스트 및 Windows/Ubuntu CI 통과. **실제 DOM 증거를 얻지 못했다면 얻었다고 주장하지 않는다.**

### WP-01 — 읽기 전용 응답/화면 관찰기 (P0)

**목적:** ChatGPT 응답의 마지막 상태와 오류 경고 UI를 **사용자 초안에 손대지 않고** 감지한다.

- 관찰 대상: 등록된 단일 탭, 세션/프로젝트 일치, assistant 생성 중·종료·안정화, 마지막 답변 identity/fingerprint, 오류 banner 출처, 길이 제한 경고, 현황 보고·CI/사람 호출 단서.
- role-less DOM/가상화/글쓰기 블록/접힌 본문/복수 contenteditable/중복 시그널을 합성 fixture로 모델링. 사용자 작성 중인 editable은 내용 수집·입력·출력하지 않음.
- 관찰 신호에 `source, confidence/verified flag, observedAt, schemaVersion, reasonCode`를 남기고 고정되지 않은 DOM에서 UNKNOWN으로 종료.
- **분류기와 실제 페이지 읽기 코드 분리.** 확장 스크립트는 최소 신호를 반환하며 전체 채팅 텍스트·URL·토큰을 로그로 남기지 않음.
- 예상 위치: 신규 `extension/chat-observer.js` (이름 조정 가능), `extension/background.js`, `local/*observation*.js`, `tests/chat-observer.test.js`.
- **완료 기준:** synthetic UI 10종 이상 (생성 중/정상 완료/실패 banner/길이 경고/사용자 초안/메시지에 인용된 경고/유사 stop 버튼/글쓰기 블록/DOM 불명/탭 불일치)에서 참·거짓·불명 분류, **부수효과 0**. 실제 Chrome/권한은 별도 acceptance.

### WP-02 — 순수 결정 엔진과 SQLite 이벤트 영속화 (P0)

**목적:** 여러 관측 및 외부 증거를 **딱 하나의 허용 후속 행동**으로 매핑한다.

- `classifyObservation(snapshot)`과 `decideNextAction({observation, workstream, ci, policy, operation})`에 준하는 순수 함수 계약 정의. 구체 이름은 기존 구조에 맞게 선택.
- 결정 집합 예: `INSPECT_AGAIN`, `CONTINUE`, `CHECK_CI`, `WAIT_CI`, `BEGIN_HANDOFF`, `RECOVER_DISCONNECT`, `CALL_OPERATOR`, `NO_ACTION`, `UNKNOWN`.
- 각 결과: `workstreamId, decision, reasonCode, observationFingerprint, evidenceRefs, nextCheckAt, authorizationRequired, actionFingerprint`. UI 반영과 테스트는 이 단일 결과를 재사용.
- SQLite에 최신 관측·마지막 처리한 완료 응답 지문·분기 이유·시각·operation intent/receipt/retry 상태를 영속화. 기존 `WorkstreamStore` 모델 및 Migration 상태를 임의 삭제/교체하지 않음.
- STOP, WAIT_HUMAN, 사용자 타이핑, 아직 생성 중, 오래된 CI, 부정확한 탭, 이전 전송 불명 상태의 fail-closed 테스트.
- **완료 기준:** 위 `2.2` 의사결정 매트릭스 단위·테이블 테스트 및 1회성 보장(같은 응답 두 번 관찰해도 후속 메시지 1회 이하). 분류 결과와 실행 게이트를 동일한 권한 검사에 결합.

### WP-03 — 상태별 타이머·Watchtower 재검사 및 조건부 후속 전송 (P0)

**목적:** 평상시 주기 확인하고 CI 대기에는 **불필요한 '계속 진행'을 보내지 않는다.**

- `local/scheduler.js` 및 `local/chat-continuation.js`의 현재 예약/claim 시스템을 재사용해 관찰 tick과 메시지 dispatch tick을 분리. 현재 수동 승인·한도·ACK·UNKNOWN 의미 유지.
- Workstream별 `nextInspectAt / nextExternalCheckAt / nextEligibleDispatchAt`과 last completed fingerprint, 마지막 확정 송신 Operation을 도입. MV3 알람/브리지 반복 호출에도 중복 명령 없음.
- Watchtower exact Project/Track/Repo, GitHub PR/SHA/run/attempt를 재사용. CI queued/running이면 DB에 기다릴 시각 저장. 새 근거가 없으면 모델 재촉하지 않음.
- CI 성공 뒤에도 병합/필수 체크/예정된 작업/승인 여부 재확인. 실패면 승인된 실패 분석, 막힘이면 사용자 호출, 불명은 UNKNOWN.
- **완료 기준:** fake clock으로 CI 장기 실행, 재시도 attempt, 오래된 timestamp, 다른 Track의 성공, PR 미병합, Watchtower 끊김, MV3 여러 알람 중복 등 테스트; 다음 전송 0건/1건을 정확히 검증.

### WP-04 — 연결 해제 오류의 단계별 안전 복구 (P0)

**목적:** 실제 사용자가 제공한 연결 해제 경고 화면을 재현하고 복구를 사람이 반복하지 않게 한다.

- 먼저 오류/안내 메시지가 실제 경고 컨테이너의 상태인지 검증. assistant가 '연결이 해제되었습니다'를 인용한 텍스트면 복구 트리거로 삼지 않음.
- 지속 시간/재검사를 거쳐 유일한 Stop-generation 버튼의 소속/가시성/활성 상태 판정. **노란색 정사각형 모양만 근거로 클릭하지 않음**.
- `STOP_INTENT` 사전 저장 → 한 번 클릭 → stop 완료 검증. 불명 상태는 STOP 반복하지 않고 UNKNOWN.
- 현재까지 작업과 남은 작업 보고를 정확히 한 번 지시 → 답변 안정화 → CI/길이/사람 승인 분기 재평가 → 정상이라면 한 번 `계속 진행`.
- 횟수 상한·쿨다운·유사 오류 신호·rate/login/quota 제한 구분, 다른 탭 영향 0.
- **완료 기준:** 첫 경고 지속, 경고 사라짐, 버튼 두 개, 클릭 후 네트워크 단절, 현황 보고 후 CI 대기/승인 필요, 반복 실패 및 확장 재시작을 모두 테스트. 실제 Windows Chrome Stop 컨트롤 식별 Acceptance는 별도.

### WP-05 — 기존 자동 이관을 판단 엔진과 단일 작업축 상태에 통합 (P0)

**목적:** 길이 제한은 단순 새 채팅 작성이 아니라 **기존 작업축과 자동 운영 루프의 연속성**을 보장한다.

- 기존 `extension/migration-auto.js`, `migration-page.js`의 원본 작성·Writing Block/코드블록 추출·동일 탭 cutover·제목 N+1/수동 복구를 재사용. 새 임의 탭 만들기, 기존 작업축 삭제/재등록, 중복 source request는 금지.
- 로컬 판단 엔진 상태에서 `HANDOFF`로 일시 정지하여 source request 및 target send 전후 단계·증거를 기록. CI 타이머·원래 작업축 id·감시 설정과 완료 응답 지문은 검증 후 계승.
- 상태 불명 시 항상 operator review. 이전 실패의 `needs_attention` / unknown을 새 버전 적용 후 자동 초기화하지 않음.
- **완료 기준:** 합성 끝단(원본 요청 1회 → 작성 결과 → 새 대화 첫 메시지 1회 → 실제 assistant 첫 답변 → 제목 N+1 → 기존 Workstream/CI/타이머 유지) + 실제 Windows Chrome 동일 프로젝트 Acceptance 분리. 사용자 확인 버튼을 포함한 성공을 무인 완료로 표기하지 않음.

### WP-06 — 로컬 Inbox → 인증된 메신저 예외 보고/명령 (P1, WP-02 이후 조기 착수)

**목적:** 사용자는 전화로 특이 보고만 받고 필요한 동작을 원격 승인·보류·재개할 수 있다.

- 우선 **전송 없는 로컬 Inbox**를 SQLite로 구현: `requestId, workstreamId, reasonCategory, exactActionFingerprint, evidenceTimestamp, expiresAt, state, acknowledgedAt, deliveryAttempts`.
- 유형 분류: 비용/구독/결제 승인, 로컬 테스트, 로그인/권한, 민감 PR 병합/배포, 설계 결정, 장기 오류, CI 이상 정체. 알림에는 프로젝트/조치/기한/중단 이유만 포함.
- Telegram은 **후보**로 가짜 전송기로 먼저 테스트. 사용자가 명시적으로 연동·발신자 등록·토큰 저장/수신 동의한 경우에만 실제 연동. KakaoTalk/SMS 등은 지원/인증/비용 검토 후 어댑터.
- 읽기 전용 `상태조회`, `보류`, `재개`, 구체 행동 1건의 `승인/거절`. 발신자 허용 목록/한 번만 유효한 nonce/만료 시각/행동 지문/대상 SHA와 현재 승인 게이트 재검증. `재개`는 비용·병합·배포 승인으로 취급 금지.
- 메신저 미연결/지연/동일 메시지 반복/승인 변조 → 로컬 Inbox 대기 유지. 그 작업축 외 자동 운영은 진행.
- **완료 기준:** 악의적 메시지·다른 발신자·만료/중복/이전 SHA 회신 거부, 개인정보·토큰 비노출, 성공 전달·거부·중단 이력 테스트. 실제 Telegram 사용자 연동은 별도 opt-in 및 수동 Acceptance.

### WP-07 — 10~20개 등록 탭 동시성·공정성·속도 제한 (P1)

**목적:** 한 작업축에 병목이 있어도 나머지 등록 작업축이 작업을 계속한다.

- 각 workstream마다 독립 상태·타이머·진행 중 operation lease. 재검사/전송/CI 조회/이관/메신저 알림은 **용도별 별도 큐/동시성 제한**을 가진다.
- provider별 동시 실행 상한, 전체 지연·백오프·jitter, 공정한 round-robin, 네트워크 실패시 circuit breaker 또는 보수적 분산 정책. 구체 수치는 단위 테스트/사용자 설정 기반으로 결정하며 임의의 사용량 한도 우회를 목표로 하지 않음.
- 같은 repository/PR 공유와 다른 Track 귀속, 동일/변경 URL, 다중 Chrome 그룹/창, 브라우저·서비스 워커 재시작, 절전·깨어남을 검증.
- **완료 기준:** 1→3→10→20개 혼합 시나리오 fixture에서 잘못된 탭 송신·작업축 간 상태 오염·중복 외부 행동·무단 비용/병합 **모두 0건**. 오프라인 4시간 후 catch-up 발송 폭주 0건.

### WP-08 — Windows 실기기 수동 Acceptance 및 관측성 (P0/P1 경계)

2026-10-19 부분 실기기 결과: 테스트 축 1개의 실제 시작 메시지와 자동 후속 메시지를 각각 1회 전송하고 다음 실제 응답 완료를 확인했다. 실행 중 드러난 한도 후 관찰 중지 결함은 서버 수정 후 읽기 전용 재검증으로 구분하며, 최종 빌드에서 새 2회 전송 캠페인을 다시 실행한 것은 아니다. [상세 결과·증거·제한](WINDOWS-CHROME-ACCEPTANCE-2026-10-19.md)을 참조한다. 아래 C~G의 실제 Windows 시나리오 전체 완료나 main 병합을 의미하지 않는다.

**목적:** Node 가짜 DOM 통과와 실제 Chrome 작동을 철저히 구분한다.

- 단계 A: 등록 탭과 실행 중 확장/localhost/Watchtower 버전 확인. 1개 챗에서 **읽기 전용** 상태 진단 결과 제공.
- 단계 B: 정상 완료 + 실제 사용자 승인하에 후속 지시 **딱 한 번**, 진짜 assistant 응답 완료 판정.
- 단계 C: 실제 CI 대기(정확한 PR/SHA/Run) → 대기 중 전송 0회 → CI 변화 후 후속 행동.
- 단계 D: 제공된 연결 해제 경고 + Stop 화면에서 **경고/정지/결과** 수동 감독 하 검증. quota/login 제한 시 자동 복구 미실행 확인.
- 단계 E: 글쓰기/코드형 원본 작성→동일 탭 이관→제목 변경→작업축 감시 및 유효한 후속 타이머.
- 단계 F: 로컬 Inbox/실제 메신저 opt-in 전달·회신·만료·정지·재개.
- 단계 G: 1→3→10→20 탭 및 장시간 동시 운영. 각 단계의 실제 결과/실패/버전/증거를 `docs` 아래 감사 가능한 체크리스트로 기록.
- **완료 기준:** 각 시나리오에 작업축 ID(비민감 지문), 시각, 전제, 실행 행동 수, 실제 검사 결과, 스크린샷/사용자 확인 범위, 잔여 blocker가 명시됨. 모의 CI만으로 단계 완료 금지.

### WP-09 — 운영 화면·Windows 배포/복구·품질 지표 (P1)

- 중앙 화면에서 작업축별 현재 모드(실행 중/CI 대기/연결 복구/이관/사용자 호출/오류/완료), 다음 검사 시각, reason code, 최근 verified action을 즉시 확인.
- 사람이 '재개'를 누를 때 **무슨 작업이 왜 멈췄는지** 표시. 전체 STOP과 개별 STOP을 분리.
- Windows 재시작/Chrome 재시작/확장 교체/Watchtower 미연결/메신저 미연결에서 기능별 영향·안전한 복구 절차.
- 설치/업데이트/롤백·DB migration/백업/로그 보존. 사전 허가 없는 실제 운영 비용 증가나 공급자 권한 변경 금지.
- 핵심 지표: 실제 검증된 작업 완료 건수, 중복 전송 0, 잘못된 Track/탭 전송 0, 승인 없는 민감 조치 0, 사람 호출 중 실제로 유효한 비율, 실패 상태에서 회복까지 걸린 시간.

## 4. PR 단위 실행 규칙 (Codex 운영 계약)

- **한 번에 전체 구현 금지.** WP 단위에서 더 작은 **독립적으로 검증 가능한 수직 슬라이스**로 나누어 한 PR에 하나의 검증 가능한 행동만 추가한다.
- 작업 시작: `git status`/현재 checkout, 열린 PR 스택, `docs/ROADMAP.md`, 이 문서, `OPERATING-POLICY.md`, 관련 코드/테스트를 실제 읽어 미구현 기능을 확인한다.
- 처음에는 **WP-00을 수행**한다. 기존 실패 대화의 상태를 삭제/초기화하거나 원본 전송을 반복하지 않는다. 실기기 접근이 불가능하면 해당 단계는 *수동 Acceptance 대기*로 명확히 기록하고, 안전한 합성 테스트/후속 순수 엔진 설계만 진행한다.
- 기능 설계는 `관찰 어댑터 → 순수 분류·결정 → 영속 스케줄 → 한 번짜리 실행→독립 재검증` 레이어를 유지한다.
- 새로운 외부 행동에는 **사전 기록, at-most-once, ACK 불명 시 UNKNOWN, 최신 근거 재확인, 독립 작업축 격리** 테스트를 필수로 포함.
- CI는 최소 `npm run check` (Node 22.16+) 및 GitHub Actions Ubuntu/Windows를 확인한다. 자동 CI 통과와 Windows 사용자 실기기 동작을 별도 보고한다.
- PR마다 문서·코드·테스트·테스트 결과·미해결 blocker·사용자에게 필요한 실제 조치를 기록. 연속 PR은 정확한 부모 브랜치/베이스를 유지하고 임의 main 병합 금지.
- 필요한 결제/민감 승인/실제 ChatGPT 계정 행동/프로덕션 배포/메신저 토큰 설정/실기기 버튼 클릭은 **요청 전후 증거와 명시적 사용자 승인**을 거친다. 사용자 동의 없이 서비스 정책을 변경하지 않는다.
- 작업축별 `nextAction`이 UNKNOWN/WAIT_HUMAN이면 무작정 `계속 진행`을 다시 전송하는 대신 정확한 이유와 필요한 확인 한 가지만 보고한다.

## 5. 패키지별 검증·보고 템플릿

각 WP PR 설명과 완료 보고에 다음 값을 의무화한다.

| 항목 | 반드시 기록 |
|---|---|
| WP / PR / 브랜치 / base | 정확한 범위·부모 PR·head commit SHA |
| 사용자-visible 변화 | 자동 관찰 / 전송 / 대기 / 호출 / UI 확인 중 무엇이 바뀌었나 |
| 안전성 불변 조건 | 대상 탭·Track·메시지 횟수·승인 게이트·예상 불명 상태 |
| 합성 검증 | 명령·테스트 건수·성공/실패·Windows 및 Ubuntu |
| 실제 Windows Chrome | 실행됨/미실행/차단됨, 버전, 실제 사용자가 확인해야 할 행동 |
| 다음 WP 진입 조건 | 무엇이 검증되면 다음 단계로 갈 수 있는지 |
| 남은 blocker / 요청 | 사람이 PC에서 확인해야 할 **구체적 1회 동작** 또는 보류 사유 |

**완료 판단:** CI 100%라도 브라우저 실기기 시나리오 미검증이면 `CODE_READY / REAL_ACCEPTANCE_PENDING`. 실제 사용자 개입 없이 실행했다고 속이지 않는다.

## 6. 실행 우선순위·출구 기준 요약

| 우선순위 | 가장 먼저 낼 결과 | 다음 단계 조건 |
|---|---|---|
| 1 · WP-00 | 소스/런타임 버전 정합성, 현재 이관 테스트 실패의 안전 진단 | 실제 브리지 불일치 수정, 미재전송 보증 |
| 2 · WP-01~02 | read-only 관측기 + 상태별 결정 엔진, 모의 입력부터 | 모든 분기·모순·불명 상태 테스트 |
| 3 · WP-03~05 | 조건부 계속 진행 + CI 재검사 + 연결 복구 + 이관 연속성 | 단계별 at-most-once 및 Windows Acceptance |
| 4 · WP-06 | 로컬 Inbox + 인증된 메시지 알림/회신 (승인 opt-in) | 실제 호출·회신·중복 방지 검증 |
| 5 · WP-07~09 | 10~20 탭 동시 운영·장시간 오류 주입·Windows 패키징 | 검증 완료 건수·오호출/중복/무단 행동 0건 |

**최종 제품 성공:** 사용자가 PC 앞을 떠나 있어도 다중 작업축에서 정상 개발을 지속하고, CI·이관·일시적 연결 오류는 증거 기반으로 처리하며, 결제/로컬 테스트/중요 결정 등 *진짜 필요한 시점*에만 휴대폰으로 알림을 받는다. '스팸성 프롬프트를 많이 보낸 시스템'은 성공이 아니다.

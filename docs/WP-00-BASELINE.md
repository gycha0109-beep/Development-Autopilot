# WP-00 — 소스 및 브리지 호환성 확인

확인일: 2026-10-16 KST. 범위: 00-A/C/D 코드·합성 검증, 00-B 실제 Chrome 진단은 대기.

## 기준과 변경 범위

- 저장소: `gycha0109-beep/Development-Autopilot`.
- 부모: PR #48, `docs/detailed-autopilot-execution-roadmap`, `287ff951789c2892442d54b7c1fa00f40f3a4fc7`.
- #48의 부모 #47: `docs/decision-driven-multi-session-autopilot`, `7e2b63026dff913a03a6f7527bc48ce66cfaa1c9`. 두 PR 모두 조사 당시 미병합. 기존 스택은 유지한다.
- 작업 브랜치: `fix/wp00-composer-bridge-compatibility`. 빈 작업 디렉터리 아래 별도 clone에서 시작했으며 운영 DB/확장에 적용하지 않았다.
- 실행 코드 변경은 `local/chrome-bridge.js` 기대 버전 한 줄. DOM 선택자, manifest, 옵션, worker, 이관 상태머신은 변경하지 않는다.

## 버전 truth table

| 요소 | 부모 소스 | WP-00 소스 | 실제 실행 중 버전 |
|---|---|---|---|
| `extension/manifest.json` | 0.4.32 | 0.4.32 | 미확인 |
| `CHAT_COMPOSER_BUILD` | composer-2026-10-15-r16 | 동일 | 미확인 |
| 주입되는 읽기 전용 진단 함수의 build | composer-2026-10-15-r16 | 동일 | 미확인 |
| background heartbeat / 상태 응답 | 위 상수 사용 | 동일 | 미확인 |
| 옵션 runtime 검사 | composer-2026-10-15-r16 | 동일 | 미확인 |
| `REQUIRED_COMPOSER_BUILD` | composer-2026-10-14-r14 | composer-2026-10-15-r16 | 운영 bridge 미확인 |
| continuation / HTTP / bridge 정상 경로 fixture | r14 고정 | 실제 확장 상수 사용 | 합성 테스트만 |

부모 코드의 `ChromeBridge.sync()`는 r16 heartbeat를 받아도 `composer_build=NULL`로 저장한다. `ChatContinuation.linkedSession()`은 정확한 build를 요구하므로 정상 탭도 `CHAT_SESSION_NOT_CONNECTED`로 승인/claim을 차단한다. 구버전 r14는 오히려 호환 빌드로 인정됐다. 이는 **실제 코드 경로에서 재현한 별도 호환성 버그**이며, 기존 `COMPOSER_MULTIPLE_VISIBLE`의 원인을 증명하지 않는다.

## 현재 구현과 목표의 차이

| 영역 / 조사 파일 | 현재 구현 | 남은 구현·검증 |
|---|---|---|
| `local/store.js`, `server.js` | SQLite 작업축/이벤트/operation, STOP, HTTP API | 관찰별 상태·결정·타이머 영속화 |
| `local/scheduler.js` | observe due와 no-side-effect MockExecutor | 실제 응답 상태 기반 스케줄링·공정 동시성 |
| `local/chat-continuation.js` | 명시적 메시지/간격/기간/횟수 승인, queue/claim/ACK, UNKNOWN 재전송 차단 | 정상 답변 완료 지문 기반 조건부 실행 |
| `local/decision-gate.js`, Watchtower/GitHub observer | 정확한 대상·SHA·run/attempt·신선도·승인 검증 | 채팅 CI 단서부터 독립 재검사까지 연결 |
| `extension/background.js`, `chat-page.js` | heartbeat, 등록 경로 확인, 전송기, 읽기 전용 입력창 구조 진단 | 통합 응답 관찰기·순수 상태 분류 |
| `extension/migration-auto.js` | 원본 요청, 실제 작성 답변, 같은 탭 이동, 첫 응답/제목/등록/일정 복구 단계와 no-replay | 판단 엔진 통합 및 Windows 종단 간 acceptance |
| Inbox / 메신저 / 연결 복구 | 목표 문서만 존재 | WP-04/06 구현과 승인된 실기기 검증 |
| 10~20개 운영 | 등록·작업축 기반 존재 | WP-07~09 혼합 상태·장시간 검증 |

## 재현 및 검증

- 신규 `tests/composer-bridge-compatibility.test.js`: 부모 실행 코드에서 **4/4 실패**. 정확한 상수 불일치, r16 저장 결과 null, 승인 단계 `CHAT_SESSION_NOT_CONNECTED`를 확인했다.
- 기대 버전 한 줄 수정 후 **4/4 통과**. 실제 `ChromeBridge` + SQLite + `ChatContinuation`을 함께 사용한다.
- 검증 범위: heartbeat만으로 명령이 생기지 않음, 승인 후 claim 한 번, 누락/r14/r15/미지원 build 차단, 대기 명령 차단 후 최신 sync에도 재생하지 않음, UNKNOWN 전송은 executor 재생성 후에도 유지, 등록 session key 유지.
- 기존 정상 fixture 3개 파일도 확장 상수를 사용하므로 차후 서버/확장 버전 드리프트가 테스트를 통과할 수 없다.
- 로컬 Windows Node **v24.20.0**, `npm.cmd run check`: **284/284 PASS**, 0 failures. Node 22 Windows/Ubuntu GitHub Actions는 이 PR의 정확한 HEAD에 대해 별도 확인하고 PR 설명에 run/attempt/job 결과를 기록한다.

## 실제 Windows Chrome — REAL_ACCEPTANCE_PENDING

접근 도구의 브라우저 inventory에는 빈 in-app browser와 MCP Apps만 있으며 실제 Chrome 연결이 없다. 따라서 실행 중 확장/bridge 버전, 기존 시험의 DOM, 실제 전송·이관 성공을 검증하지 못했다. Windows에서 Node 테스트를 실행한 것은 Chrome acceptance가 아니다.

중단된 원본: `자동 이관 검증 1`, 오류 `SOURCE_MIGRATION_REQUEST_NOT_SENT_COMPOSER_MULTIPLE_VISIBLE`. 이 작업에서는 해당 대화에 접근하거나 원본 요청을 재전송하지 않았으며 실패 기록·등록·감시 상태를 초기화하지 않았다. 운영 DB와 Watchtower Registry도 변경하지 않았다.

필요한 실기기 증거는 **기존 등록 탭을 선택한 상태에서 `등록 대화 입력창 진단 (전송 안 함)` 1회 실행한 편집기별 구조 JSON**이다. 본문/초안/HTML/URL/자격 증명은 포함하지 않는다. 증거 수집 전 선택자 추가 수정, 실패 기록 초기화, 시험 재실행은 금지한다. 이 진단은 운영 확장 교체/재시작을 자동 허가하는 절차가 아니다.

## 다음 작업

WP-00 코드 상태: CODE_READY / REAL_ACCEPTANCE_PENDING. 정확한 PR HEAD Windows/Ubuntu CI 확인 후 WP-01의 읽기 전용 관찰 계약과 합성 fixture부터 진행할 수 있다. 실기기 DOM blocker와 WP-08 acceptance는 독립적으로 추적한다. WP-01 관찰기를 운영 송신 타이머에 연결하기 전에 WP-02/03의 판단·영속성·중복 방지 게이트가 필요하다.

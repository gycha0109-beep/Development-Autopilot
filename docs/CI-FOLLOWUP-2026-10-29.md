# CI 연동 후속 지시 — 2026-10-29 구현 기록

## 범위
- CI Watchtower / GitHub 읽기 전용 관측을 기존 Decision Gate와 연결해 후속 조치를 분류합니다.
- `APPROVED_RESUME`, `REQUIRE_APPROVAL`, `WAIT_CI_OR_MERGE`, `REVIEW_FAILURE`, `STOP_UNVERIFIED`를 작업축별 스냅샷으로 제공합니다.
- **실패·대기·불명 상태에서는 개발 진행 프롬프트를 자동 발송하지 않습니다.** 실패는 검토 대상으로 표시하며, 자동 수정 지시 생성/전송은 별도 승인형 기능입니다.
- 승인된 성공 후보는 Watchtower의 정확한 Repository/Track/Run/Attempt/Head SHA, GitHub의 PR/Head/필수 체크/병합 확인, Decision Gate의 사람 검토 결과를 하나의 `targetHash`로 고정합니다.
- 관리 화면의 'CI 재개' 체크박스는 후보가 있을 때만 선택 가능합니다. `ciResumeTargetHash`는 설정 저장 및 매번 전송 예약/claim 시 동일 근거인지 재검증합니다.
- 짧은 Decision Gate 검토 TTL 이후에는 동일 CI 근거에 대한 기존 승인 캠페인만 유지되며, 근거 변경 시 전송을 중단합니다.
- 이 기능은 새 CI 승인 없이 기존에 등록한 수동/주기 전송을 활성화하지 않습니다. 자동 병합/배포/로드맵 페이즈 완료 판정은 하지 않습니다.

## 실환경 현황
- 학원 PC에는 GitHub CLI 2.103.3을 설치했습니다. `gh auth status` 결과 미로그인 상태입니다. 사용자가 `gh auth login`을 완료해야 비공개 저장소·Branch Protection·Rulesets 검증을 할 수 있습니다.
- CI Watchtower 프로세스와 `127.0.0.1:48765` 브리지가 실행되지 않고, 전용 Windows Credential Manager 키도 읽을 수 없습니다. Watchtower 설치·실행·전용 브리지 발급은 미완료입니다.
- Watchtower 및 GitHub 검증 대상(정확한 Run ID, Attempt, PR, Head SHA) 매핑이 아직 없어 실CI 후속 지시를 자동 활성화하지 않았습니다.
- 기존 3개 Chrome 탭의 1회 프롬프트 전송 기록은 보존합니다.

## 검증
- `tests/ci-resume.test.js`: 정상 후보, SHA drift, CI 실패, PR 미병합, 인증 부재, 검토 만료, 타깃 변경, 예약 시 근거 변경 차단.
- `npm.cmd run check`로 전체 테스트 검증.
- 실환경 E2E: **보류** (Watchtower 실행/자격 증명, GitHub CLI 로그인, 정확한 작업축 타깃 필요).

## 다음 실제 연결 절차
1. 학원 PC에서 `gh auth login`을 사용자 계정으로 완료합니다. 토큰을 소스 코드/대화/로그에 복사하지 않습니다.
2. CI Watchtower 앱을 동일 Windows 사용자로 실행하고 전용 읽기 전용 브리지를 활성화합니다. Windows Credential Manager 전용 자격 증명을 확인합니다.
3. Autopilot에서 Watchtower Registry/Run, GitHub PR/Head SHA를 해당 작업축에 매핑합니다.
4. 양쪽 독립 증거 및 필수 체크/병합 검증이 성공하면 사람 검토를 기록하고 CI 재개 캠페인을 명시적으로 승인합니다.
5. 변경된 근거/승인 만료/Chrome 연결 해제/응답 생성 중/CI 대기 시 fail-closed 상태를 실기기에서 확인합니다.


## 2026-10-29 실제 Windows 연결 검증 완료 (추가)
- GitHub CLI 2.103.3: 현재 Windows 사용자 `M`의 `gycha0109-beep` 인증 및 읽기 권한 확인. 토큰 출력·저장 없음.
- CI WatchTower 0.3.39: `C:\Users\M\Downloads\ci-watchtower-windows\ci-watchtower.exe` 일반 모드로 실행. 로컬 브리지 `127.0.0.1:48765`에서 contract 1.0 health 성공.
- 전용 WatchTower Credential Manager 자격 증명은 UTF-16LE ASCII interleaved-NUL 인코딩으로 저장되어 있었음. `local/watchtower-credential.ps1`에서 유효한 UTF-16LE 패턴만 명시적으로 해독하고 UTF-8 fallback을 유지하도록 수정. 실제 bridge Authorization 요청 성공. 자격 증명은 출력·파일 저장하지 않음.
- WatchTower 자체 앱 명령으로 Project `pie` 및 `buildmap`, Repository `gycha0109-beep/Project_Intelligence_Engine`(ID 2) 및 `gycha0109-beep/BuildMap`(ID 3)를 등록. 원래 CI-Watchtower Repository ID 1 및 기존 프로젝트/Track은 유지.
- WatchTower 프로젝트 키는 소문자 정규화되므로 Autopilot의 기존 `PIE`/`BuildMap` Workstream 키와 대소문자 무시 매칭하도록 `local/watchtower-client.js` 수정.
- WatchTower Poll: PIE/BuildMap 저장소 모두 정상 수집 시작, 최신 successful poll 존재, poll error 없음. BuildMap에는 실제 `execution-map` Active Track이 나타남.
- GitHub Branch Protection의 `required_status_checks` endpoint는 양쪽 `main`에 `Branch not protected (HTTP 404)`로 응답하지만 rules endpoint는 정상. `local/github-verifier.js`가 오직 이 정확한 부재를 확인한 경우에만 빈 legacy protection으로 처리하고, Ruleset required checks를 독립 검증하도록 개선. 403/일반 오류는 여전히 fail closed.
- 실제 GitHub PR #105(PIE, HEAD `d11b216c...`) 검증: WatchTower Run `40819794723` FRESH SUCCESS + GitHub required checks verified + 미병합 → 통합 Gate `WAIT_EXTERNAL / PR_NOT_MERGED`.
- 실제 GitHub PR #96(BuildMap, HEAD `cf7765b5...`, Work Track `execution-map`) 검증: WatchTower Run `40827041501` FRESH SUCCESS + GitHub required check `Lint, typecheck, build` PASS + 미병합 → 통합 Gate `WAIT_EXTERNAL / PR_NOT_MERGED`. 이 결과는 다른 선택적 실패 체크를 무시하고 자동 병합/배포해도 된다는 의미가 아님.
- PR #81(BuildMap, HEAD `9962e4be...`)은 GitHub CI 일부 실패가 있지만 WatchTower의 해당 HEAD Run 샘플은 0건. 이 결과를 완전한 CI 근거로 간주하지 않음.
- 검증 대상 Workstream은 독립 생성해 실제 Gate를 확인한 후 삭제하였고, 기존 Chrome 작업축의 전송 설정/탭 매핑은 변경하지 않음.
- 테스트 `npm.cmd run check`: 327 tests PASS (GitHub 404 vs permission failure, Project key case handling 포함).
- 테스트용 WebView2 디버그 listener는 종료하고 WatchTower를 보통 모드로 재실행. 원격 디버그 포트 9431 Closed 확인, 임시 스크립트 삭제.
- 남은 작업: 각 실제 개발 대화가 어떤 PR/Run을 현재 담당하는지 명시적으로 연결하는 기능, CI 실패 시 승인된 수정 지시, 실제 assistant response 검증과 후속 CI 재조회. 위 사항 미완료 상태에서는 자동 계속 개발을 주장하지 않음.


## 2026-10-29 자동 프롬프트 35분 재설정 점검
- 기존 PIE, BuildMap, 개발 진행률 관제 1의 ChatContinuation 구성은 모두 `mode=manual, maxMessages=1, sentCount=1`로, 정기 전송이 전혀 활성화되지 않았음. 최초 세 건의 기록은 `SEND_BUTTON_CLICKED_UNVERIFIED`로, 답변 생성 완료를 입증하지 않음.
- 동일한 세 Workstream에 기존 승인 프롬프트 `로드맵 따라서 계속 진행`을 `mode=scheduled`, `intervalMinutes=35`, `hours=24`, `maxMessages=12`, `unlimited=false`로 재설정함. 별도 인지 없는 무제한 반복은 사용하지 않음.
- 정확한 예정 시간(KST): PIE 2026-10-29 17:21:42, BuildMap 17:21:42, 개발 진행률 관제 1 17:23:02.
- 확장 연결/서버 상태 정상, `scheduled` 설정은 로컬 서버 재시작 후에도 보존됨.
- 기존 관제 작업축의 로컬 Bridge 제목은 이전 제목으로 남아 있었지만 확장 옵션 화면에는 현재 연결된 탭 이름이 `개발 진행률 관제 1`로 등록됨. `extension/bridge-core.js`는 활성 등록 탭의 최신 표시 제목을 보고하도록 변경. Chrome 확장 재로드 전에는 기존 버전이 실행 중일 수 있음.
- 기록된 응답 관찰에서 BuildMap 및 관제는 메시지 ID 검증을 통과했음. PIE는 마지막 assistant 답변의 message ID 증명을 얻지 못하여 `UI ambiguous`, `contentComplete=false`로 fail-closed. 페이지 자체의 동작/원인에 대해서는 추가 확인되지 않았고 자동 전송 성공을 보장하지 않음.
- 타이머 도달 시 응답 증거가 없는데도 화면에 `armed`라고 표시하던 결함을 수정: `status=waiting,statusReason=RESPONSE_PROOF_REQUIRED`. 증거가 정상 관측되면 자동 예약 재평가 가능. 테스트 추가.
- `npm.cmd run check`: 328/328 PASS. 자동 전송 성공에 대한 실제 미래 일정 ACK는 아직 발생하지 않아 E2E 완료 아님.
- 현 단계의 주기 전송은 Chrome 응답 완료 검증에 기반하며, 정확한 Workstream ↔ CI PR/Run/Attempt 연결이 없어 CI 완료를 독립적으로 보장하는 기능은 아님.
- 임의 외부 웹 접근 차단 규칙을 우회하여 ChatGPT 페이지 내용을 확인하지 말 것. 해당 페이지 콘텐츠 검증이 필요하면 사용자가 직접 확인해야 함.

## 2026-10-29 17:00 이후 반복 전송 실기기 장애 수정
- 실데이터 확인: 기존 14:xx 전송 3건 이후 17:00까지 새 전송 0건. 세 설정은 이미 `scheduled`이지만 새 설정 `approvedAt`부터 35분 대기하도록 예약되었음 (17:21/17:23 예정). 기존 성공 전송과 설정 갱신을 구분하지 않은 UX 결함.
- 추가 실제 버그: `chat_response_observations.first_seen_at`이 Autopilot 프로세스 재시작 시각보다 오래된 정상 같은 fingerprint로 계속 이어져 `observationProof`의 `first_seen_at >= observationStartedAt` 제약을 영구히 통과할 수 없었음. `acceptObservation`의 `same` 결정에 `old.first_seen_at >= observationStartedAt`를 추가, 재시작 후 fresh two-sample stable window 재획득.
- 회귀 테스트: `tests/scheduled-response-gate.test.js` 새 테스트에서 재시작 직후 안전 차단, 이후 동일 fingerprint 두 번 재관측 후 정상 전송 가능 확인.
- `npm.cmd run check`: 329 tests PASS.
- 서버 재시작 후 Chrome의 fresh sample 수신: BuildMap/개발 진행률 관제 1 응답 완료 안전 검증 통과, PIE는 `currentRenderer:true,currentProof:false,hasMessageId:false,contentComplete:false,uiAmbiguous:true` 상태로 여전히 차단.
- 사용자가 승인한 기존 문구를 `send-now`로 요청: BuildMap `2026-10-29 17:08:29 KST`, 개발 진행률 관제 1 `17:09:30 KST`에서 확장 프로그램의 `SEND_BUTTON_CLICKED_UNVERIFIED` 영수증 수신. 답변 생성 완료까지는 검증되지 않음.
- 다음 자동 예약: BuildMap `17:43:29 KST`, 관제 `17:44:30 KST`; 각 직전 assistant 응답이 안정적으로 완료되어 새 reply fingerprint가 확인돼야 실제 전송. PIE 예약 17:21:42이나 현재 DOM 증거가 부족하여 자동 전송을 보장하지 않음.
- 테스트와 실기기 증거는 기존 Workstream의 GitHub CI 성공/PR 병합 승인과는 별도임. 비병합 PR로 개발 재개를 승인하거나 Web UI를 우회하지 않음.

## 2026-10-29 PIE 완료 감지 정적 수정 (사용자 화면 근거)
- 사용자가 제공한 PIE 스크린샷에서 완결된 assistant 보고서·표·하단 입력창이 보임. 스크린샷만으로 DOM 속성, 메시지 ID 또는 실제 폴링 안전성은 확정할 수 없음.
- 기존 `extension/chat-observer.js`는 현재 렌더러의 마지막 unit 하나만 검사하고, `[data-chatgpt-selection-message-id]`와 `[data-dil-source-message-id]` 두 래퍼의 존재/유일성을 둘 다 요구했음. 내용이 정상이어도 장식 unit 또는 선택/출처 래퍼 하나가 빠지면 false-negative 발생 가능한 구조.
- 기존 `data-content-search-turn-key` 안 마지막 assistant-unit을 선택하되 후행 user-unit 존재시 차단. 필수 unit ID + DIL 본문 ID + 정규 assistant markdown body + 유일한 state wrapper containment 유지. 선택/출처 래퍼는 부재 허용하되 존재하면 ID·포함 관계 일치 필수. 이 외 안전 신호(Stop, draft, busy, alert, CI wait, approvals)는 유지.
- 회귀 테스트: 없는 선택 래퍼/없는 출처 래퍼/후행 장식 unit 정상; 후행 user·중복 body·불일치 래퍼·정규 body 부재 차단; streaming 차단 유지. `tests/chat-observer-complete-dom.test.js` 포함.
- `npm.cmd run check`: 330/330 PASS.
- 브라우저 보안 제한 때문에 실제 ChatGPT 페이지 DOM을 직접 읽거나 우회 도구로 확인하지 않았으며 Chrome 확장 재로드/PIE 실전 전송은 **미검증**. 소스 변경은 학원 PC 확장 디렉터리에 저장됐고, 적용하려면 사용자가 Chrome 확장 관리 화면에서 해당 확장 재로드 필요. CI·실행 기록을 성공으로 허위 표기하지 않음.

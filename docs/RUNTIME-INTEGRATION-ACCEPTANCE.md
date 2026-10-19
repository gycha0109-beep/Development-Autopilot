# 운영 연결 조사 및 Windows 수락 기록

확인일: 2026-10-19 KST. 실제 전송·이관·배포·병합은 수행하지 않았다.

## 최신 부모 및 재검증

PR #49~56 모두 open/unmerged. #49 → #50 → #51 → #52 → #53 → #54 → #55 → #56의 스택이다.
이번 기능의 부모는 #56 `codex/wp07-fair-queues`, `ca28a916dc0b30c32a2eea5698e351101da56630`이다.
각 HEAD의 Autopilot CI 결론은 success였다. Run ID는 순서대로
38843335335, 39130151488, 39131465859, 39132046013, 39132691939, 39133167373, 39133982995, 39135606875.
부모를 Windows Node v24.20.0에서 다시 실행한 `npm.cmd run check`는 405/405 통과했다.

## 조사 시점의 세 가지 구분

| 연결 | 서버/Worker 실행 경로가 있는 코드 | 합성 구현만 있고 운영 경로에 없던 부분 | 미구현/미검증 |
|---|---|---|---|
| Chrome ↔ 서버 | 페어링·heartbeat·등록 매핑·명령 claim/ACK | 읽기 관찰기와 순수 분류 | 실제 최신 DOM 검증 |
| 판단 → 송신 | 승인 기간/횟수/간격과 SQLite 명령 큐 | AutopilotCoordinator/State가 server.js에서 생성되지 않음 | 완료 응답에 따른 운영 송신 연결 |
| CI | Watchtower localhost 읽기, GitHub CLI 검증·주기 refresh | coordinator의 별도 CI 대기/재검사 일정 | 채팅에서 PR/SHA/run/attempt 추출·자동 귀속, 실환경 검증 |
| 연결 오류 | 없음 | DisconnectRecovery 단계/의도/독립 증거 | 실제 중지/보고 Chrome 어댑터 및 운영 호출 |
| 이관 | 기존 Worker의 별도 opt-in 이관 경로 | MigrationContinuity의 검증 콜백 | 운영 검증 콜백, 실제 같은 탭·제목·일정 복원 검증 |
| 사용자 개입 | 없음 | OperatorInbox, FakeMessenger | 실제 메신저 인증·전송·명령 수신, 운영 Inbox 연결 |
| 다중 축 | 등록/기존 승인 송신 | fair queue와 1/3/10/20 합성 시나리오 | 실제 1/3/10/20 Chrome acceptance 및 장시간 운영 |
| 운영 배포 | localhost 소스 실행 | 기존 관리 화면 | Windows 배포 패키지·WP-09 제품 화면 완성 |

여기서 '실행 경로가 있는 코드'는 소스 연결의 확인이다. 실제 운영 PC에서 정상 실행됐다는 증거로 해석하지 않는다.

## 이번 변경으로 연결한 경로

`server.js → AutopilotRuntime → ChromeObservationTransport → 인증된 heartbeat의 observationRequests
→ 등록 물리 탭 검증 → captureChatObservation → 인증된 단일 challenge 응답
→ projectObservation → AutopilotCoordinator → AutopilotState/SQLite Operation ID
→ 기존 ChatContinuation queue/claim → Worker 최종 관찰·응답 지문 재검사 → 기존 전송기 → ACK`.

- 읽기 권한은 작업축별로 따로 허용한다. 기존 등록/승인/DB를 자동으로 재등록하거나 초기화하지 않는다.
- 서버는 물리 탭의 URL을 수신하지 않는다. Worker가 등록 URL, tab/window/group, browser epoch를 주입 전후 검증하며 지문만 반환한다.
- 관찰의 본문·사용자 초안·HTML·URL·provider 예외는 저장하지 않는다. 서버가 기존 whitelist로 재투영한다.
- challenge는 단일 클라이언트/작업축/세대에 한정한다. 서버 재시작, STOP, 취소, relink, 작업 버전 변경, 중복·늦은 응답을 거부한다.
- 관찰 시각은 서버의 요청 발급 시각이다. 브라우저 시각이나 늦은 도착을 새로운 증거로 취급하지 않는다.
- 안정화 최소 30초, 관찰 간격 60초, 신선도 180초, 읽기 timeout 80초. 송신 가능 시각은 기존 승인 간격을 그대로 사용한다.
- 용도별 영속 fair queue를 실제 생성한다. 읽기 동시성은 최대 20, 송신 시작 간격은 최소 1초다. 실제 Worker는 기존 1분 heartbeat당 최대 1건을 claim한다. 20건 동시 송신 성능을 주장하지 않는다.
- 기존 시간 기반 scheduled 승인은 관찰+실행 권한을 추가로 주기 전 송신할 수 없다. 기존 수동 1회 승인 경로는 유지한다.
- 관리되는 명령은 `observation-worker-1` capability가 있는 Worker만 claim할 수 있다. 확장은 0.4.33, composer 엔진은 변경 없는 r16이다.
- 최종 관찰이 초안·생성·다른 응답·경고·다른 탭이면 송신하지 않는다. 전송기에도 expectedPath를 전달해 주입 직전 대화 변경을 거부한다. 불명 결과는 재시도하지 않는다.
- CI 단서와 기존 명시적 대상 매핑은 기존 정확 일치 게이트 및 독립 CI 재검사로 연결된다. 매핑이 없으면 계속 진행을 보내지 않는다. Watchtower Registry/Track을 자동 수정하지 않는다.
- 비용·로그인·승인·오류는 기존 canonical Inbox에 저장하고 해당 축만 정지한다. 관리 화면에서 사유를 확인한다. 실제 메신저는 활성화하지 않는다.

## 아직 연결하지 않은 부분

연결 해제의 자동 stop/report 실행, length-limit 자동 이관의 coordinator 검증 콜백,
새 응답의 정확한 CI 식별자 취득, 장기 CI 경과시간별 escalation, 실제 메신저와 운영 Inbox 승인/거절/보류/재개 UI는 후속 기능 단위가 필요하다.
현재 recovery/handoff 권한을 runtime scope에 부여하지 않으므로 해당 경고는 CALL_OPERATOR → Inbox로 간다.
Inbox에서 요청을 확인했다는 이유로 비용·병합·재개 승인을 만들어내지 않는다.
미처리 Inbox 요청은 설정을 다시 켜도 송신을 차단한다. 요청 해결 워크플로는 후속 PR 대상이다.

## 테스트와 실제 Chrome 증거를 분리

새 테스트는 실제 서버 프로세스/HTTP/페어링/SQLite/운영 구성과 소유한 합성 DOM/Worker 어댑터를 사용한다.
이는 실제 ChatGPT 사이트에서 실행한 테스트가 아니다.
이번 변경의 Windows Node v24.20.0 `npm.cmd run check`: **428/428 PASS**, 실패 0.
Windows/Ubuntu Node 22 GitHub Actions의 최종 결과는 이 PR의 정확한 HEAD에서 별도 확인한다.

브라우저 도구에는 연결된 Chrome/CDP 탭이 없었다. Windows computer-use의 앱 목록에는 Chrome 창이 있었지만,
읽기 시도는 **현재 브라우저 URL을 정책 적용에 필요한 신뢰도로 확인하지 못했다**는 도구 차단으로 끝났다.
이후 브라우저 조작을 수행하지 않았다. 이전 테스트 탭을 복원했다고 가정하지 않았다.
실제 메시지 전송/이관 및 1/3/10/20개 실제 작업축 검증은 모두 NOT RUN이다.

## 사용자가 실행할 안전한 수락 순서

운영 배포 승인 전에는 기존 서버/확장을 교체하지 않는다. 아래 절차는 승인된 별도 테스트 환경에서 실행한다.

1. 이 PR 브랜치를 별도 검토 checkout에서 받고 `npm.cmd run check`를 실행한다. 기존 운영 DB를 삭제하지 않는다.
2. 테스트 전용 DB 경로를 지정해 `npm.cmd start`를 실행한다. 예: `$env:AUTOPILOT_DB = 'C:\Autopilot-Test\acceptance.sqlite3'`.
   기존 서버가 48173을 쓰면 동시에 실행하지 않는다. Worker의 localhost 주소는 48173 고정이므로 포트만 바꿔 실제 연결됐다고 간주하지 않는다.
3. 확장 0.4.33 로드/갱신은 사용자가 승인한 뒤 수행한다. 테스트용 Chrome 프로필·프로젝트·대화를 사용하며 실제 개발 탭의 초안을 변경하지 않는다.
4. 새 테스트용 기존 대화를 그룹/확장에 등록하고, 테스트 서버에 페어링하여 테스트 Workstream에 직접 매핑한다.
5. 관리 화면의 **읽기 관찰 허용**만 누른다. 다음 동기화(최대 약 1분) 후 snapshot의 autopilot.scopes에서 관찰을 확인한다.
   생성·완료·CI·길이·연결·개입·불명 fixture별 실제 UI와 지문/불리언 결과를 기록한다. 초안 내용은 보관하지 않는다.
6. 실제 전송은 사용자가 **테스트용 작업축·정확한 메시지·최대 횟수**를 명시적으로 허가한 뒤에만 수행한다.
   예: 메시지 `계속 진행`, 1회, 1시간, 1분 간격. 기존 송신 승인 후 **조건부 자동 진행 승인**을 별도로 누른다.
   두 관찰의 안정화 이후 실제 전송 1회와 Operation ID/command/ACK를 확인한다. 동일 응답 반복 및 서버 재시작으로 추가 전송이 없어야 한다.
7. CI는 테스트 저장소/PR/SHA/run/attempt를 직접 지정하고 pending에서 미송신·별도 재검사, success 후 필수 체크/검토 조건을 기록한다. GitHub CLI 인증과 Watchtower 연결은 사용자가 수행한다.
8. 연결 오류·길이 제한은 현재 Inbox 정지까지 검증한다. 자동 복구/이관 완료를 체크하지 않는다.
9. 위 단일 축을 통과한 뒤 3→10→20개를 순차 수행하고 다른 축의 초안/정지/CI가 독립적인지 확인한다.
   미구현 복구/이관/메신저 단계는 후속 PR 및 명시적 허가 후에 검증한다.

실제 전송·중지·이관 결과가 불명확하면 재시도/기록 초기화 없이 해당 축과 증거를 보존한다.

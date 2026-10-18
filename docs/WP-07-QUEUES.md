# WP-07 A — 공정 목적별 큐와 합성 동시 운영

2026-10-18 KST. 부모 PR #55 `6430c6f2151894e4ec0681ad93146579e82a8ebe`.
브랜치 `codex/wp07-fair-queues`. 실제 탭이 아닌 소유한 synthetic 작업축을 검증한다.

## 구현과 소유권

`FairWorkQueue`는 기존 WorkstreamStore BEGIN IMMEDIATE 위에서 목적별 정책/티켓을
`autopilot_queue_policies`/`autopilot_queue_tasks`에 저장한다. 콜백·원문·URL·실행 권한을 저장하지 않는다.
용도는 inspect / ci / dispatch / recovery / notify이다. 별도 동시성·최소 시작 간격·lease·backoff·오류 상한을
모두 명시해야 하며, 새 인스턴스가 기존 정책을 임의로 완화할 수 없다.

준비된 티켓은 아직 처리되지 않은 작업축 및 오래 기다린 작업축을 우선한다. 글로벌/개별 STOP은 새 행동을
차단하며 paused 작업축의 이전 티켓이 정상 작업축을 영구 점유하지 않는다. 알림은 의도적으로 paused인
작업축에도 전달할 수 있어야 하므로 notify는 개별 pause 예외이며 전역 STOP은 유지한다.
같은 리소스를 다른 작업축으로 바꿀 수 없다. 정책의 next-start 시각은 재시작에도 유지한다.

coordinator의 읽기/CI 갱신/기존 command queue와, recovery Stop/report 어댑터, Inbox fake 전달에
선택적으로 동일 큐를 주입한다. **큐는 기존 행동 intent/claim/ACK/UNKNOWN의 대체물이 아니다.**
메시지 예약의 at-most-once는 기존 명령과 완료 응답 ledger가 계속 보장한다.
다른 세션의 CI 성공이나 다른 binding으로 같은 작업축을 해제하지 않는다.

읽기 실패는 exponential backoff + 결정적 jitter + 상한 후 해당 리소스만 operator 대기이다.
쓰기 실패/lease 불명은 UNKNOWN이며 재실행하지 않는다. 만료 lease의 늦은 표본은 폐기한다.
실제 콜백에는 여전히 현재 등록/권한/STOP 검증이 필요하다. timeout은 abort를 요청하며 실제 제공자가
중단을 지원했다고 가정하지 않는다. recovery timeout은 큐 lease보다 짧아야 한다.

## 발견한 회귀와 수정

처음 20개 합성 시험은 80회 tick 내 19/20만 명령 후보를 만들었다.
읽기 큐 budget 대기가 별도의 dispatch 큐 재판단까지 막는 결합이 원인이었다.
새 DOM을 읽지 못해도 **기존 두 표본이 아직 신선하고 안정적일 때만** 같은 단일 엔진으로 재판단하도록
분리했다. 실제 읽기 실패·불명 표본·stale 표본은 계속 차단한다.
소비된 응답은 NO_ACTION이며, 더 이상 적격하지 않은 dispatch 티켓은 취소해 예산을 재사용하지 않는다.
초기 실패 재현: `node --test --test-name-pattern="20 synthetic" tests/autopilot-coordinator.test.js`.
runtime: Windows Node v24.14.0, stage: synthetic scheduling, expected 20, observed 19; 수정 후 PASS.

## 합성 검증

- 1 / 3 / 10 / 20개: 작업축마다 완료 응답당 정확히 한 command, dispatch 시작 간격 1초 이상,
  재시작 후 중복 없음. 이는 테스트 설정이며 실제 제공자 허용량/Chrome 성능 측정이 아니다.
- 20개 혼합: busy, CI binding 부재, 길이 경고, 연결 경고, 비용 승인, 읽기 실패 상한을 분리했다.
  정상 14개만 각각 한 command를 만들었고 다른 6개에서는 0건이다. 로컬 Inbox 4건, 전역 STOP 변경 0건.
- 4시간 **fake clock** 운영: 3개 작업축에서 승인된 12개 답변씩 총 36개 synthetic receipt,
  중간 재시작, 중복 0건, 승인 횟수 초과 0건. wall-clock 4시간 실험이나 실제 개발 완료가 아니다.
- 4시간 절전 fake clock: 새 안정 표본 없이 catch-up 전송 0건, 이후에도 글로벌 간격 준수.
- 큐별 예산/공정성, 두 SQLite handle 간 lease 경쟁, pending 취소, stale lease/늦은 결과,
  read-only backoff 상한, write UNKNOWN, immutable 정책, recovery/notification 목적 통합을 검증한다.
- 로컬 Windows Node v24.14.0 전체 `npm.cmd run check`: 405/405 PASS, failed/skipped 0.
  exact-head Windows·Ubuntu run/attempt/job 결과는 PR에 기록한다.

## 실기기 및 다음 gate

CODE_READY와 REAL_ACCEPTANCE_PENDING은 다르다. 운영 server/worker 진입점은 아직 이 coordinator를
생성하지 않으며 실제 observation/Stop/report/rebind/현재 승인 대상 어댑터와 Inbox UI도 미완성이다.
실제 Telegram은 설정하지 않았다. live 제어·기존 탭 재등록·원본 요청 재전송·실패 reset·배포·병합은 없다.
다음 WP-08은 기존 등록의 read-only 증거와 승인된 실제 어댑터를 확인한 뒤 진행한다.
실제 증거 없이 기본 운영을 켜거나 fake verified=true로 실기기 acceptance를 통과시키지 않는다.

# WP-03 — 독립 타이머와 조건부 전송

2026-10-18 KST. 부모 PR #51 `codex/wp02-decision-ledger`, `b108f4d50c6d475367c3949af174e78814da9342`.
작업 브랜치 `codex/wp03-conditional-scheduling`.

## 실행 구조

`AutopilotCoordinator`는 기존 ChatContinuation, Watchtower/GitHub observer, DecisionGate,
AutopilotState와 **호출자가 제공하는 읽기 전용 observe 어댑터**를 연결한다.
기본 브라우저 어댑터나 운영 서버 진입점은 제공하지 않는다. 운영 등록·메시지·권한을 자동 변경하지 않는다.

사용자가 이미 승인한 scheduled ChatContinuation 캠페인에 대해 별도로 관찰/실행 capability,
정확한 bindingFingerprint, remainingWork, 검사/CI/안정화/timeout 정책을 명시해야 configure가 가능하다.
설정은 새 `autopilot_schedules` 테이블에 저장하며 기존 승인 문구/기간/횟수/근거를 복사해 새 승인으로 만들지 않는다.
각 판단 시 기존 ChatContinuation 설정을 다시 읽는다. task revision 변경은 재설정 없이 허용되지 않는다.

- `next_inspect_at`: DOM/응답 읽기 시각.
- `next_external_check_at`: WAIT_CI/CHECK_CI의 별도 Watchtower/GitHub 검사 시각.
- `nextEligibleDispatchAt`: 기존 승인 캠페인의 `next_due_at`을 읽는 전송 가능 시각.

관찰 시각 도래는 전송 명령이 아니다. CI는 기존 observer를 통해 갱신하고 정확한 gate 결과를 재판단한다.
동일 시각의 여러 갱신은 합치며 CI 타이머가 응답 검사/전송 시각을 앞당기지 않는다.
관측 없이 외부 근거만 변경된 경우 같은 관측의 결정을 재평가하되 안정화/신선도는 다시 검증한다.

## 전송 경계

관리 대상으로 명시된 작업축은 기존 `chat.tick()`/manual queue만으로 전송되지 않는다.
CONTINUE 결정 → SQLite 응답 예약 commit → 기존 `ChatContinuation.queue()` 순서다.
command 생성과 예약-command 연결은 기존 queue 트랜잭션 안에서 원자적으로 저장한다.
claim 전에 최신 관측·scope·STOP·CI·현재 reply/binding을 다시 검사한다.
초안/다른 답변/오래된 관측/다른 attempt가 나타나면 기존 command를 blocked로 종료하며 재전송하지 않는다.
이후 ACK/claim timeout/UNKNOWN은 기존 ChatContinuation의 의미를 유지한다.

이전 미관리 캠페인은 **자동 enrollment하지 않는다**. 기존 동작과 새 관리 범위를 혼동하지 않는다.
운영 서버/worker는 아직 coordinator를 생성하지 않으므로 이 PR은 기존 운영 예약을 변경하거나 무인 루프를 켜지 않는다.
실사용 전에 승인된 실제 observation source와 운영 진입점을 연결하고 실제 Chrome acceptance가 필요하다.
관측기는 읽기 전용이며 timeout 후 늦게 도착한 표본은 처리하지 않는다.
한 작업축의 실패는 다른 작업축을 중지하지 않는다. durable 공정 큐/전체 rate budget은 WP-07에서 추가한다.

## 검증

- 직접 coordinator/기존 continuation/SQLite: 31/31 PASS.
- CI 장기 대기 중 메시지 0건, 정확한 성공 후 1건, PR 미병합/다른 Track·attempt/stale/unavailable 차단.
- 관찰/CI/전송 독립 시각, 중복 tick, 독립 실패, claim 직전 초안/응답/근거 변경, 재시작·UNKNOWN·동일 응답 중복 방지.
- 4시간 절전 후 밀린 전송 없음, 만료된 승인은 유지.
- stale fixture가 실제로는 아직 fresh였던 테스트 1건을 수정해 진짜 stale 시각과 갱신 결과를 입력했다.
- 로컬 Windows Node v24.14.0 `npm.cmd run check`: 357/357 PASS. exact-head Windows/Ubuntu CI는 PR에 기록한다.
- 실제 Windows Chrome: NOT RUN / REAL_ACCEPTANCE_PENDING. 기존 중단 이관 시험 보존.

다음: WP-04는 실제 DOM을 추측하지 않고 stop → 확인 → 보고 → 재판단의 영속 단계를 fake 어댑터로 먼저 검증한다.

# WP-02 — 단일 행동 결정과 완료 응답 예약

2026-10-18 KST. 부모 PR #50 `codex/wp01-readonly-observer`, `d213578f4d058ce90ad7eeeab8416024a834359b`.
작업 브랜치 `codex/wp02-decision-ledger`. 운영 DB/Chrome/Watchtower를 변경하거나 이관을 재실행하지 않는다.

## 구현과 계약

- `local/autopilot-decision.js`: 순수 `decideNextAction()`은 정확히 하나의 nextAction과 reasonCode,
  관측/응답/행동 지문, evidenceRefs, nextCheckAt, authorizationRequired를 반환한다.
  STOP → 미정리 실행/사람 대기 → 승인/등록/관측 → 연결/길이 → CI → 안정화/전송 시각 순으로 차단한다.
  UNKNOWN·사용자 초안·생성 중에는 후속 메시지를 허용하지 않는다.
- CI는 기존 `decideGate()`의 정확한 Project/Track/repo/PR/SHA/run/attempt/신선도/병합/체크 판정을 사용한다.
  새 CI 판정 구현이나 Watchtower 귀속 변경을 추가하지 않는다. 대기/불명은 WAIT_CI/CHECK_CI이다.
  CI가 성공해도 review 또는 기존 캠페인의 동일 evidenceHash 승인이 없으면 CALL_OPERATOR이다.
- WP-01 분류에 `assistantStable`을 추가한다. CI 문구는 계속 조회 단서이며, 동일 답변이 안정화됐다는 사실과
  CI 완료 증거를 분리한다. 따라서 CI 완료 후 과거 대기 문구가 남아 있어도 별도 근거로 다음 판단이 가능하다.
- IPC/저장의 단일 `projectObservation()` whitelist로 원문·URL·초안·오류 메시지를 제거한다.

## SQLite 변경 (로컬 additive, 운영 미적용)

`AutopilotState`는 기존 WorkstreamStore의 연결/BEGIN IMMEDIATE/event를 재사용한다.
추가 테이블 `autopilot_observations`는 관측/단일 결정 JSON과 task revision을 보존한다.
`autopilot_response_claims`는 외부 행동 전 operation ID와 지문을 저장한다.
중복 키는 **workstream + binding + reply**이며 승인·task revision 변경으로 같은 답변을 재생하지 않는다.
예약 시 최신 승인/시각/STOP/작업축/기존 명령/근거를 재판단하고 예상 행동 지문을 대조한다.
이전 queued/claimed/unknown ChatContinuation 명령도 차단한다.

예약 직후 프로세스가 종료되면 명시적 `reconcile()`이 UNKNOWN으로 전환한다. 재시작 사실만으로 다시 예약하지 않는다.
이 함수는 향후 서버가 localhost 포트를 독점한 후 호출해야 한다. 새 인스턴스 생성만으로 복구를 실행하지 않는다.
UNKNOWN은 과거의 행동을 안 했다는 증거가 아니므로 자동 해제하지 않는다.
새 reserved/unknown 예약이 있으면 기존 workstream 삭제 API도 삭제를 차단한다.

이 레코드는 기존 command claim/ACK를 대체하지 않는 **완료 응답별 소비 기록**이다.
WP-03에서 승인된 ChatContinuation queue/claim/ACK와 연결한다. 현재 worker/서버/예약기 활성화는 없다.
workstream 상태 enum, 기존 등록 관계, API 응답 필드는 변경하지 않는다.

## 검증 및 남은 작업

- 직접 검사: 관찰/결정/SQLite/삭제 회귀 65/65 PASS.
- 표: STOP, scope 만료/revision 불일치, 생성 중, 초안, quota/승인/목표 완료 주장, 미연결 CI,
  CI queued/running/PR 미병합, 다른 Track/SHA/run/attempt, stale/unavailable, 동일 review 지문을 검증.
- SQLite: intent 전 기록, 두 연결의 경쟁, 동일 응답 반복/승인 갱신/revision 변경, 재시작 UNKNOWN,
  최신 관측 보호, 원문 비저장, 다른 작업축 격리, 기존 스키마 보존을 검증.
- 로컬 Windows Node v24.14.0 `npm.cmd run check`: 347/347 PASS. exact-head Windows/Ubuntu run/attempt/결과는 PR에 기록한다.
- 실제 Windows Chrome: 미실행 / REAL_ACCEPTANCE_PENDING. 합성 성공이 실기기 성공은 아니다.
- 다음: WP-03 관찰/CI/전송 시각 분리, fake clock CI 재검사, 기존 ChatContinuation과 조건부 단일 명령 통합.

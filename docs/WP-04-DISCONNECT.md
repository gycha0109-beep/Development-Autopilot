# WP-04 A — 단계별 연결 해제 복구 계약

2026-10-18 KST. 부모 PR #52 `a7fe8d04a669eb2bf9f7efe2a30de0ceabed0701`.
브랜치 `codex/wp04-disconnect-stages`. **합성 어댑터 단계 구현이며 실제 Stop/보고 어댑터는 미구현**이다.

`DisconnectRecovery`는 단일 결정 엔진이 RECOVER_DISCONNECT로 판정한 동일 작업축/등록 관측에서 시작한다.
기존 WorkstreamStore의 operations와 events를 재사용하며, 로컬 additive `autopilot_recoveries`에 단계와
episode/승인/보고 문구 지문, attempt, cooldown을 저장한다. 보고 본문/원문/URL/토큰은 저장하지 않는다.
normal scope 검사는 기존 결정 엔진과 공통 `scopeProblem()`을 사용한다.

`RECHECK_WARNING → STOP_INTENT_RECORDED → STOP_RESULT_PENDING → STOP_RESULT_VERIFIED →
REPORT_INTENT_RECORDED → REPORT_RESULT_PENDING → REPORT_RESPONSE_VERIFIED → DONE + 재판단`.

각 호출은 한 단계만 전진한다. 클릭/보고 전 operation intent를 commit하고 그 ID를 어댑터에 전달한다.
클릭 ACK는 중단 완료가 아니다. 동일 operation/binding의 신선한 독립 verifyStopped 증거가 필요하다.
보고 ACK 역시 응답 완료가 아니다. 새로운 답변의 두 안정 표본과 독립 verifyReport 출처 증거가 필요하다.
최종 nextAction은 기존 결정 엔진이 다시 산출하며, recovery는 직접 '계속 진행'을 전송하지 않는다.
CI/승인/비용/사용량 제한·초안·모순·scope 변경·STOP은 자동 계속 진행으로 이어지지 않는다.

클릭/보고 불명은 UNKNOWN이며 재전송하지 않는다. intent 상태로 재시작하면 명시적 reconcile이 UNKNOWN으로
처리한다. 독립 검증을 기다리는 단계에서는 읽기만 가능하다. 늦은 ACK/증거가 다른 컨트롤러의 UNKNOWN이나
다른 episode를 되살리지 않는다. attempt 상한, cooldown, 단계 timeout은 명시적 정책이다.
중단 전 경고가 사라지면 클릭 없이 DONE이다. active/UNKNOWN recovery는 정상 후속 예약과 작업축 삭제를 차단한다.

검증: `tests/disconnect-recovery.test.js`의 12개 시나리오, 기존 결정/저장 검증과 함께 실행.
정상 순서, 사라진 경고, 독립 중단 증거 부재, 잘못된 ACK/유실/재시작, 불명 보고, 보고 출처 부재,
보고 후 WAIT_CI/사용자 호출, quota/초안/Stop 모호/충돌/만료/STOP, timeout, 늦은 ACK, cap/cooldown/격리를 다룬다.
로컬 Windows Node v24.14.0 `npm.cmd run check`: 369/369 PASS. exact-head Windows/Ubuntu CI는 PR에 기록한다.

## 명시적 미완성 / REAL_ACCEPTANCE_PENDING

- 이 클래스는 운영 coordinator/worker에서 자동 호출하지 않는다.
- 실제 Chrome Stop selector나 보고 전송기를 추가하지 않았다. 승인된 Stop/report/독립 검증 어댑터가 모두 없으면 생성부터 거부한다.
- fake의 verified=true는 프로토콜 테스트용이며 실제 DOM·중지·보고 전송/응답의 증거가 아니다.
- WP-04 B의 coordinator/실제 ChatContinuation 보고 어댑터 연결은 실제 경고/Stop DOM 소속과 보고 응답 출처 계약을 확인해야 한다.
- 중단된 `자동 이관 검증 1`의 원본 요청/실패/등록은 그대로이며 DOM 진단 전 selector를 추측하지 않는다.
- 실제 Windows Chrome: 미실행. 다음 독립 작업은 WP-05의 기존 이관 계약 조사와 WP-06 로컬 Inbox/fake messenger다.

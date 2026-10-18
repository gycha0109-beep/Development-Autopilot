# WP-06 A — SQLite Inbox와 가짜 인증 메신저

2026-10-18 KST. 부모 PR #54 `26c0215b64a39e68da246385067d3cc05ba77b1a`.
브랜치 `codex/wp06-local-inbox`.

`OperatorInbox`는 전송 없는 로컬 요청을 canonical SQLite `operator_requests`에 저장한다.
요청 ID/작업축/revision, 비용·로컬 테스트·로그인·승인·복구·CI·설계 분류, 정확한 행동 지문/SHA,
evidence/만료 시각, 상태, 확인 시각, 전달 attempt/receipt를 보존한다. 같은 행동 요청은 중복 생성하지 않는다.
요청은 해당 workstream의 기존 paused 값을 켜며 다른 작업축이나 전역 STOP을 바꾸지 않는다.
조회는 nonce·signature·본문을 반환하지 않고, 확인(acknowledge)은 승인이 아니다.

관측의 선택적 `humanActionCategory`는 기본 원문 대신 최소 분류 결과다. 기존 cue 판정과 같은
단일 collector에서 산출/whitelist하며 기존 fixture의 필드 부재는 null이다. 임의 언어/요청을 완전히 탐지한다고 주장하지 않는다.
Inbox를 주입한 coordinator는 CALL_OPERATOR를 해당 분류/정확한 현재 SHA(있을 때)에 묶어 기록한다.
기존 ChatContinuation과 AutopilotState도 pending 요청을 검사하므로 paused만 해제해서 우회할 수 없다.

## 가짜 메신저 계약

`FakeMessenger`는 네트워크/외부 계정/토큰 없이 메모리에서만 전달하고, 임시 HMAC 키로 테스트
발신자/본문을 인증한다. 실제 transport는 구현하지 않았으며 deliver는 fake만 허용한다.
발신자 allowlist는 기본 비어 있다. 앱/AI가 임의 가입자를 실제 허용 목록에 추가하지 않는다.

발송 전 delivery intent를 기록하고, 신선한 nonce의 hash만 SQLite에 저장한다. 성공 ACK는 정확한
delivery ID가 필요하다. 확실히 전송되지 않은 경우에만 최대 3회까지 재시도 가능하며, 불명/크래시 상태는
UNKNOWN으로 유지한다. 늦은 ACK가 재시작 UNKNOWN을 되살리지 않는다.
메신저 미연결에도 로컬 요청/개별 pause는 유지되고 다른 작업축은 계속할 수 있다.

인증된 `status / hold / resume / approve / reject`는 요청·행동·SHA·revision·만료·nonce를 대조한다.
변경 명령 ID를 저장해 재생을 차단하고 approve/reject는 nonce를 소비한다.
resume은 Inbox hold만 풀며 승인·전역 STOP 해제·작업축 unpause·실제 실행을 하지 않는다.
approve도 승인 상태만 기록한다. 이후 독립 currentTarget 어댑터의 신선한 현재 action/SHA/revision 검증과
전역 STOP 확인 후 `consumeApproval()`이 한 번만 영수증을 반환한다. 기본 어댑터 부재 시 소비를 거부한다.
이 영수증은 실제 결제/권한/merge/deploy 실행기가 아니다. 해당 실행기 연결과 별도 승인 경계는 미구현이다.
로컬 close는 요청을 기록 보존한 채 취소할 뿐 승인하거나 unpause하지 않는다.

## 검증 / 남은 통합

- 직접 Inbox/관찰/coordinator 회귀 49/49 통과 후, 전달 중 재시작/늦은 ACK 회귀를 추가했다.
- 발신자 위조/변조/미허용, 다른 행동/SHA/revision/nonce, 만료/중복 명령/중복 승인,
  stale/unverified 현재 target, 전역 STOP, 원문·nonce 비노출, 전달 중복/불명/재시도 상한, 작업축 격리를 검증한다.
- 로컬 Windows Node v24.14.0 전체 `npm.cmd run check`: 386/386 PASS. exact-head Windows·Ubuntu 결과는 PR에 기록한다.
- 실제 Windows Chrome/Telegram: 미실행. Telegram 토큰/가입자/권한/비용은 설정하지 않았다.
- 운영 서버/HTTP/Inbox UI와 실제 메신저 연결은 아직 없다. 이 슬라이스는 SQLite와 fake transport 및
  주입된 coordinator 소비 경로다. 가짜 인증 성공을 실제 메신저 인증/무인 관제 성공으로 표시하지 않는다.
- 다음 독립 구현은 WP-07 공정 큐/속도 제한/재시작 격리의 1→3→10→20 합성 검증이다.

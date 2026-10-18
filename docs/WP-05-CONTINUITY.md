# WP-05 A — 기존 이관과 로컬 관측 연속성

2026-10-18 KST. 부모 PR #53 `07f378cfae90cb700385b1652c33dd31ecda7b51`.
브랜치 `codex/wp05-migration-continuity`. 기존 source-first/same-tab 이관기를 재사용한다.

## 연결과 불변 조건

기존 `ChatContinuation.pauseForMigration()` 트랜잭션에서 관리 대상의 관찰/CI 시각과 binding,
workstream/task revision, extension/session key, 승인 캠페인·CI target 지문을 로컬 SQLite에 checkpoint한다.
검사는 disabled가 되며 기존 캠페인 정지는 이전 로직이 처리한다. 반복 pause는 최초 checkpoint나 실패를 덮어쓰지 않는다.

`MigrationContinuity.verifyRebind()`는 별도 read-only 증거 어댑터가 있을 때만 새 binding을 수용한다.
필수: 동일 migration ID·작업축·extension/session·원본 binding, 같은 물리 탭/프로젝트, 원본 작성,
새 첫 답변, 제목 N+1, 감시 유지, 신선한 관측이다. campaign/PR/Run/Attempt/Track 설정 지문이나
scope/task revision이 변경되거나 만료/STOP/다른 미완료 실행이 있으면 복원하지 않는다.

기존 `resumeAfterMigration()`이 검증 상태를 확인한 뒤 기존 승인 캠페인을 재개하고, 같은 트랜잭션에서
관찰/CI 시각과 새 binding을 복원한다. 만료·횟수·문구 승인을 새로 만들지 않으며 기존 Track/등록/감시를 변경하지 않는다.
오래된 검사 시각은 안전한 재검사로 이동하며 밀린 전송을 만들지 않는다. source 완료 응답 소비 기록도 보존한다.
old/new binding이 달라야 하며 첫 새 관측은 기존 안정화 표본으로 처리하지 않는다.

`extension/migration-auto.js`는 `MIGRATION_OBSERVATION_BINDING_REQUIRED`를 받으면 resume_pending에
머문다. 이 상태의 재확인은 localhost 읽기/재개 게이트 검사뿐이며 source/target 메시지나 채팅 생성은 재시도하지 않는다.
이를 완료 또는 무인 성공으로 표시하지 않는다. 원본 실패 needs_attention/UNKNOWN의 reset은 추가하지 않았다.

## 검증과 경계

- 신규 로컬 continuity 4개 테스트는 누락된 same-tab/project/source/reply/title/watch 증거,
  stale proof, scope 만료/변경, 다른 CI target, UNKNOWN checkpoint, 타이머 보존을 검사한다.
- 기존 자동 이관 suite에 binding 대기 중 source/target 재전송 0건 및 검증 후 단일 재개 회귀를 추가했다.
- 직접 continuity + 기존 자동 이관 58/58 PASS. 로컬 Windows Node v24.14.0 `npm.cmd run check`: 374/374 PASS. exact-head Windows·Ubuntu 결과는 PR에 기록한다.
- 새 실제 DOM 선택자는 없다. 기존 source-first/same-tab/제목 판정과 이관 기록을 재작성하지 않는다.
- 실제 verifyMigration 어댑터는 없으며 fake proof는 protocol 검증이다. 운영 coordinator/worker 활성화, 실기기 검증은 미완료다.
- 기존 `자동 이관 검증 1`은 미재전송·미초기화·미재등록이며 DOM 진단 대기다.
- 다음 독립 작업: WP-06의 로컬 Inbox와 fake messenger. 실제 Stop/report/rebind 어댑터와 WP-08은 수동 증거가 필요하다.

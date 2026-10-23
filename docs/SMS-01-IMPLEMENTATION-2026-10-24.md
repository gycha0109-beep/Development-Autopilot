# SMS-01 — 블로커·승인 알림 의도 영속화

> 2026-10-24 KST · **구현 코드 범위: SMS-01만**. 설계/로드맵: [Autopilot PR #84](https://github.com/gycha0109-beep/Development-Autopilot/pull/84). 기준 코드: [Autopilot PR #83](https://github.com/gycha0109-beep/Development-Autopilot/pull/83).
> **SMS 실발송 없음. 수신번호/제공자/API 키/발신번호 등록 없음. 승인 회신 자동처리 없음.**
> Watchtower/Chrome/PIE/PR 병합/실계정 Windows 설치 대상 변경 없음.

## 구현

- 신규 `local/notification-intents.js`를 공통 원장으로 도입했습니다. `notification_intents`는 기존 DB에 **additive `CREATE TABLE IF NOT EXISTS`**로 추가되며 SQLite `STRICT`/외래키/사건별 UNIQUE 키를 적용합니다. 기존 `ci_alert_outbox` 및 `operator_requests`를 수정/삭제/초기화하지 않습니다.
- SMS-01 원장 행: `intentId`(해시), `sourceKind`(`blocker`, `approval`, `pause`), `sourceKey`(불투명 사건 ID), `sourceRevision`, `workstreamId`, `severity`, `reasonCode`, `state=pending|coalesced`, `coalescedInto`, `createdAt`. 전화번호, API 토큰, ChatGPT 응답, 전체 action fingerprint, nonce, 문자 본문은 없음.
- `CiIncidentLedger.addBlocker`: **새 일반/critical 블로커 1건**부터 intent 1개. 동일 블로커 반복 폴링은 0건 추가. Resolve→재발생은 같은 키의 다음 세대(`sourceRevision`)로 별도 알림.
- 자동 생성 `CI_RETRY_EXHAUSTED`: 실제 executor가 받아 적립한 두 보정 횟수가 소진된 후 다음 검증된 RED에서 블로커와 intent가 함께 발생. CI 폴링만으로 횟수가 증가하지 않습니다. 과거 `SUPERSEDED` 기록은 RED 사건으로 취급하지 않습니다.
- `OperatorInbox.open`: 최초 승인 요청과 **실제로 재개된 요청**에 intent 각 1개. 동일한 pending 요청 재조회는 알림 추가 없음. 새 요청은 기존대로 **첫 건부터 해당 Workstream 즉시 paused**; 3건 문턱으로 약화시키지 않습니다.
- `CiIncidentLedger.holdIfNeeded`: 3건 또는 critical 중지 시 기존 `ci_alert_outbox`의 pause episode row를 그대로 저장하며 새 `pause` intent를 연결합니다. 같은 `addBlocker` 호출에서 발생한 최초 블로커 알림이 있으면 `pause.state=coalesced`로 연결되어 **문자 발송 후보는 최초 블로커 한 건**만 남깁니다. 사용자가 직접 발생시킨 독립적인 중지 사건은 `pending`일 수 있습니다.
- 세 개의 원본 이벤트(블로커·요청·중지)와 알림 intent는 같은 SQLite 트랜잭션에서 commit 또는 rollback됩니다. 스케줄러의 독립 `holdIfNeeded` 호출도 트랜잭션을 사용합니다.
- `GET /api/v1/snapshot`의 `ciSupervision.notifications`는 **최대 최신 200건의 읽기 전용 표시**이며, 관리 화면에 `SMS-01 알림 의도 …건 · 실제 문자 전송 비활성`을 출력합니다. 표시된 `pending`은 발송 의도 대기이고 SMS 송신/접수/수신 성공이 아닙니다.

## 안전 불변식

| 경우 | 기록 결과 | 실제 동작 |
|---|---|---|
| 일반 블로커 1건 | `blocker/pending` 1건 | SMS 0회; 기존 중지 문턱 유지 |
| critical 블로커 1건 | `blocker/pending` + `pause/coalesced` | 해당 Workstream 즉시 PAUSED, 문자 0회 |
| 서로 다른 블로커 3건 | 블로커 의도 3건 + episode 1건 (마지막 사건과 coalesced) | 해당 Workstream PAUSED; 다른 축 독립 |
| 최초 승인 요청 1건 | `approval/pending` 1건 | 해당 Workstream 즉시 PAUSED; 승인/자동 실행 0회 |
| 같은 pending 승인/블로커 반복 | 변화 없음 | 중복 저장 0회 |
| resolve/close 이후 재발생 | 새 `sourceRevision` | 과거 의도 변경 없음, 자동 재개 0회 |
| SQLite 트랜잭션 실패 | 원본과 intent 함께 rollback | 발송 0회 |
| 마이그레이션 전 존재하던 outbox | 기존 row 그대로 | 과거 사건을 재발송 의도로 일괄 역산하지 않음 |

## 테스트·수락 경계

- `node --test tests/notification-intents.test.js`는 이벤트 중복, 3건/critical, 승인 재개 revision, 실제 수락된 보정 횟수, 트랜잭션 rollback, 기존 스키마 보존, **20개 독립 Workstream 동시 호출**, SQLite 파일 종료/재시작을 검사합니다.
- `npm run check`는 새 모듈 문법 검사와 기존 전체 테스트를 포함합니다. 실제 Windows 설치본 DB 마이그레이션·SMS 제공자 전달·휴대폰 수신은 이 테스트의 범위가 아닙니다.
- 운영 `D:\cha\Development-Autopilot` SQLite, 사용자 Chrome/Watchtower Credential Manager, 실제 SMS 서비스는 사용하지 않았습니다.

## 다음 단계

**SMS-02**는 `pending` intent에 대한 **별도 영속 송신 시도 원장**, 독립 idempotency key/lease, fake SMS provider, 장애·타임아웃 `UNKNOWN` 블라인드 재전송 금지, 수신자/요금 상한 설계를 구현합니다. 실제 서비스 자격증명/번호를 자동 발굴하거나 등록하지 않습니다.

**SMS-03/04**는 사용자가 명시적으로 제공자를 선택하고 본인 수신번호, 발신계정, 요금 한도, 실제 1건 canary를 승인한 후에만 실행합니다.

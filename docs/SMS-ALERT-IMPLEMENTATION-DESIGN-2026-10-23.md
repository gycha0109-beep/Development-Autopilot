# SMS 블로커·승인 알림 — 구현 설계 및 실기기 수락 계약

> 계획 기준: 2026-10-23 KST. **이 문서의 추가는 실제 SMS 구현, 발송 또는 전화번호 등록을 의미하지 않습니다.**
> 관리 주체: Development Autopilot. Watchtower는 CI 증거 관측만 담당하며 SMS·승인·작업 재개를 수행하지 않습니다.
> 상위: [통합 로드맵](CI-WATCHTOWER-CONSOLIDATED-ROADMAP-2026-10-23.md) · [전체 로드맵](ROADMAP.md) · [상세 구현 로드맵](AUTOPILOT-IMPLEMENTATION-ROADMAP.md) · [운영 정책](OPERATING-POLICY.md).

## 1. 사용자 경험 및 1차 범위

목표는 사용자가 PC 앞에 없을 때 실제 Workstream에서 **새 블로커 또는 승인 요청이 생기면 휴대폰으로 단 한 번의 명확한 알림**을 받고, 안전하게 문제를 확인하는 것입니다. SMS를 받거나 문자에 단어를 회신했다는 사실만으로 **작업 승인·STOP 해제·매크로 실행·GitHub PR 병합·결제·프로덕션 배포**가 이루어지지 않습니다.

초기 출시 범위는 **발신 전용(outbound-only) SMS 알림**입니다. 승인·거절·재개는 기존 인증된 **같은 출처(localhost) Operator Inbox**에서 명시적으로 수행합니다. 휴대폰에서 원격으로 승인하는 기능은 별도의 인증된 원격 운영 채널이 승인·구현·보안 검증된 후에만 검토합니다. PC의 localhost URL을 문자에 넣어 휴대폰에서 접근할 수 있다고 가정하지 않습니다.

비목표: 무인 SMS 회신 해석·문자 송신자 번호만으로 인증, 문자 내용으로 프롬프트/소스/로그 전달, Watchtower가 SMS를 직접 발송, SMS 발송 성공을 개발 작업 완료로 표시, 임의 비용 발생.

## 2. 현재 구현과 누락 (2026-10-23 코드 기준)

| 영역 | 기존 코드/계약 | 확인된 상태와 한계 |
|---|---|---|
| CI 사건·보정 | `local/ci-incident-ledger.js`: `ci_failure_incidents`, `ci_repair_receipts`, `acknowledgeRepair` | 실패 사건·승인된 operation ID별 최대 2회 보정 영수증 저장. **실제 보정 실행기 연결은 별도 작업** |
| 블로커 정지 | 같은 파일의 `ci_blockers`, `ci_pause_episodes`, `holdIfNeeded` | 개별 작업축의 미해결 블로커+승인 3건 또는 critical 1건에서 중지. 다른 축 전역 중지 아님 |
| 정지 알림 의도 | `ci_alert_outbox`의 `alert_key` 유니크, `pending/sent/unknown` | **에피소드별 저장/중복 의도는 존재**하나 실제 발송자·제공자 응답·안전한 재전송은 미연결 |
| 승인 요청 | `local/operator-inbox.js`: `operator_requests`, `operator_command_receipts` | 최초 요청부터 해당 축 정지·dedupe·기한·지문·revision·local approval 검증. **신규 요청을 SMS 의도로 연결하지 않음** |
| 메신저 테스트 | `local/fake-messenger.js`, `OperatorInbox.deliver/receive/reconcile` | `fake`에만 발신 허용. `recorded→unknown` 복구와 원격 서명·nonce의 **합성 테스트**, 실제 SMS 인증/발송 아님 |
| UI | `local/server.js`, `local/public/app.js` | 대기 알림 수·블로커/승인 현황 관측. **문자 도달 증명은 없음** |
| Windows 실환경 | Watchtower #68 ↔ Autopilot #83 | 같은 PC의 인증/연결/중단/재시작 **읽기 전용 검증**. 실제 SMS와 명하·사주 CI 알림은 미검증. PR은 미병합 |

기존 `ci_alert_outbox`와 `operator_requests`를 지우거나 대체하지 않습니다. 메시지 발송 전에 새 전송 원장(ledger)을 **추가적·버전 관리된 마이그레이션**으로 붙입니다. 이미 있는 중복 저장 기능을 '미구현'이라고 다시 만들지 않습니다.

## 3. 정확한 트리거와 중복·중지 정책

| 관측 이벤트 | 알림 생성 | Workstream 판단/제약 |
|---|---|---|
| 새 일반 블로커 1건 | 해당 **새 사건**에 1회 의도 생성 | 기존 중지 정책은 별개. 진행 불가 작업은 해당 안전 게이트에서 차단 |
| 새 critical 블로커 1건 | 즉시 우선 알림 1회 + 중지 에피소드 알림은 중복 묶음/억제 | 해당 작업축 즉시 PAUSED. 다른 축은 독립 |
| 새로운 Operator Inbox 승인 요청 1건 | 최초 `requestId + revision`에 1회 의도 생성 | 요청 순간부터 해당 축 PAUSED. **3건까지 기다리지 않음** |
| 서로 다른 미해결 블로커/승인 합계 3건 도달 | `ci_pause_episodes`의 해당 episode에 **중지 알림 1회** | 해당 작업축 PAUSED. 정상 승인 대기를 풀지 않음 |
| 동일 RED 체크의 반복 폴링/기존 취소된 PIE | 새 알림 없음 | 오염된/중복 사건으로 카운트·요금 증가 금지 |
| ACK가 확인된 문자 재스캔·프로세스 재시작 | 동일한 알림 재발행 없음 | 저장된 영수증과 idempotency key를 재사용 |
| 미해결 항목 해소·CI GREEN 전환 | 기본적으로 자동 '해결' SMS 없음(명시적 opt-in 확장 가능) | 모든 보호 게이트를 다시 통과하기 전 자동 재개 없음 |
| 장기 전송 장애·설정 미완료 | 발송 대기/오류를 **로컬 UI**에 표시 | 문자 실패로 인해 STOP 해제나 승인 추정 금지 |

중복 식별: `normal blocker = (workstreamId, blockerKey, occurrence)`, `approval = (requestId, revision/재개 episode)`, `pause escalation = (workstreamId, pauseEpisode)`. 서로 다른 표시가 **같은 실제 원인**으로부터 유래했다면 사용자에게 스팸이 되지 않도록 event-to-notification 상관키를 둡니다. '같은 원인' 판단이 모호하면 서로 다른 조치를 섞지 않고 운영자 화면에 별도로 보존합니다.

단일 승인 요청은 기존 Inbox 정책대로 즉시 중지하고 알림합니다. **'3건'은 추가 자동 정지/에스컬레이션 문턱이지 승인 대기 전송 조건이 아닙니다.** 수신자가 잠을 자는 시간·발송 빈도·일일 비용 상한은 명시적으로 설정하되 critical/approval의 긴급 알림 정책은 사용자 승인된 값만 사용합니다. 기본 미설정은 **미발송**입니다.

## 4. 영속 outbox 및 전송 어댑터 설계

### 4.1 데이터 모델 (마이그레이션 제안)

기존 `ci_alert_outbox`에는 기존 `alert_key`를 그대로 남깁니다. 기존 `operator_requests`에는 첫 승인 즉시-paused 계약을 그대로 남깁니다. 다음은 새 제안 테이블/필드이며 **현재 코드에 존재한다고 주장하지 않습니다**.

- `notification_intents`: `intent_id`(UUID), `source_kind`(`blocker|approval|pause`), `source_key`, `source_revision`, `workstream_id`, `recipient_profile_id`, `channel`, `severity`, `reason_code`, `template_version`, `created_at`, `expires_at`, `state`. 고유키 `(source_kind,source_key,source_revision,recipient_profile_id,channel)`로 사건당 수신처별 1회.
- `notification_delivery_attempts`: `attempt_id`, `intent_id`, `delivery_key`(고정 idempotency key), `provider_kind`, `provider_message_id`(있을 때), `attempt_no`, `claimed_at`, `lease_until`, `submitted_at`, `response_kind`, `updated_at`; 비밀 본문/전화번호·API 키/원본 프롬프트는 기록하지 않음.
- `notification_recipient_profiles`: 운영자가 명시적으로 opt-in한 `profile_id`, `channel`, **전화번호의 비밀 저장소 참조**, 마스킹 표시값·검증 일자·`enabled`, `test_mode`, 사용 한도. 새 사용자/번호로 자동 확장 금지.
- `notification_delivery_receipts`: 제공자 이벤트 ID/메시지 ID·검증된 수신/상태·시각·중복 방지 키를 기록. 필요 시 검증된 웹훅 회신 전용 엔드포인트를 별도 격리.

실제 테이블 설계는 SQLite `STRICT`, FK, `UNIQUE`, 트랜잭션과 additive migration을 사용합니다. 기존 사용자 DB는 완전 종료 후 **SQLite/WAL/SHM 복원 가능한 백업 → 마이그레이션 → 이전/이후 보존 검사**를 거쳐야 합니다. 기존 `ci_alert_outbox` row를 임의로 `sent`로 마이그레이션하지 않습니다.

### 4.2 송신 상태 머신 (1차)

`PENDING` → `CLAIMED`(lease 저장) → 제공자 응답에 따라:

- `ACCEPTED`: 제공자가 **접수를 확인**하고 ID/영수증을 반환. 통신사·단말 최종 수신 `DELIVERED`는 별도 서명/검증된 전달 결과가 있을 때만.
- `NOT_SENT`: 실제 전송이 이루어지지 않았음을 제공자가 분명하게 확인. 재시도 대상 가능.
- `UNKNOWN`: 타임아웃·응답 유실·앱 충돌 등 전송 여부 불명. **새 메시지로 무조건 재발송하지 않음**.
- `PERMANENT_FAILURE`: 번호/승인/구성 문제 등 영구 실패. 재시도 금지, 운영자 확인 필요.
- `DELIVERED`: 제공자 서명 검증을 거친 최종 상태 이벤트를 받은 경우만.

네트워크 호출 전에 **DB transaction으로 송신 의도/고정 delivery key/lease를 먼저 기록**합니다. 동일 `intent_id`의 동시 발송은 유니크 제약과 claim 소유권으로 차단합니다. API 결과를 `ACCEPTED`로 받았는데 이후 crash가 나도 수신 여부를 모를 수 있습니다. 제공자가 검증된 **동일 idempotency key 재시도 또는 message-status 조회**를 지원하지 않으면 `UNKNOWN`은 자동 반복 전송하지 않고 수동 확인으로 남깁니다. 외부 시스템과 SQLite 사이에 전역 분산 트랜잭션이 없으므로 **SMS exactly-once delivery를 보장한다고 표현하지 않습니다.**

자동 재시도는 **명확한 `NOT_SENT` 또는 idempotent 재시도가 증명된 경우에만**, 최대 3회·지수 백오프·상한 시간·한도/시간대 적용. 인증 실패/잔액 부족/번호 오류/지속 레이트리밋은 운영자 블로커로 전환하되, 알림 장애 때문에 서로에게 새 SMS를 무한 생성하지 않습니다.

### 4.3 발송 제공자·비밀정보

`SmsTransport` 인터페이스는 `send({intentId, deliveryKey, toProfile, messageTemplate, metadata})`와 `queryStatus(providerMessageId)`(가능한 제공자만)로 제한합니다. 특정 업체는 **선정하지 않았습니다**. 국내/해외 지원, 테스트 환경, 발신번호 등록, 공식 요금/한도, 단말 수신 영수증, idempotency·상태 조회, 개인정보 처리 기준을 검토하고 **사용자가 공급자·요금 한도·수신 번호·실발송을 별도로 승인**한 뒤 어댑터를 선택합니다.

- API 자격증명·수신번호·발신번호 민감값은 Windows Credential Manager 또는 승인된 OS 비밀 저장소에 저장; git/SQLite 평문/로그/PR에는 저장하지 않음. 자격증명을 임의로 가져오거나 기존 PAT를 재사용하지 않음.
- 발송은 등록된 프로필/허용 목록만, HTTPS 인증된 공급자 도메인만, SMS 발송 외 네트워크 변경 없음. 개발 기본값 `SMS_ENABLED=false` + `SIMULATE_ONLY=true`.
- 메시지에는 `Workstream 표시명`(마스킹 가능), `안전한 reasonCode`, `심각도`, `요청 ID 일부`, `처리 방법`만 포함. ChatGPT 원문/PII/로그·토큰·GitHub private diff/원격 승인 토큰을 문자에 넣지 않음.
- 발송 예약 실패/실제 승인 여부/제공자 접수/단말 전달은 UI에 **각각 다른 상태**로 표시. '대기'를 '전송 완료'라고 주장하지 않음.

예시: `[Autopilot] 사주 연구: 승인 확인 필요 (CI_REPAIR_REVIEW). PC의 Operator Inbox에서 요청 7F2A를 확인하십시오. 자동 진행은 중지되어 있습니다.`

## 5. 승인/회신 채널 안전 계약

**1차 SMS는 알림 전용**이므로 문자로 `승인`, `YES`, `재개`를 답장해도 자동 승인되지 않습니다. 표준 SMS의 발신 번호는 단독으로 승인 주체의 강한 인증을 증명하지 못합니다. 링크에 `nonce`, 전체 `actionFingerprint`, 브리지 토큰, 장기 세션 권한을 넣지 않습니다.

기존 `OperatorInbox.commandLocal` / `operator_command_receipts`를 그대로 재사용합니다. `approve`는 **승인 기록만 남기고**, 실행기는 같은 exact action, task revision, 현재 PR HEAD, 필수 Check, base, GitHub 리뷰/병합, 최근 증거·STOP·별도 권한을 다시 검사합니다. `resume` 또는 승인 만료 이후 자동 dispatch 금지. 승인 요청은 기존의 첫 항목 즉시 PAUSED 정책을 유지합니다.

**미래 선택 기능(Remote Approval)**은 SMS 전송 기능과 별도 PR입니다. 암호화된 운영 웹 화면·독립적인 강한 사용자 인증·재검증 가능한 단기 challenge·명시적 확인 UI·재사용 불가능한 영수증을 갖추고, 외부에서 접근 가능한 서버를 허용하는 별도 보안 승인 이후에만 진행합니다. `OperatorInbox.receive`의 fake-signed 테스트를 **실제 SMS 회신 인증 통과**로 오해하지 않습니다.

## 6. 테스트 계획과 수락 기준

1. **DDL/이력 보존:** 운영 DB 복사본의 additive migration·복구/역호환, Alias·Run·Attempt·알림 기존 레코드 보호. 누락/충돌 시 rollback.
2. **이벤트 단위:** 신규 blocker/승인 1회 알림 의도, 동일 반복 폴링 0회 추가, 3건/critical 정지 에피소드 1회 알림, 다른 Workstream 독립성, 과거 SUPERSEDED 취소는 신규 실패로 보지 않음.
3. **동시성/복구:** 여러 병렬 dispatcher가 동일 `intentId`를 claim해도 최대 한 송신 시도. 트랜잭션 전후 중단, lease 만료, provider 응답 유실, `UNKNOWN` 재시작에서 **blind replay=0**.
4. **제공자 통합:** fake adapter `ACCEPTED/NOT_SENT/UNKNOWN/PERMANENT_FAILURE/DELIVERED` 결과를 모두 테스트. idempotent 지원/미지원에서 재전송 정책 달라야 함. 한도·rate-limit·중복 provider webhook 처리.
5. **보안:** 비밀 키/전화번호/nonce/ChatGPT 본문 로그 유출 없음, 미등록 수신자 0건, disabled 플래그에서 외부 발송 0건. SMS 회신으로 `approve`, `resume`, `merge` 불가.
6. **Windows 격리:** 개인 DB를 쓰지 않는 임시 SQLite에서 Watchtower 실제 연결→하나의 블로커/승인 이벤트→로컬 발송 의도와 UI→중지/재시작·복구 확인.
7. **실발송 (최종 별도 승인):** 사용자가 명시한 본인 수신번호에 **허용한 최대 1건의 canary SMS**를 승인된 공급자/예산 하에서 발송. 제공자 request/수신 상태를 분리 기록. 원본 DB/PAT·Chrome 세션 침해 없음. 동의/승인 없으면 `LIVE SMS PENDING`.

단위 테스트/모의 SMS PASS, GitHub Windows Runner PASS, 실제 Windows 브리지 PASS, **실제 휴대폰 SMS 수신 PASS는 네 개의 다른 단계**입니다. 한 단계의 성공을 다른 단계 수락으로 대체하지 않습니다.

## 7. 구현 작업 단위 (로드맵 P4의 필수 선행 하위 트랙)

| 순서 | 작업/PR | 실질 변경 | 종료 조건 |
|---|---|---|---|
| **SMS-00** | 구현 계약·제공자/수신자 승인 | 이 문서와 운영정책, 개인정보 최소화, 비용·권한 기준 확정 | 요구사항·수신 정책 리뷰 완료. 실발송은 별도 승인 |
| **SMS-01** | `ci_alert_outbox` + `OperatorInbox.open` 이벤트 정규화 | add-only `notification_intents`, 고유 사건 키, 승인 첫 요청 트리거, 에피소드 상관 | 사건별 intent 1개/중복 폴링 0개, 자동 STOP 불변 |
| **SMS-02** | 신뢰 가능한 Outbox dispatcher | claim lease, attempt/receipt 원장, `UNKNOWN` crash-recovery, fake provider, 한도/백오프 | 20개 동시 축/크래시/timeout/중복 테스트 통과 |
| **SMS-03** | 명시 승인 후 실제 SMS provider 어댑터 | Windows 비밀 저장소, 허용 수신 번호/발신 계정, opt-in, real provider integration | provider 계약 테스트·비밀 누출 0·기본 비활성 |
| **SMS-04** | Operator Inbox / UI·실기기 수락 | 대기/제공자 접수/단말 전달/실패 표시, Windows 백업/재시작 및 승인된 canary 1건 | 사용자 승인한 번호에서 실제 수신 확인 + 원본 DB 보존 |
| **APPROVAL-REMOTE (선택)** | 독립 원격 인증·승인 PR | 별도 보안 모델의 원격 승인 UI. SMS 답장은 승인 아님 | 인증/재사용 공격/최신 action proof 등 독립 수락 |

**순서:** 기존 A-01/Watchtower 소비자 계약을 보존한 상태에서 SMS-01 → SMS-02를 먼저 코드+격리 테스트로 완성합니다. SMS-03은 **업체·발신자·수신자·비용·권한 승인** 전에는 실 전송 기능을 켜지 않습니다. SMS-04 이전에는 전체 시스템을 **NOTIFICATION PENDING**으로 운영합니다. 자동 보정/실제 Chrome 재개 A-03과 연계하되, 승인 관련 안전 정책을 문자 기능 때문에 약화시키지 않습니다.

## 8. 사용자 결정이 필요한 항목 (코딩 전 미확정이어도 설계 가능)

- SMS 공급자와 발신번호/서비스 계정, 비용 예산·일일 한도.
- 본인 수신번호와 수신 동의, 테스트 발송 허용 여부.
- 긴급/야간 발송 정책, 여러 블로커 발생 시 묶음 전송 규칙.
- 휴대폰에서 **보기만 할지**, 추후 별도 인증된 원격 승인 시스템까지 구축할지.

**현재 기본값:** 공급자 없음 · 수신자 없음 · 발송 비활성 · 원격 승인 비활성 · 기존 로컬 승인만 허용 · 기존 Workstream 정지 정책 유지. 승인 없이 위 값을 추측하지 않습니다.

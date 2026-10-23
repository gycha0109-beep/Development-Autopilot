# SMS-02 — 영속 모의 SMS 발송 원장·중복 방지·실패 복구

> 구현: 2026-10-24 KST · SMS-01 [PR #85](https://github.com/gycha0109-beep/Development-Autopilot/pull/85) 위의 **Draft** 코드.
> **실제 SMS 발송 미구현/비활성.** SMS 공급자·수신 전화번호·발신번호·요금·자격증명·원격 승인은 아직 구성하지 않았습니다. 기존 승인 안전장치·GitHub 게이트 및 Watchtower를 변경하지 않습니다.

## 현재 기능과 안전 경계

- `local/sms-delivery-dispatcher.js`는 **SMS-01 `notification_intents`에서 `pending`이고 현재 출처가 살아 있는** 이벤트를 처리할 수 있는 **모의 전용** 상태 머신입니다. `coalesced`는 발송 대상에서 제외합니다.
- `local/fake-sms-provider.js`는 HTTPS·전화번호·요금·토큰을 사용하지 않는 결정적 가짜 제공자이며, **모든 발송은 메모리에만 기록**합니다. 실제 제공자처럼 보이는 객체를 주입하면 거부합니다. 운영 서버는 `new SmsDeliveryDispatcher(store)`를 **enabled=false / transport=null**로 구성하고 읽기 전용 `ciSupervision.smsDelivery` 상태만 보여 줍니다. 외부 발송 엔드포인트·자동 스케줄은 추가하지 않았습니다.
- 기존 `notification_intents`/인시던트/승인/정지 episode SQLite 행은 변경하지 않습니다. 추가되는 `sms_delivery_states`(1건/intent), `sms_delivery_attempts`(시도별 영수증), `sms_delivery_receipts`(검증된 fake 전달 이벤트)는 **additive `CREATE TABLE IF NOT EXISTS`** 및 FK/유니크 인덱스/STRICT를 사용합니다.
- 외부 가짜 transport 호출 전에 반드시 SQLite `BEGIN IMMEDIATE` 트랜잭션으로 **고정 `deliveryKey`, `attemptId`, `leaseUntil` 및 시도 번호**를 기록합니다. 동일 intent에 대한 다른 작업자/연결의 선점은 `IN_FLIGHT`로 거부하며 추가 가짜 전송을 하지 않습니다. Process crash 또는 ACK 지연 뒤 재개 시 새 attempt를 임의로 만들지 않습니다.
- 가짜 제공자의 `accepted`는 **제공자 접수**만 의미합니다. 별도의 검증된 mock delivery receipt가 도착해야 `delivered`로 표시합니다. SMS-02에 실제 단말 전달 증명은 **절대로 존재하지 않습니다**.
- `not_sent`는 제공자가 실제 전송하지 않았음을 명확히 확인한 mock 응답만 의미합니다. **최대 3회**, 지수형 시간 지연(기본 5초 → 10초)을 지켜 retry하며 소진되면 `exhausted`에 머뭅니다. `permanent_failure`는 재시도하지 않습니다.
- 타임아웃/연결 끊김/ACK 유실/비정상 반환값은 `unknown`. 기한이 지난 `claimed`도 `reconcile()`에서 `unknown`으로 전환합니다. **unknown에 대한 blind replay 없음**, 늦게 도착한 첫 시도 ACK는 `STALE_RESULT_IGNORED`로 거부. SMS는 외부 exactly-once를 보장하지 않습니다.
- **전송 직전 출처 재검증:** 해결된/더 새로운 revision의 blocker, 승인 만료·종료·revision 불일치, 종료된 pause episode, 없는 source를 분리. 출처 테이블 자체를 아직 로딩하지 않았다면 `SOURCE_NOT_READY`로 보류하고 영구 소멸로 처리하지 않습니다.
- **발송량 제한 (fake 전용):** maxBatch=8, maxDailyAttempts=40, workstream당 일일 10, maxAttempts=3, lease=30초(구성 가능한 안전 상한). 날짜는 UTC 자정 기준으로 구분합니다. SMS-03에서 실제 업체 요금·수신처 한도와 함께 별도 승인/강화가 필요합니다.
- Admin snapshot 및 화면은 발송 기록을 `PENDING/IN_FLIGHT/NOT_SENT/ACCEPTED/DELIVERED/UNKNOWN/EXHAUSTED/SUPPRESSED`로 구분하지만, 실제 문자 모드임을 숨기지 않고 **`fake_only_disabled_in_server`, `actualSmsSends=0`**으로 보고합니다.

## 발송 상태 머신

```text
PENDING ──(source still relevant + budget + durable claim)──> CLAIMED
CLAIMED ├─ fake accepted + valid message id ───────────────> ACCEPTED
        ├─ signed fake delivery receipt (later) ─────────> DELIVERED
        ├─ fake NOT_SENT ───> NOT_SENT ─(backoff, ≤3)──> CLAIMED
        ├─ fake permanent failure ───────────────────────> PERMANENT_FAILURE
        └─ timeout / crash / expired lease / bad result ─> UNKNOWN (NO AUTO REPLAY)
NOT_SENT after 3 attempts ─────────────────────────────────> EXHAUSTED
PENDING with resolved/expired/replaced source ─────────────> SUPPRESSED
COALESCED intent ──────────────────────────────────────────> (never claimed)
```

### 테스트 및 검증

- `node --test tests/sms-delivery-dispatcher.test.js`: fake-only guard, 정확한 3회/지수 backoff, accepted ≠ delivered, 서명 검증된 fake receipt, 잘못된 영수증/영구 실패, timeout/ACK 분실 `UNKNOWN`, lease 만료·늦은 ACK 차단, 기존 SQLite 재시작, 두 DB 연결 간 동시 선점, 20개 Workstream 병렬 drain, 승인 만료/구 blocker 재검증, 예산 상한, additive 스키마 불변.
- `npm run check`: 새 모듈 문법 및 기존 전체 회귀 테스트. `SMS-01` 상태와 모의 결제/권한 구분을 유지합니다.
- 격리 Windows localhost 서버에서 읽기 전용 SMS 발송 상태 노출, **실발송 0건**, 매크로/Chrome 작업 0건 검증. 실제 사용자 PC의 `D:\cha\Development-Autopilot` 또는 운영 DB는 건드리지 않습니다.

### SMS-03/04를 위한 미완료 항목 (지금 활성화 금지)

실제 제공자 비교/선정, 발신 계정·등록번호, 본인 수신번호 동의, Windows Credential Manager 저장, 과금·국가별 규정, 공급자 idempotency/status 조회 계약, 최종 전달 영수증/웹훅 인증, 요금·분당 한도, 다중 수신/야간 묶음 정책, 승인된 **본인 번호 canary 1건**. **문자 회신을 승인으로 받는 기능은 SMS-03에도 넣지 않습니다.** 원격 승인 기능은 별도 보안 검증 PR입니다.

**현재 수락 표기:** `SMS-02 MOCK TEST PASS` (테스트 검증 시), `LIVE SMS PENDING`.

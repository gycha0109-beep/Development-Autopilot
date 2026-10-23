# Telegram 봇 무료 알림 채널 — 구현·보안·실기기 수락

> 기준일: 2026-10-24 KST. [알림 이벤트 SMS-01 #85](https://github.com/gycha0109-beep/Development-Autopilot/pull/85) → [영속 실패·중복 원장 SMS-02 #86](https://github.com/gycha0109-beep/Development-Autopilot/pull/86) 위에 쌓는 구현입니다. [설계 PR #84](https://github.com/gycha0109-beep/Development-Autopilot/pull/84)에서 유료 문자 대신 **Telegram Bot API 무료 개인 알림을 기본**으로 선택했습니다.
>
> 현재 코드에서 SMS 어댑터는 **여전히 fake-only + disabled**입니다. 이 문서는 BotFather 계정·토큰·휴대폰 수신까지 완료했다는 뜻이 아닙니다.

## 구조 및 완료된 코드

```text
실제 CI / Blocker / 첫 승인 요청
    ↓ 원본 incident/Operator Inbox 와 같은 SQLite transaction
notification_intents [SMS-01: unique source key + revision, coalesced]
    ↓ 현재 source/승인 만료·episode·7일 이내 유효성 재검증
telegram_delivery_states + telegram_delivery_attempts [추가 STRICT 테이블]
    ↓ credential present AND explicit opt-in AND durable claim
Telegram Bot API sendMessage → private chat ID (HTTP POST/HTTPS)
    ├─ 검증된 200: ACCEPTED (Telegram 서버 접수, 휴대폰 수신 증명 아님)
    ├─ 429: NOT_SENT → retry_after 존중, 지수 backoff, 최대 3회
    ├─ 400/401/403 등: PERMANENT_FAILURE (자동 반복 X)
    ├─ 5xx/응답 유실/네트워크 오류: UNKNOWN (자동 반복 X)
    └─ 중간 종료/lease 만료: UNKNOWN (자동 반복 X)
```

- **새 구현:** `local/telegram-bot-transport.js`, `telegram-notification-dispatcher.js`, `notification-source-validation.js`, `telegram-credentials.ps1`, `telegram-canary.js`. SMS-02의 가짜 원장은 변경 없이 유지하며 공통 출처 검증 코드를 재사용합니다. **실제 텔레그램 원장**은 별도 `telegram_delivery_states`/`telegram_delivery_attempts`이고 fake SMS의 접수 이력을 Telegram 성공으로 가져오지 않습니다.
- 서버는 `AUTOPILOT_TELEGRAM_ENABLED=1` **명시적 opt-in**과 Windows Credential Manager의 **검증된 개인 봇·대화 ID**가 모두 있어야 한정된 알림 발송을 시도합니다. 그 외 기본값은 비활성입니다. `GET /api/v1/snapshot`에서 Telegram 상태·안전한 사유만 표시하며 토큰/채팅 ID는 없습니다.
- 발송 주기: 기존 스케줄러가 약 10초마다 최대 **1건** 발송 요청. 일일 최대 80회, 작업축당 25회, 확실한 429 미발송에 한해 최대 3회(최소 10초 지수 backoff; Telegram `retry_after` 우선). 요금이 붙는 `allow_paid_broadcast`를 **false**로 명시합니다.
- 이벤트별 운용: 첫 일반/critical 블로커, 최초/재개된 승인 요청, 독립 중지 에피소드. 재관측은 dedupe, 같은 블로커로 인한 중지 에피소드는 `coalesced`. **7일 초과 과거 사건은 발송하지 않고 SUPPRESSED**로 표시하여 가입 직후 오래된 알림이 한꺼번에 전송되지 않게 합니다.
- **개인 메시지 전용:** Telegram의 `chat.type=private` 및 미리 확인한 양수 numeric chat ID와 정확히 일치할 때만 Bot API 접수를 인정합니다. 다른 채팅·그룹 전송을 허용하지 않습니다. 메시지는 작업명(길이 제한)·안전한 reasonCode·심각도·'PC Operator Inbox에서 확인'만 포함합니다.
- **수신 명령 처리 없음:** `/approve`, `/resume`, 'YES', callback button 등의 Telegram Update/웹훅을 **프로그램은 수신/실행하지 않습니다.** 승인·재개는 기존 로컬 인증과 최신 PR/CI 검증을 반드시 거칩니다. 텔레그램 알림만으로 PR을 병합하거나 작업을 시작하지 않습니다.
- 토큰/개인 chat ID는 **Windows Credential Manager 전용 generic credential** `DevelopmentAutopilot/TelegramNotifications/v1`에 저장합니다. PowerShell `Enroll`은 토큰을 마스킹 입력 받고 최근 30분 내 *그 봇의 사적인 대화*에 보낸 `/start`만 조회합니다. 사용자에게 후보 숫자를 보여주고 **선택한 ID가 검증된 후보에 있어야 저장**합니다. 기존 GitHub/Watchtower PAT나 Chrome Credential은 읽지 않습니다. `-Mode SelfTest`는 합성값 검증, `IntegrationTest`는 UUID 임시 Windows generic credential의 쓰기→읽기→완전 삭제를 검사합니다.
- Telegram API 요청의 토큰은 **오직 HTTPS Bot API URL 내에만** 사용됩니다. 로깅/SQLite/Git/CI 테스트 출력/관리 화면에 기록하지 않습니다. 프라이빗 응답 원문/예외 문자열도 사용하지 않습니다. 토큰이 유출되면 **BotFather에서 폐기·재발급**해야 합니다.
- 실제 네트워크 `sendMessage`는 사용자가 봇 토큰·Chat ID를 설정하고 env opt-in을 켜거나 직접 canary를 실행할 때만 호출 가능합니다. 외부 서비스 가입·전화번호·유료 SMS·비밀 키 설정을 개발자가 대신 생성하지 않습니다.

## 사용자 최초 연결 순서 — 본인 Windows PC에서만 수행

**1. 텔레그램 앱에서** 공식 [@BotFather](https://t.me/BotFather)에 `/newbot`을 보내 전용 봇을 생성합니다. 이름 예: `Development Autopilot Alerts`, 사용자명은 고유하며 `bot`으로 끝나야 합니다. BotFather가 발급한 **토큰은 이 채팅이나 GitHub에 붙여넣지 마십시오.**

**2. 방금 만든 봇과 1:1 개인 대화를 열고 `/start`를 보냅니다.** 실제 개인 채팅만 알림 대상으로 지원합니다. 자신의 모바일 텔레그램 알림을 허용해야 푸시가 나타납니다.

**3. PR 병합/실제 PC 코드 준비 이후**, 별도의 Windows PowerShell 콘솔에서 Autopilot 저장소 루트로 이동해 다음 명령을 실행합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\local\telegram-credentials.ps1 -Mode Enroll
```

토큰은 **콘솔의 숨김 입력**으로만 입력합니다. 도구가 봇의 최근 30분 `/start` 후보 Chat ID를 표시하면 **본인의 1:1 채팅 숫자를 다시 입력해 확인**합니다. 성공하면 `TELEGRAM_CREDENTIAL_STORED`만 표시됩니다.

**4. 현재 PowerShell 세션에서만 무료 알림을 활성화하고 프로그램을 시작합니다.** 처음에는 글로벌 STOP과 테스트용 Workstream을 사용하십시오.

```powershell
$env:AUTOPILOT_TELEGRAM_ENABLED = '1'
npm run start
```

이 변수는 새 콘솔에 자동으로 유지되지 않습니다. 재시작 시에도 알림을 받으려면 사용자가 명시적으로 승인한 시작 스크립트·서비스의 환경변수에 동일한 opt-in을 적용해야 합니다. `D:\cha\Development-Autopilot` 등 기존 운영 DB에 적용하기 전에는 버전·백업/복구·사용자 승인 수락이 선행돼야 합니다.

**5. 개인 메시지 테스트는 서버와 별도로 정확히 1회 명령을 직접 실행합니다.**

```powershell
$env:AUTOPILOT_TELEGRAM_ENABLED = '1'
node .\local\telegram-canary.js --send-canary
```

`TELEGRAM_CANARY_ACCEPTED_BY_API`는 Telegram API가 접수했다는 의미입니다. 실제 휴대폰 푸시/앱 내 수신은 사용자가 직접 확인해야 **LIVE Telegram PASS**가 됩니다. Timeout/`UNKNOWN`일 때 프로그램이 스스로 같은 테스트 메시지를 다시 보내지 않습니다.

## 테스트·수락 구분

| 검증 | 성공으로 인정할 조건 |
|---|---|
| JS 단위/API 계약 | mock HTTPS: 무료 모드, private chat ID, 429 backoff, 403 permanent, 500/timeout UNKNOWN, 20축·2 SQLite 연결 중복 없음, 늦은 ACK/7일 backlog 등 |
| Windows credential | 자기 계정의 합성 임시 credential 쓰기·읽기·삭제, 실제 봇 credential 생성/조회하지 않음 |
| 격리 localhost 서버 | 기본 꺼짐, pending 알림 원장 UI 읽기, 글로벌 STOP, 실제 Telegram 호출/매크로 0건 |
| 실제 텔레그램 접수 | 사용자의 BotFather 봇 생성·최초 `/start`·Windows enrollment + opt-in 이후 Bot API 200/message_id/private chat 확인 |
| 휴대폰 실제 수락 | 위 접수와 **사용자 휴대폰에서 메시지/푸시 직접 확인**. API ACCEPTED만으로 단말 수신·읽음 PASS 선언 금지 |
| 유료 SMS | **보류, 미연결**. 전화번호/발신 계정/과금 없음 |

## 남은 후속 작업

- Telegram 실제 PC 최초 연결 및 사용자 휴대폰 canary 증명. 현재 BotFather 토큰과 사용자 인증된 Chat ID는 준비되지 않은 상태입니다.
- 운영 PC 배포는 PR 스택 합의·병합 후 원본 DB/WAL/SHM 백업과 안전한 additive migration 검증 후 별도 진행.
- 발송 실패시 Operator Inbox 대체 표시 유지, 중요도/휴식 시간/요금 제한보다 별도 rate-limit 정책 조정.
- 원격 승인 채널은 현재 **명시적으로 범위 밖**입니다. Telegram 답장만으로 자동 승인·재개 기능은 추가하지 않습니다.

공식 참고: [Telegram Bot API](https://core.telegram.org/bots/api), [BotFather 시작](https://core.telegram.org/bots/tutorial), [봇 FAQ/무료 발송 제한](https://core.telegram.org/bots/faq).

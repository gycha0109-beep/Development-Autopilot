# 도구 승인 요청 — Telegram 알림

## 현재 범위
- 연결된 ChatGPT 개발 세션에서 **실제 권한 요청 UI의 세 버튼**(항상 허용, 한 번만 허용, 거부)을 확인합니다.
- 승인 요청이 있으면 해당 세션에만 `WAITING_HUMAN_APPROVAL` 차단을 적용합니다.
- Telegram으로 프로젝트명, 도구명, 최초 감지 시각, PC 승인 안내만 보냅니다.
- 같은 승인창을 매분 관측해도 최초 한 번만 보냅니다.
- 승인창이 사라졌다는 독립적인 관찰 두 번(최소 15초 간격) 후 차단을 해제합니다. 응답 완료가 검증되기 전까지는 자동 전송하지 않습니다.
- 이관 중에도 감시는 유지되지만 이관 자체의 중단 사유는 보존합니다.
- Telegram에서 승인 버튼을 누르거나 PC/ChatGPT 권한 설정을 자동 변경하지 않습니다.

## 연결 설정
Windows에서 로컬 Autopilot 서버 프로세스를 시작하기 **전에** 아래 두 환경변수를 등록합니다.

- `AUTOPILOT_TELEGRAM_BOT_TOKEN`: BotFather에서 발급한 봇 토큰
- `AUTOPILOT_TELEGRAM_CHAT_ID`: `/start`를 보낸 사용자의 개인 Telegram chat ID

대체 이름 `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`도 지원합니다.
봇의 `@사용자명`만으로는 개인 chat ID를 판정할 수 없습니다.
토큰이나 chat ID를 Git 저장소·로그·대화 내용에 저장하지 마십시오.
앞서 메시지에 노출된 봇 토큰은 BotFather에서 재발급하는 편이 안전합니다.

추가로 로컬 서버의 동일 출처 관리 API `POST /api/v1/telegram/configure`를 지원합니다. 이 API는 BotFather 토큰과 선택적 Chat ID를 받아 봇 사용자명 및 수신 대상을 검증하고, 테스트 메시지 성공 후 Windows DPAPI로 암호화해 로컬에 보관합니다. 수신 Chat ID를 생략하면 봇의 `/start` 개인 대화가 정확히 하나일 때만 자동 선택합니다. 자격 증명을 ChatGPT 대화나 원격 명령에 전달하지 마십시오.

서버를 재시작한 뒤 `GET /api/v1/snapshot`의
`chatContinuation.humanApprovals.configured`가 `true`인지 확인합니다.
알림은 `alerts[].notification`에 `pending` / `sent` /
`failed` / `unknown`으로 기록됩니다.
전송 결과가 불확실한 `unknown` 알림은 중복 발송을 피하기 위해 자동 재전송하지 않습니다.

## 테스트
```powershell
node --test tests/human-approval-alerts.test.js tests/chat-observer-complete-dom.test.js
npm.cmd run check
```

실제 승인창 없이 테스트만으로 Telegram 발송 성공을 주장하지 마십시오.

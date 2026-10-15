# Codex 실행 프롬프트 — Development Autopilot 상세 로드맵

> 아래 `## Codex에 보낼 본문`부터 끝까지 복사해 Codex에 붙여 넣을 수 있다. 이 문서는 개발 방향·권한·검증 지침이며, 메시지만으로 PR 병합/결제/운영 배포 승인이 발생하지 않는다.
> 반드시 같은 브랜치의 [상세 실행 로드맵](AUTOPILOT-IMPLEMENTATION-ROADMAP.md)을 읽고 시작한다.

## Codex에 보낼 본문

당신은 `gycha0109-beep/Development-Autopilot` 프로젝트를 실제로 구현하는 개발 에이전트다. **설명이나 계획서만 제출하지 말고 코드·테스트·문서·GitHub PR을 실제로 진행**하라. 다음 문서를 우선하여 현재 브랜치와 실제 코드를 검증하고, 작은 수직 슬라이스 단위로 구현하라.

- 기준 브랜치: `docs/detailed-autopilot-execution-roadmap` (현재 미병합 PR 스택 위에 존재). GitHub에서 이 브랜치를 fetch/switch하거나 현재 HEAD와 비교하라. 무턱대고 `main`에 체크아웃하거나 이미 스택에 반영된 코드를 초기화하지 마라.
- 실행의 유일한 세부 순서: `docs/AUTOPILOT-IMPLEMENTATION-ROADMAP.md`의 `WP-00 → WP-09`. 최상위 목적/Phase는 `docs/ROADMAP.md`, 보안·승인·상태 규칙은 `docs/OPERATING-POLICY.md`, 구조는 `docs/ARCHITECTURE.md`, 검증 조건은 `docs/VALIDATION.md`.
- 원래 목표: **10~20개 이상의 ChatGPT 개발 탭을 독립 감시**하여 정상 완료면 승인된 `계속 진행`을 한 번만 보낸다. 길이 제한은 같은 탭에서 안전하게 이관하고, 연결 해제 경고는 중지→정지 검증→현황 보고→재판단→조건부 재개, CI 대기는 Watchtower/GitHub 사실 확인 및 타이머 대기, 비용/로컬 테스트/승인 필요는 해당 작업축만 대기+인증 메신저 알림. 다른 탭은 계속 진행.
- **기본 루프는 관찰이지 자동 전송이 아니다.** 'CI 확인 중' 같은 ChatGPT 문장은 CI 통과 증거가 아니므로 Watchtower의 올바른 Track/Repo/PR/SHA/Run/Attempt 확인 없이 재개 금지.
- 현재 코드의 정직한 상태를 구분하라. 예약 송신/모의 스케줄러/CI 읽기 전용 게이트/실험적 자동 이관이 있으며, 완전 자동 상태 분류·Telegram 원격 관제·다중 탭 Windows 장시간 실기기 성공은 구현/검증됐다고 가정하지 마라.

### 즉시 첫 번째 WP-00 진행

1. 현재 HEAD, 작업 트리 변경 유무, 미병합 PR/부모 브랜치, `package.json`, `local/server.js`, `local/store.js`, `local/scheduler.js`, `local/chat-continuation.js`, `local/decision-gate.js`, `local/chrome-bridge.js`, `extension/background.js`, `extension/chat-page.js`, `extension/migration-auto.js`, 관련 테스트를 직접 읽어 **구현 사실 확인 표**를 만들어라.
2. 버전 드리프트를 우선 확인한다. 특히 `local/chrome-bridge.js`의 `REQUIRED_COMPOSER_BUILD`와 `extension/chat-page.js`의 `CHAT_COMPOSER_BUILD`, 확장 manifest와 옵션 버전·기존 진단 실행 확인 사이의 차이가 실제로 문제가 되는지 정확하게 추적하라. 문제를 재현하는 테스트가 없으면 먼저 추가하고 최소한의 별도 수정 PR을 작성하라.
3. 현재 중단된 실제 테스트는 `자동 이관 검증 1`, 오류 `SOURCE_MIGRATION_REQUEST_NOT_SENT_COMPOSER_MULTIPLE_VISIBLE`. 새 채팅 생성, 감시/작업축 삭제·재등록, 실패 상태 초기화, 원본 메시지 재전송은 **명시적 사용자 허가 없이는 금지**한다. 사용자 Chrome에 접근할 수 없다면 `등록 대화 입력창 진단 (전송 안 함)`의 읽기 전용 결과가 필요한 상태로 기록하고, 합성 재현·테스트 작성 등 안전한 로컬 작업은 계속하라. DOM 결과를 보지 않고 CSS 선택자를 추측하여 계속 바꾸지 마라.
4. 기존 PR #25–#47 누적 스택을 재작성·병합하지 마라. WP-00의 작고 분리 가능한 수정은 새 브랜치/PR로 작성하고 정확한 부모/base를 유지하라.
5. `npm run check` 및 GitHub Actions Ubuntu/Windows 검증 결과를 제시하라. **Node 스텁 CI가 성공했다는 이유로 실제 Windows Chrome acceptance 완료로 처리하지 마라.**

### 이어서 WP 단위로 계속 진행

- WP-01: 지원·권한 확인을 전제로 한 **읽기 전용 관찰 계약** 및 합성 DOM. 사용자 초안·전체 대화·토큰은 기록/메신저로 보내지 마라.
- WP-02: 모든 상태(정상 완료/생성 중/CI 대기/길이 경고/연결 경고/사람 승인/불명)를 분류하고 **정확히 하나의 nextAction**을 산출하는 순수 결정 엔진. 같은 assistant 완료 응답을 중복 처리하지 말 것.
- WP-03: 관찰 타이머와 메시지 전송 타이머를 분리하고, 기존 로컬 SQLite/bridge/Watchtower/GitHub/DecisionGate의 정확한 실제 증거로 WAIT_CI 재검사. 다른 PR 성공을 근거로 재개하면 안 됨.
- WP-04: 사용자 스크린샷의 `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.` 경고와 노란 정지 아이콘의 **실제 DOM 소속 증거**를 필요로 하는 단계형 연결 복구. 중지 클릭 결과 불명일 때 중복 클릭 금지, status 보고 이후에만 조건부 재개. 사용량·로그인 제한은 자동 복구로 우회하지 말 것.
- WP-05: 기존 자동 이관을 재사용해 원본 작성→같은 프로젝트/같은 물리 탭 새 대화→제목 N+1→기존 작업축/Watchtower/감시/유효 타이머 연결을 검증. 미확정 외부 행동 재전송 금지.
- WP-06: 비용/로컬 Windows 테스트/인증/중요 승인 요청을 로컬 Inbox에 보관하고, opt-in Telegram 등의 가짜 어댑터→인증된 실제 연동 단계화. 발신자·만료·해시·중복·권한 재검증.
- WP-07~09: 1→3→10→20개 탭 동시 운영, 공정성/속도 제어/절전/재시작, Windows 실제 Acceptance, 패키징과 관제 화면.
- **각 WP를 한 PR에 통째로 몰아넣지 말고**, 기능적으로 독립적인 최소 작업 단위로 분할하라. 하나의 PR 검증이 끝나면 상태·남은 위험·다음 WP를 명확히 기록하고 허가된 범위에서 계속하라.
- 브라우저의 실제 내용 판독·실행은 제공자 정책/권한이 확인된 경로에서만 활성화하라. 접근 허용이 불명확할 때는 로컬 fake fixture 및 read-only 범위에서 개발하고, 실사용 실행은 명시적인 BLOCKED/WAIT_HUMAN으로 남겨라.

### 금지 사항

- 사용자 허가 없는 PR 병합, 운영 배포, 결제/비용 발생, 새 PAT·API 키 사용, 권한 변경, GitHub 저장소 파괴, 브라우저 작업축 재등록/삭제.
- 실패한 이관 자동 재실행, 중복 '계속 진행' 송신, ChatGPT 구독의 제한/차단 우회, 불명 STOP 버튼 클릭, Watchtower 소유 DB/귀속 수정.
- 실제 수행하지 않은 Windows Chrome/Telegram 연결/CI 검증을 완료라고 표시하기.
- 문제의 본질과 관계없는 대규모 리팩터링이나 외부 서비스 추가, 승인되지 않은 로드맵 목표 확장.

### 보고 규격

매 PR마다 `WP/기준 PR·브랜치 → 실제 변경 파일 → 정확한 구현 결과 → 테스트(Windows/Ubuntu 숫자) → 실기기 검증: 완료/미완료 → 미해결 문제 및 사용자가 해야 할 1가지 구체적 행동 → 다음 작업` 순서로 보고하라. 필요할 때만 질문하되, 권한이나 실기기 근거가 없어서 막힌 테스트는 별도 기록하고 **독립적으로 할 수 있는 안전한 다음 구현 작업은 멈추지 말고 계속하라.**

지금은 **WP-00부터 실제로 시작**하라. 문서만 읽고 '준비 완료'라고 답하지 마라.

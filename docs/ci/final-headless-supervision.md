# Development Autopilot — CI 관제 독립화 및 인수 기준

작성 기준: 2026-11-01. 변경 대상: Autopilot PR #95를 부모로 하는 feat/ci-final-supervision-20261101.

## 실행 구조

- 관제 실행 주체: Autopilot 로컬 Node.js 서버. 검증된 CI Core 실행 파일 네 개를 SHA-256 고정 검증 후 사용한다.
- GitHub 인증: 기존 Windows Credential Manager 및 GitHub CLI. PAT/Telegram 비밀을 브라우저, SQLite, 로그 또는 HTTP 응답에 출력하지 않는다.
- 저장: 기존 WatchTower SQLite는 조회만 한다. 신규 Run/Attempt/수집 영수증은 Autopilot SQLite에 쓴다.
- 관제: 독립 CI 조회 결과와 GitHub PR 필수 검사 검증을 **서로 다른 증거**로 대조한다.
- Dashboard: CI 상태, 최신 실행, 이상·충돌·미귀속 기록 및 알림 상태를 한곳에 노출한다.
- WatchTower UI: Autopilot 실행·조회·판정·관제에 필요하지 않다. 독립 도구의 UI와 이전 운영 이력으로 남겨둘 수 있다.
- BuildMap: 향후 로컬 조회 전용 API의 데이터 계약을 참고해 통합한다. 외부 네트워크 공개·쓰기 API는 제공하지 않는다.

## 최종 판정

확인에 필요한 대상: 저장소, PR, 현재 HEAD SHA, CI Run ID와 Attempt, 최신 관측 시각, GitHub 필수 검사·상태, 병합 여부, 사용자 승인의 증거 해시.

- Direct Core가 Run 성공이라 보고해도 VERIFY_GITHUB일 뿐 작업 실행 허가는 아니다.
- HEAD·Run·Attempt가 서로 다르거나 응답이 오래됐거나 필수 검사 정책을 읽지 못하면 UNKNOWN.
- CI 실행 중 또는 GitHub 필수 검사 미완료면 WAIT_EXTERNAL.
- CI 실패 또는 필수 검사 실패면 BLOCKED.
- 병합 및 필수 검사를 확인해도 WAIT_HUMAN; 정확한 증거에 사용자 승인이 있어야 REVIEWED.
- 전체 정지 상태, 작업 중지, 기존 작업 실행 중, 승인 증거 변경은 우선 차단한다.
- 기존 WatchTower 기반 조건 판정 경로는 Direct Core 미구성 환경의 호환 경로로만 유지한다.
- 기존 ChatGPT/Chrome 전송 권한을 별도로 보유해야 한다. CI 결과 자체로 Chrome 메시지를 발송하지 않는다.

## 이상 감지와 알림

- 독립 CI 실패·취소·장시간 대기, 수집 오류, GitHub API 권한·요청 제한, SHA/Attempt 불일치, 트랙 귀속/중복, Registry 변경, GitHub PR 및 작업 상태 불일치를 기록한다.
- 동일 사건은 키와 회차별로 하나만 기록하며 변경이 생길 때만 새 이벤트를 만든다.
- 일부 저장소가 이번 회차에 검사되지 않았으면 사건이 사라졌다고 판단하지 않는다. 과거 성공 기록은 후속 작업의 근거로 쓰지 않는다.
- 처음 발견한 기존 사건은 알림을 억제한다. 이후 사건 변화/복구만 선택적으로 발송한다.
- CI 전용 Telegram 발송은 기존 Windows Credential Manager의 전송 기능을 재사용한다. 별도 AUTOPILOT_CI_ALERTS_ENABLED=1 명시 설정과 기존 Telegram opt-in 양쪽이 필요하며 기본값은 비활성이다.
- 발송 전 상태를 보관한다. 응답이 불확실하면 중복 발송하지 않는다. 하루 최대 12건으로 제한한다.
- Telegram 회신은 승인·재개·PR 병합 허가가 아니다.

## 데이터 보존

집 PC 운영본 작업 전 백업 위치: %LOCALAPPDATA%\Development-Autopilot\run\backup-before-ci-final-supervision-20261101\

- autopilot.sqlite3: SQLite 온라인 백업, PRAGMA quick_check=ok
- installed-code.zip: 기존 설치본 코드와 확장 프로그램 보관
- PR #93 → #94 → #95는 모두 열린 순차 PR이다. main에서 새로 시작하지 않는다.
- WatchTower PR #76~#78의 기록기·잠금 구현은 이번 단계에 설치하지 않는다.
- 운영 DB/설치본 변경, 실 Telegram 알림 발송, PR 병합, 자동화 해제는 별도 승인 전 금지한다.

## 검증 기록 및 완료 경계

- 기존 테스트 408/408 통과.
- WatchTower 미실행 Windows 격리 서버(포트 48174, 별도 임시 DB, Telegram OFF, Global Stop ON)에서 CI Core 검증된 실행 파일 실행, 3개 Registry Repository, 직접 CI 실행 60건 수집·SQLite 기록 확인.
- GitHub 실제 Run ID 41241646846 / Attempt 1, HEAD 182d8ebad5eb82ceb3a3c3f1fac3d4ba1480e998, PR #2849(gycha0109-beep/MyeongHa): Direct Core VERIFY_GITHUB, GitHub 필수 검사 WAIT_EXTERNAL, 작업 판정 PAUSED(전체 정지) — 안전하게 차단 확인.
- 원래 Run 중 하나가 로컬 기록에는 RUNNING이지만 GitHub 실시간에는 completed/success였으며, 불완전한 기록을 최종 성공 판정으로 사용하지 않음을 확인했다.
- GitHub Actions Windows·Ubuntu CI 및 새 코드 최종 검사 완료 시 결과를 PR에서 확인한다.
- **실제로 발송된 Telegram CI 알림과 승인→재개 흐름의 운영 실증은 이번 단계에서 승인 없이 실시하지 않는다. 이 조건을 실증하기 전 운영 완결로 판정하지 않는다.**

## WatchTower에서 남겨둔 책임

| 책임 | Autopilot | WatchTower |
| --- | --- | --- |
| 상시 GitHub Actions 조회 | 독립 실행 | 기존 UI 운영 시 자체 수집 가능 |
| Run/Attempt 자동 기록 | Autopilot SQLite | 기존 SQLite 이력 유지 |
| 정확한 PR/필수 검사 검증 | 직접 확인, 안전한 상태 판정 | 보조 관측만 |
| 이상 감지·사건 기록·선택적 알림 | 독립 실행 | 선택적 기존 관제 UI |
| 채팅/PR 단계 전환 | 사용자 승인 후 별도 평가 | 실행 권한 없음 |
| BuildMap 연동 | 재사용 가능한 읽기 계약 | 역사적 자료 및 선택적 UI |

## 운영 최종 승인 전 남은 작업

1. 새 PR에 대한 Windows·Ubuntu CI 성공 및 리뷰.
2. 백업과 복구 경로를 활용한 설치본 업데이트·재시작 후 기록 무결성 검증.
3. Telegram 테스트 채널로 실제 알림 1건 발송·중복 방지·회복 확인.
4. 실제 Workstream을 등록해 실패/대기/변경/승인 후속 판단까지 관통 검증.
5. 이후에만 WatchTower 상시 실행 설정을 제거하고 운영 책임 이관을 완료한다.

# Phase 02 — Local Orchestrator / Scheduler MVP

> Branch: feat/phase02-local-orchestrator
> Status: Ubuntu/Windows GitHub Actions CI 통과. 사용자 Windows 실기기 브라우저 확인은 별도 필요.
> Scope: Node.js localhost 관리 서버 + SQLite 기반 작업축 상태 엔진 + 모의 실행기.
> Watchtower 연동은 **별도 진행 중**이며 현재 이 코드에서 호출하지 않습니다.

## 구현된 기능

- `local/store.js`: 작업축/작업 버전/실행 작업/감사 이벤트 및 전역 긴급 정지 상태를 SQLite에 영속 보관.
- `local/scheduler.js`: 프로젝트 작업축별 주기 평가 및 MockExecutor dispatch.
- `local/server.js`: `127.0.0.1:48173`로만 바인딩한 HTTP 제어 서버, JSON API, 동일 출처 POST 요청 검증.
- `local/public/index.html`, `styles.css`, `app.js`: 한국어 작업축 등록·상태·모의 실행 제어판.
- `tests/local-scheduler.test.js`: 독립적인 스케줄, SQLite 복구, 중복 실행, 충돌 방지, 사람 승인 대기, 오동작 보호 테스트.
- Node 22 이상 내장 `node:sqlite` 사용. 외부 npm 패키지는 설치할 필요 없음. **해당 내장 모듈은 Node 22 계열에서 실험적 API이므로 향후 안정적인 DB 드라이버로 교체할 수 있게 store 모듈에 격리함.**

## 실행 방법

Windows PowerShell:

```powershell
git clone https://github.com/gycha0109-beep/Development-Autopilot.git
cd Development-Autopilot
git checkout feat/phase02-local-orchestrator
node --version
npm run check
npm start
```

브라우저에서 `http://127.0.0.1:48173` 접속합니다.

관리 화면에서:
1. 프로젝트 키, 저장소(owner/repo), 작업축 이름, 선택적 Watchtower Track Key를 입력해 등록.
2. 기본 `observe` 모드는 외부 작업 없이 주기만 갱신.
3. **모의 실행 모드**로 변경하고 **작업 준비**를 눌러야 시뮬레이션 실행 가능.
4. 조건을 만족한 작업은 `RUNNING` 상태로 원자적 예약 후 모의 실행기에 전달, `WAIT_EXTERNAL`에서 사용자의 모의 완료/실패 결정을 기다림.
5. 모의 완료를 선택한 작업은 `COMPLETE`; 다음 작업은 **새 작업 준비**로 버전을 올려야만 다시 1회 실행.
6. 모의 실패는 `BLOCKED`로 멈춤. 미확인·재시작 중인 실행은 `UNKNOWN`으로 보류.
7. 취소로 `WAIT_HUMAN`에 진입한 작업은 별도 **모의 작업 승인**으로만 재개.

SQLite 위치: 기본 `.autopilot/autopilot.sqlite3` (이 폴더는 gitignore로 제외). 환경변수 `AUTOPILOT_DB`로 경로 변경 가능. `AUTOPILOT_PORT`로 로컬 포트 변경 가능.

## 안전 장치

- 등록만 해서는 어떠한 외부 코딩 동작도 하지 않음.
- **전체 정지 버튼**은 신규 모의 실행 예약을 차단하고 재시작 후에도 정지 상태를 유지함. 재개는 명시적 조작 필요.
- DB 트랜잭션과 `dedupe_key=(workstream ID, task revision, command kind)` 유니크 제약으로 반복 타이머의 중복 작업 예약 방지.
- 한 작업축당 실행 중 작업 1개. 작업축 A의 CI 대기를 작업축 B에 적용하지 않음.
- 타이머는 **정해진 작업을 무조건 실행하는 주기**가 아니라 **실행 자격을 검사하는 주기**.
- 컴퓨터가 절전에서 돌아와도 밀린 타이머를 횟수만큼 반복 제출하지 않음.
- 재시작 당시 RUNNING 작업은 자동 재제출하지 않고 UNKNOWN으로 보류, 실행 ID 보존.
- 조회에 사용된 이벤트·실행 이력은 SQLite에 영구 기록.
- Localhost 대시보드의 POST는 동일 Origin + JSON만 허용. 외부 서버 통신이나 GitHub 쓰기는 없음.
- 프롬프트 제출, CI 상태 조작, GitHub 병합, 사용자 승인 자동 클릭 등 실제 부작용이 전혀 없는 **모의 실행 단계**.
- 사람 승인·실패·불명 상태를 텍스트만 보고 우회하지 않음.

## 이번 단계에서 미구현인 것

- Chrome 확장 등록 상태를 로컬 엔진 Workstream에 연결하는 IPC.
- Windows EXE / 트레이 앱. 현재는 Node.js가 실행 중인 동안만 웹 대시보드 동작.
- Watchtower 데이터 조회와 GitHub PR/CI 검증 (Phase 3).
- 실제 AI 코딩 실행 또는 ChatGPT 웹 입력 (Phase 4, 허용 경로 확인 필요).
- 자동 로드맵 갱신과 이관 (Phase 5–6).
- 완전한 역할 기반 인증, 토큰 기반 localhost 프로세스 권한 분리. 현재 브리지는 개인 PC에서 **모의 작업만** 제어할 수 있는 제한된 서버임.

## 체크리스트

- [x] SQLite 스키마, 트랜잭션, Task Revision / Operation ID / 이벤트 이력
- [x] 관찰 기본 모드 및 명시적 모의 실행 허용
- [x] 작업축별 주기 및 상태 평가
- [x] 이중 타이머 및 프로세스 재시작 시 중복 예약 방지
- [x] 모의 실행 성공/실패/중단 기록 및 수동 상태 제어
- [x] 기본 HTTP 제어 화면
- [x] 전역 긴급 정지/재개 및 SQLite 영속 복구
- [x] 모의 실행 안전성 자동 테스트 작성
- [x] localhost HTTP 정상 흐름 및 교차 출처 변경 차단 통합 테스트
- [x] Windows + Ubuntu CI 자동 검증
- [ ] 실제 Windows 환경 실행 확인
- [ ] 확장 프로그램과의 인증된 로컬 연결
- [ ] CI Watchtower 연결 (해당 저장소 작업 완료 후)
- [ ] 본격적인 승인/알림/실행 엔진

## 자동 검증 근거

- GitHub Actions: CI run `38329178975` (Ubuntu/Windows 각 1 job, 둘 다 성공)
- 작업 실행·중복 예약·재시작 복구 등 Node 단위 테스트 통과
- localhost HTTP API 오리진 제한/등록/모의 실행/결과 확정 시나리오 통과
- 브라우저 수동 설치/실제 PC 절전·재시작 테스트는 **별도 미검증**

## 다음 진행

1. GitHub Actions CI 확인 및 발견 오류 수정.
2. Phase 01 확장 프로그램의 실제 Chrome 설치·실행 확인.
3. Phase 01 확장 프로그램 ↔ Phase 02 로컬 상태 엔진 연결 방법 확정 (인증된 localhost 또는 Native Messaging).
4. Watchtower 읽기 전용 인터페이스 구현 결과를 수령하면 Phase 3 어댑터 착수.

## 종료 판단

- GitHub CI가 통과하면 **로컬 코어·테스트 구현 검증 완료**, 사용자 Windows 실기기 검증은 여전히 별도.
- 브라우저/로컬 IPC 미연결이므로 Phase 2의 모든 원래 완료 조건을 충족했다고 주장하지 않음.
- 현재 구현은 MVP 증가분이며 실제 개발 자동 실행 기능으로 오해하지 않도록 문서/화면에 표시.

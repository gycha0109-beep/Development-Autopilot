# Phase 02 — Chrome ↔ Local Bridge

> 브랜치: feat/phase02-chrome-local-bridge
> 목표: 기존 Chrome 탭 등록 정보를 로컬 SQLite Workstream에 안전하게 연결합니다.
> AI 프롬프트 제출, GitHub 수정, Watchtower 변경은 구현하지 않습니다.

## 실행 순서

1. Windows에서 Node.js 22.16 이상을 준비하고 이 브랜치를 체크아웃합니다.
2. 로컬 관리자: npm run check → npm start
3. http://127.0.0.1:48173 으로 접속합니다.
4. Chrome 주소창에서 chrome://extensions → 개발자 모드 → 압축해제된 확장 프로그램 로드 → 저장소 extension 폴더 지정.
5. 확장 프로그램 관리 화면에서 Chrome 탭 그룹과 관리할 탭을 각각 등록합니다.
6. 로컬 관리자에서 연결 코드 발급(5분 유효) → Chrome 확장 관리 화면에서 코드 입력 → 로컬 연결.
7. 로컬 관리자에 작업축을 등록하고 연결할 등록 탭을 선택합니다.

**중요:** 로컬 서버 포트는 48173이 기본값이며 확장의 host permission과 동일해야 합니다. 현재 Chrome과 로컬 관리는 다른 화면으로 제공됩니다.

## 아키텍처

- 로컬 관리 서버: local/server.js
- SQLite 기반 페어링, 상태, Workstream 연결: local/chrome-bridge.js
- Chrome 서비스 워커: extension/background.js
- 등록된 탭만 최소 메타정보로 변환: extension/bridge-core.js
- 양쪽 화면: local/public/*, extension/options.*

### 데이터

Chrome 확장은 사용자가 등록한 탭 목록만 보냅니다.

| 필드 | 의미 |
|---|---|
| sessionKey, groupKey | Chrome 확장이 만든 지속 등록 ID |
| groupLabel, title | 등록 당시 그룹·탭 제목 |
| origin | 사이트 Origin만 전달. 전체 대화 URL/경로 전송 금지 |
| status | connected, missing, paused, needs-rebind, url-changed 등 |

로컬 SQLite에는 전송된 제목 및 Origin과 연결 식별자를 기록하므로, 로컬 저장소에 접근하는 사용자는 이 메타정보를 볼 수 있습니다. **대화 본문·쿠키·대화 경로·외부 서비스 비밀정보는 전송하지 않습니다.**

## 보안

- 브리지는 127.0.0.1에만 바인딩됩니다.
- Chrome 확장이 접근할 수 있는 경로는 /api/v1/bridge/pair 및 /api/v1/bridge/sync입니다.
- 정상 Chrome 확장 ID를 포함한 chrome-extension Origin만 CORS 허용합니다.
- 로컬 관리 API는 기존처럼 localhost 웹 화면의 same-origin JSON POST만 허용합니다.
- 페어링 코드는 20자리 일회용, 5분 TTL, 5번 실패하면 무효화됩니다.
- 인증에는 256비트 랜덤 토큰을 사용하며 서버에는 SHA-256 해시만 기록합니다. Chrome 확장은 토큰을 로컬 저장소에 보관합니다.
- 서버에서 페어링 해제 시 토큰과 연결이 모두 철회됩니다. 확장 프로그램의 연결 해제 버튼은 확장 측 토큰만 지웁니다.
- 마지막 동기화로부터 150초가 지나면 Chrome 상태를 stale로 취급합니다.
- 재시작 후 번호가 같은 다른 탭으로 자동 연결하지 않습니다. 필요한 경우 사용자가 확장 프로그램에서 재연결해야 합니다.
- 서로 다른 Workstream이 하나의 등록 탭에 동시 연결되지 않도록 SQLite UNIQUE 제약을 사용합니다.
- 브라우저와 로컬 상태만으로 AI 코드 실행 권한을 생성하지 않습니다.
- 같은 PC의 임의 로컬 네이티브 프로세스를 OS 차원에서 구분하는 인증은 아직 구현되지 않았습니다. 이 단계는 모의 실행 전용입니다.

## 로컬 API

| 메서드 | 경로 | 권한 |
|---|---|---|
| POST | /api/v1/bridge/pairing/start | 로컬 관리 화면 |
| POST | /api/v1/bridge/unpair | 로컬 관리 화면 |
| POST | /api/v1/workstreams/:id/link-chrome | 로컬 관리 화면 |
| GET | /api/v1/snapshot | 기존 로컬 화면, chromeBridge 데이터 추가 |
| OPTIONS/POST | /api/v1/bridge/pair | Chrome 확장 + 일회용 코드 |
| OPTIONS/POST | /api/v1/bridge/sync | Chrome 확장 + 유효한 Bearer 토큰 |

동기화 JSON 스키마 버전은 1입니다. 허용 목록을 넘어선 메타정보는 버리고, 등록된 세션 최대 150개만 전송됩니다.

## 검증

자동 테스트: 코드 만료·재사용·잘못된 Origin·인증 실패·TTL·중복 매핑·등록 탭만 전송·기존 상태 엔진 회귀.

추가 실기기 검증:
- [ ] Windows Chrome에 확장 설치 후 코드 페어링
- [ ] 그룹/탭 등록 및 로컬 작업축 연결
- [ ] Chrome 재시작 / 확장 reload / URL 변경 / 그룹 이동
- [ ] 로컬 프로그램 종료 → TTL 만료 → stale 처리
- [ ] 다른 Chrome 창의 동일 URL 탭 오연결 방지
- [ ] 연결 해제 및 재페어링 시 등록 복구 UX 확인

## 후속 단계

- Watchtower 팀의 읽기 전용 계약이 준비되면 Phase 03 연결을 진행합니다.
- 현재 로컬 관리 엔진은 모의 실행만 지원합니다.
- Windows 설치 프로그램·트레이 및 공식 지원되는 개발 실행 어댑터는 이후 단계에서 별도 구현합니다.

# Development Autopilot

**여러 개발 프로젝트의 반복적인 후속 지시, CI 확인, 로드맵 관리, 대화방 이관을 연결하는 Windows 로컬 개발 운영 관리자**입니다.

> **현재 상태: Phase 0–2 Chrome 확장·SQLite 상태 엔진·로컬 브리지 + Phase 3 Watchtower 소비자 구현 중**  
> 로컬 SQLite·스케줄러·모의 실행 관리 화면까지 코드가 구현되었습니다. Windows EXE와 실제 AI 코딩 실행은 아직 구현되지 않았으며, Watchtower 연동은 코드 수준의 관측 기능만 추가되었습니다.

## 빠른 시작 — 로컬 관리 엔진 (Phase 2)

Node.js 22.16 이상 필요 (내장 `node:sqlite` 사용, 현재 실험적 API). 이 브랜치를 받은 뒤 다음을 실행하십시오.

```powershell
npm run check
npm start
```

`http://127.0.0.1:48173`에서 작업축 등록, 35분 주기 상태 확인, 수동 승인 기반 모의 실행을 이용할 수 있습니다. **현재는 모의 실행 전용이므로 ChatGPT에 메시지를 전송하지 않습니다.** 등록 정보는 `.autopilot/autopilot.sqlite3`에 보존됩니다.

[Phase 2 구현·검증 상세](docs/PHASE-02-IMPLEMENTATION.md)

## 통합 의사결정 게이트 (Phase 3-C)

CI Watchtower 관측 + GitHub PR 사실 검증 + 로컬 정지/작업 버전 정책을 통합합니다. 두 관측 모두 신선하고 정확히 일치해도 **최종 결론은 사용자 근거 확인 대기**이며 실제 AI 실행은 허용하지 않습니다.

로컬 대시보드의 **모든 근거 재검증**에서 판단·사유·이력을 확인할 수 있습니다. 사용자 **근거 확인 (모의)**는 검토 기록만 남기며 15분 후 만료합니다.

[Phase 3-C 구현 및 판단 규칙](docs/PHASE-03-DECISION-GATE.md)

## GitHub PR 독립 검증 (Phase 3-B)

Watchtower가 CI 성공을 보고하더라도 이를 자동 실행 허가로 처리하지 않고, 별도 GitHub CLI의 **읽기 전용 API**로 PR Head SHA, 필수 체크, 병합 여부를 다시 확인합니다.
로컬 관리 화면에 PR 번호와 40자리 Head SHA를 연결하고 **PR 상태 확인**을 선택하십시오.
GitHub CLI 인증 및 Branch Protection / Ruleset 조회 권한이 필요하며, 확인할 수 없는 조건은 UNKNOWN으로 처리합니다.

[Phase 3 GitHub 검증기 문서](docs/PHASE-03-GITHUB.md)

## CI Watchtower 연결 (Phase 3)

CI Watchtower v0.3.39 이상의 읽기 전용 localhost 브리지를 실제 v1.0 계약으로 조회합니다.
Watchtower를 **동일한 Windows 사용자**로 실행한 뒤 로컬 대시보드에서 **CI 상태 새로고침**을 선택하십시오.
Workstream별 Watchtower Repository ID, GitHub Run ID, 40자리 Head SHA, Attempt를 지정하면 관측 결과를 표시합니다.
Windows Credential Manager의 전용 브리지 키를 사용하며, GitHub PAT는 가져오지 않습니다.

**CI 성공은 개발 재개 허가가 아닙니다.** 현재는 WAIT_EXTERNAL / BLOCKED / VERIFY_GITHUB / UNKNOWN 상태 확인만 지원합니다.

[Phase 3 구현·설치·검증 문서](docs/PHASE-03-WATCHTOWER.md)

## Chrome ↔ 로컬 프로그램 연결 (Phase 2 추가)

로컬 대시보드에서 **연결 코드 발급**을 선택하고, Chrome 확장 관리 화면의 **로컬 연결**에 코드를 입력하십시오.
연결되면 확장 프로그램에서 등록한 탭을 로컬 Workstream에 **직접 선택하여 매핑**할 수 있습니다.
등록 탭의 상태·제목·사이트 Origin만 동기화되며, 대화 본문이나 전체 대화 URL은 전송하지 않습니다.
현재 로컬 프로그램은 **시뮬레이션 전용**입니다.

[브리지 구현·설치 및 검증 문서](docs/PHASE-02-CHROME-BRIDGE.md)

## 빠른 시작 — Chrome 확장 프로그램

1. 이 저장소의 소스 코드를 내려받습니다. (`Code → Download ZIP`, 압축 해제 또는 `git clone`)
2. Chrome 주소창에 `chrome://extensions`를 입력하고 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다** → 저장소 안의 **`extension` 폴더** 선택.
4. 확장 프로그램 아이콘을 누르고 **관리 화면 열기**를 선택합니다.
5. Chrome 탭 그룹의 **그룹 등록**을 누르고, 아래에서 관리할 탭을 각각 **탭 등록**합니다.

**중요:** 현재 버전은 화면의 탭 제목·URL 메타정보를 읽어 등록 상태를 관리할 뿐, ChatGPT 메시지 본문을 읽거나 프롬프트를 자동 제출하지 않습니다. 확장 프로그램의 브라우저 실기기 확인은 필요합니다.

## 개발 및 테스트

Node.js 22.16 이상을 사용합니다. 외부 npm 의존성은 없습니다.

```powershell
npm run check
```

`node --check` 및 Node 내장 테스트 러너로 레지스트리·브라우저 재연결·권한 관련 회귀 테스트를 실행합니다.

**구현 기록:** [Phase 0–1 구현 및 설치·검증 지침](docs/PHASE-01-IMPLEMENTATION.md)

## 문서 안내

| 문서 | 내용 |
|---|---|
| **[전체 개발 로드맵](docs/ROADMAP.md)** | 한국어 마스터 로드맵, Phase 0~8, 단계별 목표·작업·완료 기준 |
| [Phase 0–1 구현 기록](docs/PHASE-01-IMPLEMENTATION.md) | Chrome 확장 기능과 설치·검증 |
| [Phase 2 구현 기록](docs/PHASE-02-IMPLEMENTATION.md) | SQLite 로컬 상태 엔진, 스케줄러, 모의 대시보드 및 제약 |
| [시스템 아키텍처](docs/ARCHITECTURE.md) | Chrome 확장, 로컬 관리자, Watchtower, GitHub, 실행 어댑터의 역할 |
| [운영 및 승인 정책](docs/OPERATING-POLICY.md) | 승인 경계, 자동 진행 조건, 중복 실행 방지, 대화 이관 및 이용 제한 |
| [검증 계획](docs/VALIDATION.md) | 테스트 시나리오와 단계별 통과 기준 |
| [설계 결정 기록](docs/DECISIONS.md) | 확정 사항과 구현하면서 결정할 기술 선택 |

## 아키텍처

```text
Chrome 탭 그룹 ─→ Chrome MV3 확장 프로그램 (현재 구현)
                              │
                              ▼
                  Development Autopilot (Windows, 예정)
                   ├─ 프로젝트·작업축·세션 관리
                   ├─ 스케줄러 / 상태 판단 / 정지·승인
                   ├─ CI Watchtower 연동 (읽기 전용)
                   ├─ GitHub PR·커밋·CI 검증
                   ├─ 지원되는 개발 실행 어댑터
                   └─ 로드맵·CURRENT_STATE·HANDOFF 문서
```

현재 Chrome 확장 프로그램 옵션 화면과 Node.js 로컬 대시보드는 별도로 동작합니다. 인증된 연결 IPC, Windows 실행 파일 및 Watchtower 연동은 후속 Phase입니다.

## 최종 지향점

사용자가 승인한 개발 범위 안에서 **작업 수행 → 실제 결과 검증 → CI 대기·확인 → 로드맵 갱신 → 새 세션 인수인계**를 안전하게 이어가는 것입니다.

AI의 출력 문구만으로 완료를 인정하거나, 승인·이용약관·사용량 제한을 우회하지 않습니다. 로컬 운영 기능에는 별도 모델 API가 필요하지 않지만 실제 자동 AI 실행의 비용과 지원 범위는 향후 결정하는 허용된 실행 어댑터에 따릅니다.

## 연계 프로젝트

[CI Watchtower](https://github.com/gycha0109-beep/CI-Watchtower): 기존 GitHub Actions 상태 및 Project/Track 귀속 감시 프로그램. 후속 Phase에서는 읽기 전용 연동 인터페이스로 재사용할 계획입니다.

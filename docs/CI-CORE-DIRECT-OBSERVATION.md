# Autopilot ↔ CI Core: WatchTower UI 없는 직접 조회 (Preview)

## 현재 구현

WatchTower [PR #71](https://github.com/gycha0109-beep/CI-Watchtower/pull/71)은 Rust CI Core 기반 Windows `ci-core-inspect.exe`를 생성합니다. WatchTower UI나 48765 포트를 켜지 않고, **현재 GitHub PR + 명시적 Run/Attempt**를 일회성으로 확인합니다. 공통 Core의 실제 CI 수집 코드 분리는 #69 / #70, 공통 기능은 #71입니다. 모두 미병합 변경이며 직접 조회 도구는 현재 debug preview 산출물입니다.

이번 Autopilot 변경은 기존 WatchTower 클라이언트를 바꾸거나 성공 판정을 우회하지 않고, **직접 관측 결과를 별도 항목으로 표시하는 선택적 연결**입니다.

1. 동일한 Windows 사용자 계정의 Credential Manager에서 WatchTower `ci-watchtower` / `github-pat`를 읽습니다. Autopilot은 PAT를 받거나 복사하지 않습니다.
2. Autopilot에서 기존에 **명시적으로 연결한 GitHub PR·HEAD SHA 및 WatchTower Run ID·Attempt**를 사용합니다. WatchTower UI를 닫아도 기존 등록된 Autopilot 대상 설정을 사용합니다.
3. Run마다 GitHub PR을 전후 두 번, 현재 Actions Run을 한 번 조회합니다. 명령줄에는 PR/SHA/Run ID/Attempt만 전달하고 PAT·브리지 토큰을 전달하지 않습니다.
4. 결과는 Autopilot `GET /api/v1/snapshot`의 `directCiCore` 및 동일 출처 `POST /api/v1/ci-core/refresh`에 나타납니다.
5. **자동 진행/병합/승인에 직접 활용하지 않습니다.** 기존 `watchtower`, `github`, `ciProgress`, `decisionGate`와 관련 운영 정책은 그대로 유지합니다.

## Windows 선택적 실행

해당 PR이 통과한 뒤 #71의 `ci-core-headless-preview` 아티팩트에서 exe를 검사/추출하여 **신뢰된 절대경로**에 배치하고, Windows 동일 사용자 Autopilot 시작 환경에 다음 설정을 추가합니다.

```powershell
$env:CI_CORE_INSPECT_EXE = "C:\Path\To\Trusted\ci-core-inspect.exe"
npm start
```

위 경로는 **자리표시자**입니다. 실제 파일 경로를 검증한 후 설정하십시오. 이 환경변수가 없거나 Windows exe 절대경로가 아니면 `directCiCore.status="disabled"`로 남으며, 기존 WatchTower 동작은 유지됩니다.

직접 조회는 **최대 8개 Workstream을 한 번에**, 최소 2분 간격으로 확인합니다. 대상이 더 많으면 회차마다 대상을 순환하여 GitHub API 과다 호출을 제한하고, 이번 회차에서 조회하지 않은 대상은 `DIRECT_RATE_BUDGET`으로 표시합니다. 자동 재시도 폭주나 새 Poller를 만들지 않습니다.

## 판정 경계

- 입력: GitHub PR, 40자리 Head SHA, 정확한 Run/Attempt, 기존 Autopilot Workstream repository.
- 출력: `source=github_actions_direct`, `ciState`, `decision`, Run/PR 식별자와 관측 시각, `safeToAdvance=false`.
- 단일 성공: `VERIFY_GITHUB`. 다시 필수 검사·PR 상태·사용자 승인 검증이 필요합니다.
- 미확정 Integration 후보/기준 SHA, 과거 Attempt, 다른 HEAD/Repository, 없는 자격증명, 오프라인, API 장애: `UNKNOWN` 또는 명시적인 외부 오류.
- 복수 CI/Workflow 보장과 프로젝트/Track 귀속의 완전성은 아직 없음. WatchTower SQLite/Track/수동 귀속 정보를 이 일회성 CLI가 재구현했다고 주장하지 않음.
- CLI 단독 관측은 현재 `CiProgressObserver`의 GREEN 근거가 아니며, 기존 승인 대기/중지 상태를 변경하지 않습니다.

## 실환경 Acceptance (미완료)

- #70과 #71의 Fast/Full CI, Windows exe 아티팩트, CLI 단독 테스트
- 해당 Autopilot PR의 Windows + Linux Node CI (실제 릴리스 적용 전에 모두 통과 필요)
- Windows 실사용 PAT·Run을 통한 CLI 직접 조회 및 WatchTower 프로세스 종료 비교
- 기존 Autopilot과 WatchTower SQLite/설정/Registry 데이터의 전후 보존 검사
- Integration CI pinned base 및 GitHub Required Checks의 독립 확인
- 장기적으로 Rust Core가 UI 없는 **단일 writer**로 SQLite/Track/Producer/폴링까지 관리하는 과정과 기존 실행기 전환

**배포/병합 승인:** 두 저장소의 미병합 PR을 CI GREEN만으로 병합하거나 사용자 Windows 앱을 교체하지 않습니다.

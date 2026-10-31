# Autopilot: WatchTower 없이 Project / Repository / Track 조회

CI-WatchTower [#73](https://github.com/gycha0109-beep/CI-Watchtower/pull/73)의 `ci-core-registry.exe`를 Autopilot이 선택적으로 호출합니다. 이미 구성된 **같은 사용자**의 WatchTower SQLite를 읽기 전용으로 여는 기능이며, 기존 WatchTower 프로세스/localhost API가 꺼져도 동작하도록 설계되었습니다.

## 조건 및 위치

- Windows CI #73의 `ci-core-headless-preview`에서 `ci-core-inspect.exe`와 `ci-core-registry.exe`를 같은 신뢰된 폴더에 배치합니다.
- `CI_CORE_INSPECT_EXE`를 전용 폴더 내 검사기로 지정하면 `ci-core-registry.exe`도 자동으로 같은 폴더에서 찾습니다. 별도 경로가 필요한 경우 `CI_CORE_REGISTRY_EXE`를 지정하십시오.
- 기존 DB 경로는 `%APPDATA%\com.gycha.ciwatchtower\ci-watchtower.sqlite3`입니다. 별도 읽기 경로를 사용할 때만 `CI_WATCHTOWER_DB`를 지정하십시오.
- Autopilot이 시작되면 읽기 전용 조회를 수행합니다. 이후 최대 2분 간격으로 갱신합니다. 경로가 없으면 기능을 비활성화하거나 오류로 표시하고 기존 운영을 변경하지 않습니다.

## 확인

- 로컬 관리 화면의 `GET /api/v1/snapshot`에 `directCiRegistry`가 추가됩니다.
- 관리 화면과 같은 출처에서 `POST /api/v1/ci-core/registry/refresh`로 읽기 전용 갱신을 요청할 수 있습니다. 기존 작업 실행 버튼·승인 정책과 연결되지 않습니다.
- JSON 필드는 `projects`, `repositories`, `tracks` 및 `checkedAt`, `status`, `errorCode`. 인증값과 SQLite 원본 에러 텍스트는 반환하지 않습니다.
- `readOnly=true`이고 `safeToAdvance=false`인 응답만 수용합니다. 불완전/낡은/모순된 ID 정보는 폐기합니다.
- 실제 CI 결과는 별도 `directCiCore` 관측이며, 정확한 PR·HEAD SHA·Run·Attempt 바인딩이 필요합니다. 등록 목록은 CI 성공·필수 검사·PR 승인 근거가 아닙니다.

## 제한

자동 프로젝트별 전체 Runs 수집, 수동 귀속, Slack/Telegram 알림, BuildMap 원격 검증, 알림 이력, SQLite 단일 쓰기 프로세스는 이 변경으로 완료되지 않습니다. 기존 `watchtower`·`github`·`ciProgress`·`decisionGate`는 변경하지 않으며, 이 기능은 독립 관측으로만 사용합니다.

미병합 Preview로서 운영 프로그램에 자동 적용되지 않습니다. 설치본 교체와 PR 병합은 별도 승인 전 수행하지 않습니다.

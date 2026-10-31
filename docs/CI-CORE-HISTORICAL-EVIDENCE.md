# Autopilot: CI Core 기존 Run/Attempt/Track 이력 조회

CI WatchTower [#74](https://github.com/gycha0109-beep/CI-Watchtower/pull/74)의 `ci-core-history.exe`가 기존 SQLite를 읽기 전용으로 조회합니다. Autopilot은 등록 목록 `directCiRegistry`가 관측된 경우에만 활성 저장소별 최근 최대 20개 기록을 조회합니다.

- Windows에서 신뢰된 같은 디렉터리에 `ci-core-inspect.exe`, `ci-core-registry.exe`, `ci-core-history.exe`를 배치합니다. `CI_CORE_INSPECT_EXE`를 설정하면 나머지는 같은 디렉터리를 사용합니다. 개별 경로는 `CI_CORE_HISTORY_EXE`로 지정할 수 있습니다.
- 기존 DB는 기본적으로 `%APPDATA%\com.gycha.ciwatchtower\ci-watchtower.sqlite3`에 있습니다. 다른 파일을 읽어야 하는 경우에만 `CI_WATCHTOWER_DB`를 사용합니다.
- Autopilot 서버의 `GET /api/v1/snapshot`은 `directCiHistory`를 추가하고, 로컬 동일 출처 `POST /api/v1/ci-core/history/refresh`는 읽기 전용 갱신을 요청합니다.
- 최대 4개 저장소/2분, 저장소별 최대 20개 기록만 조회합니다. 나머지는 `HISTORY_RATE_BUDGET`으로 나타납니다. 누락을 성공이나 완료로 취급하지 않습니다.
- 이전 Run/Attempt의 성공·취소·트랙 배정은 감사/이력 기록일 뿐입니다. 모든 결과는 `historicalOnly=true`, `completeCoverage=false`, `safeToAdvance=false`이며 기존 자동 진행·병합·인증·승인 판단에 연결되지 않습니다.
- 기존 WatchTower의 SQL 기록을 변경하거나 다른 writer를 띄우지 않으며, CLI 실패·비정상 스키마는 안전하게 `UNKNOWN`/unavailable로 표시합니다.

**남은 단계:** UI 없는 GitHub 수집 및 단일 SQLite writer, Run/Attempt/Track 책임 귀속의 최신성 판단, 장시간 동시 실행 차단, BuildMap 인증된 증거 전달, 사용자 PC 운영본 적용과 최종 승인. 미병합 PR의 CI 성공은 운영 배포 승인이 아닙니다.

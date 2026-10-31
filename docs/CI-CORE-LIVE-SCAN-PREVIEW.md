# Autopilot — WatchTower UI 없는 최신 GitHub CI 스캔

CI WatchTower [#75](https://github.com/gycha0109-beep/CI-Watchtower/pull/75)의 `ci-core-scan.exe`를 Autopilot이 **선택적으로 실행**합니다. Windows 사용자 Credential Manager에 이미 저장된 PAT를 공통 Rust 실행 파일 내부에서 읽으며, WatchTower 앱이나 48765 포트를 켤 필요가 없습니다.

## 실행 조건

- `ci-core-inspect.exe`, `ci-core-registry.exe`, `ci-core-history.exe`, `ci-core-scan.exe`를 신뢰된 폴더에 배치합니다.
- `CI_CORE_INSPECT_EXE`를 지정하면 최신 스캔 도구는 기본적으로 같은 폴더의 `ci-core-scan.exe`를 사용합니다. 별도 절대 경로는 `CI_CORE_SCAN_EXE`로 지정 가능합니다.
- `directCiRegistry`에서 기존 DB의 **활성** 저장소 이름을 읽은 뒤 최대 **2개 저장소/2분**씩 순환 조회합니다. 저장소당 API GET은 최대 6회, 최대 30개 실행 결과만 반환합니다.
- 401/403/429 등의 인증·요청 제한 오류 시 다음 저장소 호출을 멈추고 **15분 백오프**합니다. PAT·원본 응답·SQL 오류 텍스트는 로그나 관리 API에 출력하지 않습니다.

## 확인과 경계

`GET /api/v1/snapshot`에서 `directCiScan`, 같은 출처의 `POST /api/v1/ci-core/scan/refresh`에서 갱신 결과를 확인합니다. 관리 화면은 관측된 최근 CI 실행 수 및 진행/대기 수를 **부분 관측**으로 표시합니다.

**이 기능은 CI의 완전한 성공·최종 병합 가능성·승인이 아닙니다.** 최신 실행 목록은 누락 가능성이 있고 정확한 PR/HEAD SHA·Run/Attempt 동일성, 필수 검사, 통합 기준 SHA, Track 귀속 및 사용자 승인을 보장하지 않습니다. 모든 결과와 기존 자동 진행 정책은 `safeToAdvance=false`로 유지됩니다.

## 남은 단계

- 실제 Windows에서 최신 실행 스캔 실조회 및 DB 원본 보존 검증
- 단일 UI 없는 Core writer로 Run/Attempt 수집·Track 귀속·폴링/이력/알림의 운영 책임 통합
- BuildMap에 별도 인증된 최소 범위의 증거 전달
- 프로덕션 설치 및 기존 WatchTower 브리지 의존 제거는 PR 병합·승인 이후 단계

현재 미병합 프리뷰이므로 집 PC 운영 Autopilot 실행본을 교체하지 않습니다.

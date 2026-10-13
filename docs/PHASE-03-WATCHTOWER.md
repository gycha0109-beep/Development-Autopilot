# Phase 03 — CI Watchtower 읽기 전용 소비자 연동

> 브랜치: feat/phase03-watchtower-consumer
> 계약: CI-Watchtower v0.3.39+ / HTTP Bridge contract 1.0
> 상태: 구현 및 CI 검증 단계 / 사용자 Windows 실환경 연결은 별도 확인 필요

## 구현 목표와 구조

기존 Watchtower에 이미 병합된 읽기 전용 HTTP API를 Autopilot에서 직접 조회합니다. Watchtower는 CI 수집·귀속 엔진이며 Autopilot은 근거를 소비합니다. Watchtower 코드·SQLite·PAT는 수정하지 않습니다.

Watchtower에서 제공하는 인터페이스:
- Base URL: http://127.0.0.1:48765/v1
- GET /health, /registry, /runs, /runs/{runId}
- 인증: 같은 Windows 사용자 Credential Manager의 서비스 ci-watchtower / 계정 development-autopilot-bridge-v1
- Run ID, 최신 Attempt, Head SHA, 책임 종류, Work Track 귀속, Poll 결과, 데이터 최신성.
- Watchtower는 단독 실행 승인 불가능을 명시하기 위해 safeToAdvance=false를 반환합니다.

이번 Autopilot 구현:
- local/watchtower-credential.ps1: Windows CredReadW 기반 Watchtower 전용 토큰 조회
- local/watchtower-client.js: API v1 계약 및 응답 검증, 토큰 조회/캐싱, 장애 분류
- local/watchtower-observer.js: Workstream 별 정확한 CI 타깃 저장·검증·상태 요약
- local/server.js: 45초 간격 관측 및 수동 다시 확인 API
- local/public: Watchtower 연결/Registry/Run 상태 표시 및 타깃 관리
- tests/watchtower-client.test.js 및 HTTP 회귀 테스트

## 사용 방법

1. CI Watchtower v0.3.39 이상을 동일한 Windows 사용자로 실행합니다.
2. Autopilot의 feat/phase03-watchtower-consumer 브랜치를 받습니다.
3. Node 22.16 이상에서 npm run check, npm start를 실행합니다.
4. http://127.0.0.1:48173 관리 화면의 CI Watchtower 카드에서 새로고침합니다.
5. Watchtower Registry의 Project/Repository/Track과 Autopilot Workstream이 일치하는지 확인합니다.
6. 작업축, 정확한 Watchtower Repository ID, GitHub Run ID, Head SHA 40자리, Run Attempt를 지정합니다.
7. 읽기 전용 결정 WAIT_EXTERNAL / BLOCKED / VERIFY_GITHUB / UNKNOWN 등을 확인합니다.

Run을 연결하지 않은 Workstream은 조회 대상으로 간주하지 않으며, 성공 또는 완료로 처리하지 않습니다.

## CI 판단 규칙

| 신선한 근거 | Autopilot 관측 상태 | 자동 실행 |
|---|---|---|
| 정확한 Run이 queued 또는 running | WAIT_EXTERNAL | 금지 |
| 정확한 Run이 failed | BLOCKED | 금지 |
| 정확한 Run이 success | VERIFY_GITHUB | 금지 |
| cancelled / timed_out / other terminal | BLOCKED | 금지 |
| Stale / Unknown / Poll Error / Conflict | UNKNOWN | 금지 |
| 다른 Track 또는 Repository와 매핑 불일치 | UNKNOWN | 금지 |
| 과거 Run Attempt, 다른 HEAD SHA | UNKNOWN | 금지 |
| Watchtower 중단·토큰/Windows 계정 오류 | UNKNOWN | 금지 |

위 결과는 **관측용**입니다. 성공한 CI 하나가 GitHub 필수 체크 전부, 현재 PR Head SHA, 병합 여부, 사람 승인을 증명하지 못합니다. GitHub 독립 검증기가 완성되기 전에는 READY로 자동 전환하지 않습니다.

## 보안 경계

- Windows 키링의 전용 토큰만 읽으며 GitHub PAT를 사용하지 않습니다.
- 정확한 Generic Credential target: development-autopilot-bridge-v1.ci-watchtower.
- 토큰은 로컬 Node 프로세스 메모리에만 보관하며 API 응답·Chrome 확장·SQLite·로그에 노출하지 않습니다.
- Watchtower에 Origin 헤더 없이 Authorization Bearer를 전송합니다.
- 계약 버전 1.0 불일치·로그인 실패·네트워크 장애·기한 지난 관측을 안전한 UNKNOWN으로 처리합니다.
- 이번 단계는 별도 인터넷으로 CI를 새로 폴링하지 않습니다. Watchtower의 이미 관측된 캐시만 읽습니다.
- Windows 같은 사용자 권한의 로컬 멀웨어를 방어하는 OS 격리는 별도 보안 설계가 필요합니다.

## 검증 범위

자동 검증:
- 인증 헤더, 계약 버전, registry, 정확한 Run/SHA/Attempt 확인
- 네트워크 오류/401/409/503 및 응답 스키마 검사
- 다른 Track/Repo, 과거 GREEN, 폴링 오류 및 충돌 차단
- 어떤 성공 근거도 GitHub 독립 검증 전에는 자동 실행 불허
- SQLite 영속 설정과 로컬 HTTP Cross-origin 제약
- 기존 Phase 1/2 Chrome 연동·스케줄러 테스트 회귀

사용자 Windows PC에서 추가해야 할 항목:
- [ ] Watchtower v0.3.39+ 설치 및 트레이 작동
- [ ] Credential Manager 인증 성공과 401/프로세스 종료 처리
- [ ] 실제 Registry/Run ID/Head SHA/Attempt 조회
- [ ] Watchtower 재시작·오프라인 후 복구
- [ ] 기존 Watchtower 저장소/Registry/이력 불변성 확인

## 다음 단계

Watchtower 계약은 연동되었으나 GitHub PR 최종 검증은 아직 구현되지 않았습니다. 다음 구현은 정확한 PR Head/Required Checks/Review/Merge 상태를 독립 검증하여 이 관측 결과와 결합하는 것입니다. 로드맵 갱신·AI 실행은 그 이후 진행합니다.

원본 계약: https://github.com/gycha0109-beep/CI-Watchtower/blob/main/docs/integrations/development-autopilot.md

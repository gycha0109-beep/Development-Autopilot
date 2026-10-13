# Phase 03-B — GitHub 독립 PR 검증기

> 브랜치: feat/phase03-github-verifier
> Watchtower Phase 03 소비자 작업 후속
> 실행 범위: GitHub 읽기 전용 PR/Check 사실 검증. 자동 병합·개발 재개 미구현.

## 개발 목적

CI Watchtower가 FRESH SUCCESS를 보고하더라도 PR의 현재 Head SHA, 필수 체크, 승인 및 병합 여부는 Watchtower 혼자 보장할 수 없습니다. GitHub 독립 검증기가 실제 원격 저장소 상태를 확인하고, 정보가 부족하면 자동 진행을 차단합니다.

## 기술 및 연결

- local/github-verifier.js: GitHub CLI(gh) read-only REST 요청 및 PR 검증 엔진
- local/github-observer.js: GitHub PR 번호/예상 SHA를 로컬 SQLite Workstream에 저장, 상태 스냅샷
- local/server.js: 2분 간격 조회 및 수동 새로고침/매핑 API
- local/public/*: 작업축별 PR 번호/예상 Head SHA 입력, 병합·검증 상태 표시
- tests/github-verifier.test.js, tests/local-http.test.js: 성공/오류/중복·불일치 검증

Node에서는 gh api --method GET 명령만 실행하며, 로그인 정보나 GitHub 토큰을 명령 인수로 전달하지 않습니다. git remote 수정, PR 병합, 사용자 권한 변경 명령은 실행하지 않습니다. Watchtower GitHub PAT를 직접 읽지 않습니다.

## 준비 및 사용

Windows:
1. GitHub CLI(gh)를 설치하고 필요한 읽기 권한의 사용자 계정으로 gh auth login을 완료합니다.
2. Dev Autopilot에서 npm run check, npm start 실행 후 http://127.0.0.1:48173 접속.
3. GitHub PR 사실 검증 영역에서 Workstream, 실제 PR 번호, 예상 Head SHA 40자리를 연결.
4. PR 상태 확인 버튼을 누르면 GitHub의 실제 PR/Check 데이터를 조회합니다.
5. Watchtower Run Target의 SHA와 GitHub PR Target SHA가 다르면 조회 전에 UNKNOWN으로 중단합니다.

GitHub CLI 설치 및 인증은 사용자 Windows 실환경에서 별도 필요합니다. CI 테스트는 주입한 가짜 GitHub 응답으로 수행하여 로그인·외부 네트워크 없이 재현합니다.

## 관측 API

읽기 전용 GitHub REST 엔드포인트:
- GET /repos/{owner}/{repo}/pulls/{number} (검증 전/후 2회)
- GET /repos/{owner}/{repo}/commits/{sha}/check-runs?per_page=100&filter=latest
- GET /repos/{owner}/{repo}/commits/{sha}/status
- GET /repos/{owner}/{repo}/branches/{base}/protection/required_status_checks
- GET /repos/{owner}/{repo}/rules/branches/{base}

브랜치 보호/Ruleset API에 접근하지 못하거나 목록이 불완전하면 REQUIRED_CHECKS_UNVERIFIED로 처리합니다. Check Run이 100개를 넘어 일부만 수신되면 INCOMPLETE_CHECK_COVERAGE로 처리합니다.

## 안전 판정

| 상황 | 판정 |
|---|---|
| 정확한 PR Head + 필수 체크 성공 + 아직 미병합 | CHECKS_PASSED_NOT_MERGED |
| 정확한 PR Head + 실제 PR merged=true + 필수 체크 성공 | MERGED_CONFIRMED |
| Head SHA가 바뀜, 다른 PR/저장소, 검증 중 PR base 변경 | UNKNOWN |
| 필수 체크 중 pending | WAIT_EXTERNAL |
| 필수 체크 중 실패 | FAILURE |
| Branch protection 또는 Ruleset 조회 불가 | UNKNOWN |
| 동일 Check 이름이 여러 앱에서 충돌 | UNKNOWN |
| Required Workflow 정책을 검증하지 못함 | UNKNOWN |
| Github CLI 없음, 미인증, 권한 부족, API 장애 | UNKNOWN |
| Watchtower와 GitHub가 다른 Head SHA를 가리킴 | UNKNOWN |

**모든 경우 safeToAdvance=false입니다.** 이 단계는 Merge 사실을 표시할 뿐 자동 Phase 완료, 로드맵 다음 단계 진입, 코드 실행을 승인하지 않습니다. GitHub 검증까지 통과하더라도 사람이 승인한 제품 목표·프로젝트 Acceptance Criteria는 추가로 확인해야 합니다.

필수 체크가 명시적으로 없을 때는 서버로부터 두 가지 필수 정책 정보가 정상 조회된 경우에만 NO_REQUIRED_CHECKS로 취급합니다. 읽기 권한 실패를 '검사 없음'으로 간주하지 않습니다.

## 검증 및 한계

자동:
- PR/Repository/Head SHA 일치 및 검증 전후 변경 감지
- 필수 체크 성공, 진행 중, 실패
- 상태 API와 Check Run 충돌 및 coverage 부족 차단
- 동일 이름의 앱 제공 Check 모호성 차단
- 병합 상태는 사실만 기록, safeToAdvance=false
- Watchtower Head SHA 불일치 차단
- 로컬 API same-origin 변경 요청 차단

실사용:
- [ ] 사용자 Windows에 gh 설치·로그인 상태 확인
- [ ] 비공개 저장소 PR에서 read-only API 접근 권한 확인
- [ ] Branch protection 및 rulesets API 접근 확인
- [ ] 실제 병합 전/후의 원격 사실과 표시 결과 일치 확인
- [ ] GitHub rate limit/권한 오류 시 UNKNOWN 유지

주요 한계:
- Check Run 조회가 100건을 초과하면 fail closed. 향후 필요 시 GitHub Pagination 완성.
- Required Workflow / 복잡한 Ruleset / Review 수 / 별도 배포/보안 게이트는 완전 검증하지 않음.
- merged 사실이 프로젝트 페이즈 수용 조건을 증명하지는 않음.
- Watchtower 조회 자체와 GitHub 독립 조회의 기록 시각을 비교해야 하는 통합 최종 승인 게이트는 이후 작업.
- OS 계정 및 GitHub CLI 인증은 실제 Windows 환경에서 검증 필요.

## 다음 단계

Watchtower 성공 + 정확한 GitHub PR HEAD + Required Checks + 규정된 Review/Merge 상태 + 사용자 정책을 합성하는 **명시적 Decision Gate**를 설계하고 실기기 검증 뒤에만 실제 실행 어댑터와 연결합니다.

Watchtower 브리지 계약: https://github.com/gycha0109-beep/CI-Watchtower/blob/main/docs/integrations/development-autopilot.md

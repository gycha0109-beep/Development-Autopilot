# CI WatchTower × Development Autopilot — 통합 실행 로드맵

> 기준: 2026-10-23 KST. **설계/계획 문서이며 실환경 수락 완료 선언이 아닙니다.**
> 개발 관리 주체: Development Autopilot 트랙. CI 관측 사실과 브리지 계약의 구현 주체는 CI WatchTower.
> 상위: [Autopilot ROADMAP](ROADMAP.md) · [상세 개발 로드맵](AUTOPILOT-IMPLEMENTATION-ROADMAP.md) · [운영 계약](CI-PROGRESS-OPERATIONS.md) · [WatchTower 연동](https://github.com/gycha0109-beep/CI-Watchtower/blob/main/docs/integrations/development-autopilot.md).
> 본 문서는 Phase 03 CI/WatchTower 후속 실행 계획입니다. 기존 Chrome 복구·이관·승인 정책을 대체하지 않습니다.

## 0. 목표와 이미 확인된 출발점

**목표:** 하나의 Workstream에서 여러 일반 CI·통합 CI·공용 CI·선택적 품질 검사를 **정확한 PR/검사 대상 커밋**에 연결하고, 과거 취소 이력을 현재 실패로 오인하지 않으면서도 근거가 없으면 자동 진행하지 않는 것입니다. WatchTower는 관측, Autopilot은 진행/대기/보정/중지 판단, 매크로는 승인된 실제 실행만 담당합니다.

2026-10-23 GitHub 재확인 스냅샷 (최신 판정 시 반드시 다시 조회):

| 저장소 | 코드/PR | 상태 | 의존 관계 |
|---|---|---|---|
| CI-Watchtower | `main a3dc012` / [#66](https://github.com/gycha0109-beep/CI-Watchtower/pull/66) `e621086` | PR Fast Check/Full CI GREEN, **미병합** | #66 → main |
| CI-Watchtower | [#67](https://github.com/gycha0109-beep/CI-Watchtower/pull/67) `3cb863f` | Fast Check/Full CI GREEN, **미병합** | #67 → #66 |
| Development-Autopilot | `main 27a7684` / [#81](https://github.com/gycha0109-beep/Development-Autopilot/pull/81) `50656f6` | Autopilot CI GREEN, **Draft·미병합** | #81 → #80 |
| 실제 Windows PC | 패키징 EXE·Credential Manager·localhost·실제 두 프로그램 연결 | **LIVE PENDING** | 합성 테스트/Windows GitHub Runner와 별개 |

이미 구현된 기능을 **다시 만들지 않습니다.** WatchTower #66은 PR별 Run/Attempt·일반/통합 구분·Job 상세를, #67은 충돌 Run이 앞에 있을 때 목록 `limit`이 정상 관측을 잘못 누락하는 문제를 보정합니다. Autopilot #81은 PR별 다중 CI 소비, 일반/통합 상태, 사고·보정 횟수·블로커·발송 대기 기록, UI 표시를 포함합니다. 이 상태는 **미병합 브랜치 구현**이며 운영 적용 완료가 아닙니다.

## 1. P0 — 계약/PR 동결점 검증 및 작업 분리

**담당:** 통합 관리 트랙 (양쪽 저장소 읽기 전용 실태 조사)

- 매 작업 시작 시 두 저장소의 `main`/PR HEAD/base/리뷰/최신 정확한 HEAD의 CI를 다시 조회합니다. #66→#67, #80→#81 스택 관계를 확인합니다.
- 최신 코드 기준으로 `GET /v1/runs`, `GET /v1/runs/{runId}`, `GET /v1/runs/{runId}/jobs`의 실제 필드·인증·오류·`completeCoverage=false` 의미를 계약표로 고정합니다.
- Windows Full CI 성공과 사용자 설치 EXE 수락을 혼동하지 않습니다. 백업과 기존 DB/PAT/Registry/수동 귀속/알림 기록 보존을 출발 조건으로 명시합니다.
- **Exit:** 현행 기능/누락 항목/PR 의존성/필수 API 증거표가 일치하며 재구현 목록이 제거됨.

## 2. P1 — 취소된 과거 CI의 후속 실행 인식 (이번에 추가된 최우선 변경)

**담당:** WatchTower의 관측·이력 관계 계산 → Autopilot 소비자 교차 검증. **PIE 엔진이나 Saju 워크플로는 우선 수정하지 않습니다.**

### 2.1 실제 회귀 사례

[Saju PR #2704](https://github.com/gycha0109-beep/Saju/pull/2704)의 동일 HEAD `406dcf68d0c79c15c6da6495233534b4377d4f30`에서:

- `PIE Prospective Shadow` [Run #39906779844](https://github.com/gycha0109-beep/Saju/actions/runs/39906779844): `conclusion=cancelled`.
- 동일 PR·HEAD·워크플로의 더 나중 [Run #39906837903](https://github.com/gycha0109-beep/Saju/actions/runs/39906837903): `conclusion=success`.
- 원인은 워크플로의 PR 단위 `concurrency`와 `cancel-in-progress: true` 설정에 **부합**합니다. 단, 개별 취소의 정확한 트리거 이벤트/인과관계는 별도 증거 없이 단정하지 않습니다.
- GitHub Checks 화면의 예전 X 표시는 **영구 이력**입니다. 이를 삭제/성공으로 수정하지 않습니다.

### 2.2 변경하지 않을 원본과 별도로 계산할 파생값

- **원본:** 첫 Run의 `ciState=CANCELLED`, Run ID, Attempt, Job/Step, 타임스탬프를 변경하지 않습니다.
- **이력 관계(파생):** 후속 유효 Run이 관측되고 정확히 검증되면 `supersededByRunId` 및 `historicalDisposition=SUPERSEDED`를 제공합니다. `SUPERSEDED`는 **CI 결론값이 아니라 이력 관계/표시용 상태**입니다.
- **현재 판단(파생):** 같은 검사 계열의 최신 유효 Run/Attempt를 `effectiveRun`으로 선택하고 해당 실제 `ciState`로 GREEN/RED/PENDING을 계산합니다.
- 이력 조회와 현재 효력 판단 API는 논리적으로 분리합니다. 현재 브리지 DTO로 표현이 불가능한 것이 테스트로 입증될 때만 읽기 전용 **추가 필드**를 도입합니다. 기존 v1 API·데이터 스키마를 깨지 않습니다.

### 2.3 동일 검사 계열 및 안전한 선택 규칙

**검사 계열 키** = GitHub Repository identity + PR 번호 + 정규화한 Workflow 파일 경로/ID + **검사 대상 candidate HEAD SHA**. `workflow_dispatch` 통합 CI라면 실행 자체의 `headSha`가 아니라 별도로 검증한 `integrationCandidateHeadSha`를 사용합니다. Job 이름만 같거나 Project/Track만 같다는 이유로 섞지 않습니다. 워크플로 고유성이 모호하면 UNKNOWN입니다.

- Run ID와 Attempt를 보존합니다. 같은 Run ID의 재실행은 **최신 Attempt**를, 별도 Run끼리는 검증된 `createdAt`·Run ID/이력 순서를 사용합니다.
- 최신 Run의 상태가 `SUCCESS`면 **해당 검사만 GREEN**, `QUEUED/RUNNING`이면 PENDING, `FAILURE/TIMED_OUT`면 RED 또는 별도 실패 분류. 최신 Run이 `CANCELLED`이고 더 나중의 검증된 대체 실행이 없으면 자동 GREEN 금지(UNKNOWN/차단).
- 이전 Run의 `CANCELLED`는 동일 후보에 대한 **후속 Run의 존재·순서·대상 일치**가 확인됐을 때만 `SUPERSEDED`로 표기합니다. 'GitHub가 특정 원인으로 취소했다'는 인과관계는 확인되지 않으면 주장하지 않습니다.
- 나중의 Run이 RED이거나 PENDING이면 그 결과가 유효합니다. **이전 SUCCESS로 되돌아가지 않습니다.**
- 다른 PR/Repository/후보 SHA, 모호한 PR 식별, 과거 Attempt, 불완전한 이력 표본, `CONFLICT/STALE/POLL_ERROR`는 대체 성공 근거로 인정하지 않습니다.
- 리스트는 `completeCoverage=false`인 제한된 관측 표본입니다. **목록에 더 최신 실행이 안 보인다는 이유로 '최신임'을 증명했다고 간주하지 않습니다.** GitHub의 현재 커밋 Check Runs·필수 체크와 별도 대조하며 누락 가능성이 해결되지 않으면 UNKNOWN.
- Project-wide 공용 CI와 해당 PR의 Work Track 연관을 구별하며, 공용 Run을 특정 Track의 소유로 변경하지 않습니다.

**판정 표:**

| 같은 PR·같은 검사 대상·같은 워크플로의 증거 | 과거 취소 분류 | 현재 효력 |
|---|---|---|
| 취소 → 검증된 후속 SUCCESS | SUPERSEDED | 그 검사 GREEN |
| 취소 → 검증된 후속 RUNNING/QUEUED | SUPERSEDED | PENDING |
| 취소 → 검증된 후속 FAILURE | SUPERSEDED | RED |
| 취소 → 후속 확인 불가 | CANCELLED 유지 | UNKNOWN/재관측 |
| 과거 SUCCESS → 최신 CANCELLED | 과거 성공이 현재의 증명 아님 | UNKNOWN/차단 |
| 동일 이름이지만 PR·HEAD·저장소가 다름 | 서로 독립 | 섞지 않음 |

**Exit:** #2704와 반대 사례를 포함한 결정론적 테스트 및 실제 읽기 전용 GitHub 관측에서 *과거 취소는 이력에 남고 최신 유효 상태만 선택*됩니다. 과거 X가 GitHub 화면에 남는 현상은 결함으로 기록하지 않습니다.

## 3. P2 — Workstream별 다중 CI 종합 판정 완성

**담당:** WatchTower 증거 제공 + Autopilot 결정·GitHub 독립 검증

- PR의 `general / integration / project-wide / optional` 실행을 구분합니다. CI Responsibility와 Work Track은 다른 개념으로 유지합니다.
- MyeongHa 일반 CI와 별도 `CI Integration`, Saju 일반 CI/16-shard/PIE, K_beauty 공통 검사를 회귀 사례로 사용하되 런타임 코드는 저장소명/Track명을 하드코딩하지 않습니다.
- `integration`은 Workflow Run HEAD와 **검증받는 PR candidate HEAD**가 다를 수 있습니다. pinned candidate base SHA는 독립적 근거가 없는 현재 `null / integrationBaselineVerified=false`이며 **성공이라도 전체 승인 UNKNOWN**입니다. GitHub admission 근거/필수 체크와 결합할 수 있을 때만 완료 조건을 정의합니다.
- GitHub 필수 체크(Branch protection/rulesets/required workflows)의 접근 거부나 불완전한 커버리지를 성공으로 바꾸지 않습니다. `skipped`는 검사 계획상 적법한 경우만 정책으로 판단하며 자동 SUCCESS로 치환하지 않습니다.
- `effectiveRun`은 **개별 검사 상태**만 나타냅니다. Autopilot의 전체 `safeToAdvance`는 현재 HEAD, 모든 적용 필수 검사, base 기준, 병합·리뷰·사용자 승인·로드맵 선행 조건이 별도로 충족돼야만 결정됩니다.
- 기존 #81 `CiPrEvidenceObserver`, `CiProgressObserver`, `CiIncidentLedger`, `github-verifier`, `decision-gate`를 개선합니다. 단일 수동 Run 연결이 남아 있는 부분은 WatchTower와의 계약 테스트를 통과하는 범위에서만 단계적으로 대체합니다.
- **Exit:** 일반 GREEN+통합 PENDING/RED/UNKNOWN이 전체 GREEN으로 승격되지 않으며, 같은 SHA의 후속 PIE 성공은 과거 CANCELLED 때문에 RED가 되지 않습니다.

## 4. P3 — 실제 Windows WatchTower ↔ Autopilot 수락

**담당:** 두 앱 통합 / 사용자 PC에서 직접 관측

- 격리된 Windows GitHub Runner의 Rust/Node 테스트·패키징·EXE smoke와 **사용자 실제 PC의 설치본**을 명확히 분리합니다.
- 운영 중인 WatchTower 경로/버전/프로세스·localhost 포트 48765·기존 Autopilot 서버/Chrome 프로필과 데이터 경로를 먼저 확인합니다. 임의 종료·업데이트·강제 덮어쓰기를 금지합니다.
- 앱을 **완전히 종료한 상태**에서 SQLite/WAL/SHM 및 Credential Manager 관련 복구 가능 백업 절차를 준수하고, 기존 Registry/Alias/수동 귀속/Run 이력/알림 중복 방지 키를 사전·사후 읽기 전용으로 검증합니다. PAT/브리지 토큰은 출력하거나 저장소에 올리지 않습니다.
- [Windows 브리지 수락 지침](https://github.com/gycha0109-beep/CI-Watchtower/blob/feat/autopilot-multi-ci-evidence-v041/docs/integrations/windows-bridge-acceptance.md)과 `tools/Test-WatchTowerBridge.ps1`, `tools/verify_watchtower_db.py`를 사용합니다. 트레이·완전 종료·재시작, 401/403, 정확한 Run/Attempt, credential 재사용을 검사합니다.
- 실제 PR 1개씩(MyeongHa, Saju) 현재 HEAD의 일반/통합/취소 후 후속 실행을 관측하고 Autopilot UI가 같은 결론을 표시하는지 교차 확인합니다. 작업 종료/재시작 후 일관성도 검사합니다.
- GitHub CLI 설치/인증 및 Branch protection/rulesets 읽기 권한은 기존 요구사항입니다. 접근 제한은 **LIVE PENDING/UNKNOWN**이며 통과로 간주하지 않습니다.
- **Exit:** 실제 Windows **LIVE PASS** 증거(비밀값 제외) + 데이터 보존 검증 + 동일 PR 최신 상태 일치. 그전에는 `CODE COMPLETE · LIVE PENDING`.

## 5. P4 — GREEN/RED/PENDING에 따른 안전한 실행 연결

**담당:** Development Autopilot만, 기존 매크로·Chrome 실행 어댑터 재사용

| 현재 근거/정책 | 작업축 처리 |
|---|---|
| 필수 증거 전부 GREEN, 병합·승인 등 기존 최종 게이트 통과 | 승인된 로드맵 다음 작업을 중복 없이 1회 실행 |
| CI RED | 실패 Job/Step과 로그를 수집해 원인 분류 → 승인된 보정 작업 **최대 2회** |
| CI PENDING | 해당 작업축 WAIT_CI; 다른 독립 작업축은 계속 |
| 취소 후 후속 실행 존재 | P1의 effective 결과 사용; 과거 취소만으로 보정 지시 금지 |
| UNKNOWN/STALE/CONFLICT/필수 검사 누락 | 읽기 전용 재관측, 자동 진행·실행 중지 |
| 같은 원인 2회 보정 후 재실패 | 현재 미해결 블로커 1건; 재시도 무한 루프 금지 |
| 미해결 독립 블로커·승인 3건 이상 또는 치명적 문제 1건 | 해당 트랙 매크로 중지 및 알림 대기 |

- 중복 보정은 **실행기가 실제로 인수한 고유 operation ID**로만 횟수를 증가시킵니다. CI 폴링 횟수·동일 취소 기록·모델의 성공 주장으로 재시도 횟수나 블로커 수를 증가시키지 않습니다.
- 작업축 개별 중지 및 기존 Operator Inbox의 **승인 요청 1건 즉시 보호 정책**은 유지합니다. '3건 기준'으로 기존 승인 대기 보호를 완화하지 않습니다.
- 기존 SQLite에 저장된 incident/alert outbox를 활용하되, 실제 SMS 발송은 제공자·수신처·비밀정보 보관·재시도/중복 전송 영수증을 승인한 뒤 독립 어댑터로 연동합니다. 전송 전에는 **문자 발송 완료**라고 표시하지 않습니다.
- **Exit:** 가짜 CI 스케줄과 격리 Chrome에서 후속 전송 1회·보정 최대 2회·3건 중지·SMS 대기 영속성·재시작 후 중복 없음 입증. 실제 SMS와 실계정 전송은 별도 승인을 받은 뒤 수락합니다.

## 6. P5 — CI 병목 가시화 (기본 흐름 검증 후)

**담당:** WatchTower 관측 + Autopilot 화면

- 기존 Run→Attempt→Job→Step 타임스탬프로 대기·실행·재실행·취소·후속 성공 간 시간을 측정합니다. **관측되지 않은 원인을 추측으로 단정하지 않습니다.**
- 트랙별 '검사 미실행/진행 중/통과/실패/후속 실행으로 대체됨'을 구분하고, 이전 취소 X를 전체 RED 통계에서 제외하되 취소 횟수 및 자원 소모는 이력 통계에 보존합니다.
- PR 본문 `Watchtower-Track` 변경·Work Track 분리/통합·Project-wide 연관 및 조회 결과 제한·누락의 영향을 검사합니다.
- **Exit:** 실측 기반으로 대기 원인/변경 전후 개선 효과를 비교 가능하며, 취소를 실패율로 잘못 집계하지 않음.

## 7. 구현 PR·검증 순서 및 절대 안전 경계

1. **W-01 (WatchTower, 신규 독립 PR; #67 위):** `effectiveRun`/취소 후속 실행 관계 판정, `SUPERSEDED` 이력 메타데이터, #2704 회귀 테스트. 현행 데이터로 충분하면 별도 DTO 대신 내부 파생/문서 변경만.
2. **A-01 (Autopilot, 별도 PR; #81 위):** WatchTower 유효 검사 결과 소비와 GitHub Check Runs 최신/필수 정책 교차 검증, 취소/재실행/통합 CI 회귀. W-01 계약 확정 이후 실제 필드만 사용.
3. **W-02/A-02:** 통합 candidate base 증거 보완(실제 필요가 증명된 최소 변경), 정확한 MyeongHa/Saju PR 수락.
4. **LIVE-01:** 실제 Windows 설치 수락과 데이터 보존 검증. CI에서 성공한 결과로 대체하지 않음.
5. **A-03:** 승인된 실행 어댑터의 2회 보정/3건 중지/독립 알림 연동.
6. **OBS-01:** 병목 가시화는 선행 안전 흐름이 완료된 후 진행.

모든 변경은 **작고 검증 가능한 PR**로 쪼갭니다. 새 실행 판단 엔진이나 별도 WatchTower Coordinator를 만들지 않습니다. GitHub Actions workflow YAML, PIE 엔진, WatchTower PAT/Registry/SQLite 기존 데이터를 불필요하게 바꾸지 않습니다.

**병합 순서(승인 전 보류):** WatchTower #66 → #67 → W-01, Autopilot #80 → #81 → A-01. 각 단계마다 base/HEAD 최신성·리뷰·필수 CI 및 병합 후 검증을 재확인합니다. 승인 없는 병합·자동 병합·운영 배포는 금지합니다.

## 8. 작업 보고(매번 네 줄)

- **현재 상태:** WatchTower와 Autopilot 각 PR의 정확한 HEAD 및 Fast/Full CI, LIVE PASS/PENDING.
- **이번에 처리한 작업:** 변경 파일·테스트·PR과 실제 얻은 증거.
- **블로커·승인:** 불확실한 통합 base, GitHub 권한, Windows 설치 수락, 병합/발송 승인.
- **다음 작업:** 가장 작은 하나의 실행 단위, 성공 조건 포함.

**첫 구현 단위:** WatchTower #67 기반 W-01 — `SUPERSEDED`는 기존 `CANCELLED`을 덮지 않는 *이력 관계*이며, 최신 후속 Run의 실제 결과만 유효하게 선택한다는 회귀 테스트와 읽기 전용 파생 관측을 추가합니다.

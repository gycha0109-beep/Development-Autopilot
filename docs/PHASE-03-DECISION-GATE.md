# Phase 03-C — 통합 의사결정 게이트

> 브랜치: feat/phase03-decision-gate  
> Watchtower: CI-Watchtower v0.3.39+, read-only contract 1.0  
> 현재 범위: 결정 / 근거 검토 이력 / **모의 실행 제한**. 실제 AI 실행 또는 페이즈 완료 확정은 지원하지 않음.

## 목적

Watchtower 성공 하나 또는 GitHub PR merged 사실 하나만으로 '계속 진행'을 실행하지 않습니다. Autopilot은 현재 등록한 **Workstream · Repository · Track · Run ID · Attempt · Head SHA · PR 번호 · 로컬 작업 버전**을 일치시킨 뒤 작업별 정책을 평가합니다.

**결정 순서**

1. 전체 긴급 정지, 개별 비활성·정지, 기존 실행 및 로컬 오류를 우선 검사.
2. Workstream에 Watchtower와 GitHub 대상을 모두 명시적으로 연결했는지 확인.
3. 두 타깃이 같은 40자리 Head SHA를 가리키는지 확인.
4. Watchtower와 GitHub가 연결 중이며 계약 버전과 최근 관측 시간이 유효한지 확인.
5. 대상 매핑 **이후에** 조회한 관측인지 확인. 이전 조회 결과는 재사용하지 않음.
6. 수신 결과가 등록한 정확한 Run ID, Attempt, Head SHA 및 PR 번호에 대응하는지 확인.
7. Watchtower 결과가 FRESH SUCCESS이고 GitHub 필수 체크가 검증된 MERGED_CONFIRMED인지 확인.
8. 상기 조건이 성립해도 **WAIT_HUMAN / PHASE_ACCEPTANCE_REQUIRES_HUMAN_REVIEW**로 대기.
9. 운영자가 수동으로 **근거 확인 (모의)**를 누르면 15분의 근거 검토 이력만 기록합니다. 실제 실행 허가, Phase Complete 또는 PR 병합 권한을 부여하지 않습니다.

## 결과

| 상태 | 의미 | 실제 자동 AI 실행 |
|---|---|---|
| PAUSED | 전역 정지 또는 작업축 일시 정지/비활성 | 금지 |
| UNKNOWN | 대상/관측/권한/결과 근거 불충분, SHA 불일치, TTL 만료 | 금지 |
| WAIT_EXTERNAL | GitHub PR 미병합, CI 대기, 로컬 실행 대기 | 금지 |
| BLOCKED | CI 실패 또는 이전 작업 재조정 필요 | 금지 |
| WAIT_HUMAN | CI/필수 체크/병합 근거가 갖춰졌지만 최종 제품 수용 판단 대기 | 금지 |
| REVIEWED | 운영자가 정확한 근거를 확인했음을 기록 | **금지** |
| COMPLETE | 기존 로컬 작업이 완료된 상태 | 금지 (실제 Phase 완료라는 뜻 아님) |

모든 응답은 executionAllowed=false 및 phaseComplete=false를 유지합니다. GitHub의 required workflows/complex rulesets/review/배포 게이트 등 완전한 검증이 불가능할 때는 UNKNOWN을 유지합니다.

## 검증 시간 및 안전 기준

- Watchtower 로컬 관측: 마지막 응답 이후 **90초**까지만 재사용.
- GitHub 독립 조회: 마지막 관측 이후 **180초**까지만 재사용.
- 두 관측 모두 해당 target.configuredAt 이후에 수행되어야 함.
- 운영자 검토: 정확한 작업 버전·Repository·Track·Run·Attempt·SHA·PR 번호를 해시로 묶어 저장, 최대 15분 유효.
- 타깃 변경(커밋/Attempt/PR/Repository), 새 작업 버전, 장기간 연결 중단은 이전 검토를 그대로 실행 승인으로 재사용할 수 없음.
- 동일 판단 이력은 매 10초 기록하지 않고 **판단 또는 사유가 달라질 때만** SQLite에 기록.
- 개인정보·Bearer Token·Credential Manager 비밀정보는 게이트 이력에 기록하지 않음.

## 모의 실행과의 연결

기존 Phase 2 MockExecutor는 여전히 외부 사이트나 GitHub에 쓰기를 하지 않습니다.

- CI/PR 타깃 **미지정** 작업축의 사용자가 명시적으로 켠 기존 모의 실행 기능은 테스트 목적으로 유지됩니다.
- CI 또는 PR 타깃을 **하나라도 등록**한 작업축은 게이트가 REVIEWED일 때만 모의 실행 예약이 가능합니다.
- 게이트는 독립 판단 계층이며 실제 AI 실행 어댑터를 활성화하는 권한이 **아닙니다**. 실제 실행기 도입 시에는 이 단계보다 강한 실행 직전 재검증·승인·증거 봉인이 필수입니다.

## 구현 파일

- local/decision-gate.js: 순수 게이트 함수, 결정 이력, Workstream 검토 증거 SQLite 저장.
- local/scheduler.js: 선택적 모의 실행 전용 preflight 함수.
- local/server.js: 상태 스냅샷, 수동 관측 새로고침, 근거 검토 API.
- local/public/index.html · app.js: 상태·사유·근거 해시·검토 및 판단 이력.
- tests/decision-gate.test.js: 정밀 매핑, TTL, FAIL CLOSED, 검토 소멸, 스케줄러 차단.
- tests/local-http.test.js: cross-origin 검토 거부, 불일치한 CI 근거로 모의 실행 불가.

## 로컬 API

- GET /api/v1/snapshot → decisionGate.results / decisionGate.history
- POST /api/v1/decision-gate/refresh → Watchtower/GitHub 갱신 후 판단 및 이력 기록
- POST /api/v1/workstreams/{id}/decision-review → 적합한 WAIT_HUMAN 근거만 운영자 확인 이력으로 기록
- 기존 Watchtower / GitHub / Chrome 및 SQLite API 변경 없음

## 검증 범위 및 미해결

자동 테스트는 Linux·Windows GitHub Actions로 확인합니다. 다음 항목은 수동 외부 실행이 필요합니다.

- [ ] 사용자 Windows에서 Watchtower Credential Manager 키로 실제 CI 조회
- [ ] 사용자 GitHub CLI 인증 및 비공개 PR의 필수 체크·병합 상태 조회
- [ ] Chrome 탭 그룹 10개 이상/다중 창과 실기기 연결
- [ ] 실제 PC 절전/재시작·트레이/Watchtower 종료 및 재개
- [ ] Windows 설치 프로그램 배포 및 시스템 트레이 UI
- [ ] 사용자 승인 범위·실제 검증 근거를 받는 허용된 AI 실행 어댑터

## 다음 단계

Phase 4의 **별도 ExecutionAdapter 계약 + mock vertical slice**를 설계하십시오. 외부 실행 어댑터를 붙이기 전에, GitHub PR 필수 체크/Review/보호 규칙의 실제 권한과 승인 경계를 Windows에서 확인해야 합니다. ChatGPT 소비자 웹 UI 무인 입력을 정식 지원 API로 가정하지 않습니다.

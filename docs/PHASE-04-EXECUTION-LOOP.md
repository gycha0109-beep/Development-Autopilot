# Phase 04-A — ExecutionAdapter 및 단일 작업 모의 실행

> Branch: feat/phase04-execution-adapter-loop
> 범위: DeterministicMockAdapter 전용. 실제 AI 요청·Chrome 자동 입력·GitHub mutation 없음.

## 1. 목적

승인된 작업 하나를 작업 계획 → 운영자 승인 → 실행 ID 선예약 → 어댑터 접수 → 별도 결과 조회 → 증거 검증 → SQLite 기록으로 연결합니다. 접수(accepted)는 완료가 아니며 모의 실행 성공만 검증합니다.

구현:
- local/execution-adapter.js: 불변 ExecutionAdapter v1 요청과 수신 영수증, 결과 검증.
- local/execution-loop.js: Plan/승인/선예약/Inspect/SQLite/재시작 복구.
- local/server.js: 로컬 실행 API. Phase 4 작업은 기존 수동 완료 API를 통한 우회 금지.
- local/scheduler.js: Phase 4 계획이 존재하는 작업축의 기존 자동 시뮬레이션 예약 차단.
- local/public: 승인된 계획 단위 실행·검증·불명 상태 보류 화면.
- tests/execution-loop.test.js, tests/local-http.test.js: 단위 및 HTTP 통합 테스트.

## 2. ExecutionAdapter v1

어댑터 메서드는 submit(request), inspect(receipt,request) 두 단계입니다. 계약 버전은 1이며 immutable 요청에 Operation ID, Workstream ID, taskRevision, repository, planId, fingerprint, action, expectedMarker를 포함합니다.

submit()은 접수 영수증(accepted, adapterId, operationId, fingerprint, receiptId)을 반환합니다. inspect()는 pending/succeeded/failed 중 하나를 반환하며, verifier는 receipt와 observation이 정확히 같은 Operation ID·fingerprint·expectedMarker·SHA-256 proof를 포함하는지 확인합니다.

현재 등록할 수 있는 어댑터는 deterministic-mock-v1 한 개이고 sideEffects=false 입니다. 실제 개발 도구나 임의 셸·ChatGPT 브라우저 자동 입력을 연결하려고 하면 거부합니다.

## 3. 실행 방법

1. Node 22.16 이상에서 npm run check, npm start를 실행합니다.
2. http://127.0.0.1:48173 로컬 화면에서 작업축을 생성합니다.
3. 해당 작업축을 모의 실행 모드로 변경하고 작업 준비를 선택합니다.
4. CI 또는 PR 감시 대상을 연결했다면 Phase 3 Decision Gate가 REVIEWED여야 합니다.
5. Phase 4에서 작업축·제목·허용 범위·검증 마커를 입력하고 계획을 생성합니다.
6. 정확한 계획 지문을 확인하고 계획 승인(10분 유효)을 누릅니다.
7. 모의 실행을 누르면 SQLite에 Operation ID를 먼저 기록하고 MockAdapter에 전달합니다.
8. 접수된 작업은 WAIT_EXTERNAL에 머물며 완료 처리되지 않습니다.
9. 결과 독립 검증에서 모의 Proof가 검증되면 plan=verified, Workstream=COMPLETE로 처리됩니다.
10. 여기서 COMPLETE는 **모의 작업 완료만** 의미하며 실제 프로젝트 Phase 완료를 뜻하지 않습니다.

## 4. 장애/중복 방지

- Workstream당 하나의 활성 Operation, task revision당 하나의 불변 계획.
- 전역 STOP, 개별 PAUSE, CI·PR gate 불통과, 승인 만료 시 실행 예약 금지.
- 영수증 저장 후 별도 Inspect를 요청합니다. Pending은 대기, 실패·위조는 BLOCKED.
- 접수 응답 손실·검증 불확실성은 UNKNOWN으로 보류하고 자동 재전송하지 않습니다.
- 기다리던 receipt가 SQLite에 보존된 경우 재시작 후 다시 검증할 수 있습니다.
- 발송 중 크래시는 UNKNOWN으로 복구하며, 이미 제출한 작업을 재전송하지 않습니다.
- 기존 수동 /operations/:id/resolve API로 Phase 4 작업을 completed 처리할 수 없습니다.
- UI와 API에는 언제나 phaseComplete=false 가 노출됩니다.
- 민감정보/토큰/대화 URL을 ExecutionAdapter 요청에 전달하지 않습니다.

## 5. 로컬 API

| Method | Path | 목적 |
|---|---|---|
| POST | /api/v1/execution-plans | Workstream 및 불변 Task Plan 등록 |
| POST | /api/v1/execution-plans/:id/approve | 사용자 수동 승인 |
| POST | /api/v1/execution-plans/:id/dispatch | 한 번만 mock submit |
| POST | /api/v1/execution-plans/:id/inspect | 별도 mock result verifier |
| POST | /api/v1/execution-plans/:id/abandon | 불명 상태로 보류·재전송 금지 |
| GET | /api/v1/snapshot | executionPlans 상태 조회 |

모든 POST는 로컬 같은 Origin JSON만 허용합니다.

## 6. 검증 범위 및 미완료

자동: 승인 분리·만료, STOP/PAUSE, 이중 제출 차단, 거짓 Proof 거부, Pending/Failed/Unknown, 영수증 영속/크래시, 사용자 API 우회 및 cross-origin 차단.

수동 검증:
- [ ] Windows 관리 화면 실기기 동작
- [ ] Chrome 확장 및 Watchtower/GitHub 읽기 전용 연결
- [ ] 정식 지원되는 개발 실행 도구·권한·요금·취소/중단 계약 확인
- [ ] 실제 코딩 실행 Adapter + 결과 PR/SHA 검증
- [ ] Windows EXE/트레이

**종료 조건:** 이번 PR은 Phase 4의 첫 번째 모의 실행 수직 슬라이스입니다. 실제 AI 코딩 작업 1회 완료 조건은 미충족입니다.

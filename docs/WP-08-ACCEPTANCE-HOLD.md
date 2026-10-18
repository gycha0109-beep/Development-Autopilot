# WP-08 — 실제 증거 gate 대기

2026-10-18 KST. WP-02~07 A의 코드/합성 검증은 실제 Windows Chrome acceptance가 아니다.
WP-07 부모까지의 정확한 SHA/run/attempt 및 최종 결과는 각 PR에 기록한다.

## 이번 실제 읽기 전용 확인

- 도구 inventory: 실제 Chrome extension 연결 있음.
- 접근 가능한 탭 중 제목이 정확히 `자동 이관 검증 1`인 탭: 0개.
- 접근 가능한 `http://127.0.0.1:48173` / localhost 관리자 탭: 0개.
- Windows 기본 TCP 48173 LISTEN 리스너: 0개.
- 현재 코드의 실제 상태 경로 `http://127.0.0.1:48173/api/v1/snapshot`: HTTP 연결 불가, HttpRequestException,
  HTTP status 없음. 다른 포트/다른 PC의 관리자 실행 여부는 확인하지 못했다.
- 실행 중 확장/bridge 버전과 원본 시험의 composer DOM은 여전히 미확인이다.

원본 대화/작업축/등록/감시/이관 실패를 읽거나 수정하지 않았고, 신규 관리자 DB를 만들어 기존 등록으로 간주하지 않았다.
원본 요청 재전송·실패 reset·다른 시험 채팅 생성·Stop·보고·실제 메신저 발송·배포·병합은 실행하지 않았다.
GitHub Windows CI와 로컬 Windows Node 테스트는 실제 Chrome acceptance가 아니다.

## 사용자에게 필요한 다음 한 가지

**기존 등록 `자동 이관 검증 1` 탭에서 `등록 대화 입력창 진단 (전송 안 함)`을 한 번 실행하고,
편집기별 구조 JSON 결과를 제공한다.** 기존 관리자 주소가 기본 포트와 다르면 실제 localhost 주소도 확인한다.
본문·초안·전체 HTML·토큰·자격 증명은 필요하지 않다. 실패한 source 요청을 다시 보내는 단계가 아니다.

이 증거와 현재 실행 버전이 확인되면 실제 DOM에 근거해 관찰/입력창 계약을 검토할 수 있다.
실제 연결 해제 Stop/report/독립 provenance 및 same-tab rebind 어댑터는 별도 실제 경고/상태 증거가 필요하다.
허용 범위와 실제 어댑터를 확정하기 전에는 operational server/worker를 활성화하지 않는다.

## 현재 미완성 범위

- 운영 server/worker의 새 coordinator 진입점, 실제 observation/Stop/report/rebind/current-target 어댑터.
- WP-04 B 실제 연결 복구 통합, WP-05 실제 동일 탭 끝단 검증.
- 실제 메신저 opt-in/자격 증명/발신자 등록/전달 검증, Inbox HTTP/UI와 보호 행동 실행기 연결.
- 실제 1→3→10→20 Chrome 탭/긴 실시간 운영, WP-09 운영 화면/설치/업데이트/롤백/관측 이력 보존.

현재 판단: **코드·합성 슬라이스 VERIFIED / 실제 gate BLOCKED_EXTERNAL / 전체 제품 미완료**.
실제 근거 없이 위 미완성 항목을 구현 완료·무인 성공·DEPLOYED로 승격하지 않는다.

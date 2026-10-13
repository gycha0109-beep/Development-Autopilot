# Chrome 실행 버전 불일치 — Windows 실기기 검증

Windows에서 확장 프로그램 관리 화면은 최신 상태인데 구버전 Chrome service worker가 응답하는 현상이 발생했습니다. 관측된 증상은 '버전 미보고', '입력창 엔진 업데이트 필요', '확장 프로그램 연결에 실패했습니다' 입니다.

## 수정

- 서비스 워커 버전 조회가 Chrome 탭 그룹이나 로컬 등록 상태 검사에 실패해도 응답하도록 분리.
- 확장 manifest 0.4.3, 실제 실행 중인 코드 엔진 composer-2026-10-13-r4 확인.
- 확장 동기화 요청에 실제 서비스 워커 코드 서명을 추가.
- localhost는 SQLite에 최신 동기화 코드 서명을 저장. 서명이 없거나 구버전이면 메시지 신규 예약 및 전달을 차단.
- 기존 그룹·탭 등록과 페어링 토큰은 유지. 자동으로 확장을 제거하지 않음.

## Windows에서 재검증

PowerShell:

~~~powershell
git fetch origin
git switch --track origin/fix/chat-extension-worker-handshake
npm.cmd run check
~~~

Node 서버를 실행한 터미널에서 Ctrl+C로 중단한 후 npm.cmd start 를 새로 실행하십시오. 브랜치 전환만으로 실행 중인 서버 코드가 변경되지는 않습니다.

Chrome:

1. 기존 Autopilot 확장 관리 탭을 완전히 닫습니다.
2. chrome://extensions 에서 확장 로드 위치를 확인합니다.
3. Development Autopilot 카드 새로고침(↻)을 누릅니다.
4. 새로운 확장 관리 페이지를 열어 실행 버전 0.4.3 과 composer-2026-10-13-r4 을 확인합니다.
5. 등록 대화 입력창 진단 (전송 안 함)을 클릭해 입력창 후보 개수를 확인합니다.
6. 버전과 입력창이 확인된 후에만 새로운 테스트 메시지를 승인하고 1회 전송합니다.

업데이트 불확실 상태에서는 기존 blocked 명령이 다시 발송되지 않으며, 새로운 메시지도 차단됩니다.

## 검증 한계

CI는 Windows 및 Ubuntu에서 백그라운드 메시지 처리와 SQLite 버전 인증을 테스트합니다. 실제 ChatGPT DOM 동작은 사용자 Windows Chrome에서 추가 검증이 필요합니다.

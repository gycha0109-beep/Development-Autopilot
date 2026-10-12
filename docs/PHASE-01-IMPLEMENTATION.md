# Phase 0–1 실제 구현 기록

> 구현 브랜치: feat/phase01-extension-inventory
> 상태: 코드 및 단위 테스트 구현, 브라우저 수동 설치 검증은 별도 필요
> 범위: Chrome MV3 확장 프로그램 / 로컬 등록 관리 UI

## 구현된 것

1. \`extension/manifest.json\`: Manifest V3, \`tabs\`, \`tabGroups\`, \`storage\` 권한만 선언.
2. \`extension/background.js\`: 탭 그룹·그룹 내 탭 메타정보 조회, 등록 상태 읽기/변경 메시지 처리, Chrome 탭 변경 이벤트 전파.
3. \`extension/core.js\`: 등록/해제/정지/재연결, 등록 상태 정규화, 브라우저 세션 토큰 기반 재연결 검증.
4. \`extension/options.html\` + \`options.js\` + \`ui.css\`: 한글 관리 화면, 현재 그룹·탭 목록, 개별 등록, 연결 복구 UI.
5. \`extension/popup.html\` + \`popup.js\`: 상태 요약 및 관리 화면 바로가기.
6. \`tests/\`: Node 내장 테스트 도구로 순수 상태 처리 및 Manifest 권한·XSS 관련 회귀 테스트.
7. \`.github/workflows/ci.yml\`: PR과 main push에서 Node 22 테스트.

## 운영 방식

1. Chrome에서 \`chrome://extensions\`로 이동하여 개발자 모드를 켭니다.
2. '압축해제된 확장 프로그램을 로드합니다'에서 **저장소의 \`extension\` 폴더**를 선택합니다.
3. 확장 프로그램 팝업 → **관리 화면 열기**.
4. 목록의 Chrome 탭 그룹에서 **그룹 등록**, 이어 개별 탭에서 **탭 등록**.
5. Chrome을 완전히 재시작하거나 확장 프로그램을 재로드했다면 **수동 재연결**로 그룹·탭을 다시 확인합니다.

## 데이터와 안전장치

- 등록 정보는 Chrome \`storage.local\`에 저장합니다.
- 임시 브라우저 세션 토큰은 \`storage.session\`에 저장하므로 Chrome 전체 재시작/확장 재로드 후 오래된 숫자 ID를 자동 재사용하지 않습니다.
- 브라우저 재연결 때 탭은 반드시 개별적으로 다시 매칭합니다.
- 감지를 위해 Chrome에 열린 그룹과 그룹 내 **탭의 제목/URL 메타정보**를 조회합니다. 그룹/탭 등록은 개별 사용자 선택으로 수행하며, 전체 페이지 본문은 조회하지 않습니다.
- 외부 서버 전송, OpenAI API 호출, 프롬프트 자동 입력, CI Watchtower 변경, GitHub 변경 동작은 없습니다.
- 현 Phase는 **Chrome 확장 옵션 페이지를 관리 화면으로 사용**합니다. 별도의 Windows EXE·로컬 서버 통신은 후속 Phase에서 연결합니다.

## 검증 기록

수행할 자동 검증:
\`\`\`powershell
node --version  # >= 22
npm run check
\`\`\`

추가 수동 검증:
- [ ] 실제 Chrome에서 설치 후 관리 화면 로드
- [ ] 그룹 2개 이상 및 탭 10개 이상 탐색
- [ ] 그룹/탭 등록·삭제·정지·재연결
- [ ] Chrome 완전 종료 후 상태 보존 및 **무단 자동 재연결 차단**
- [ ] 그룹 이름 변경 / 탭 다른 그룹으로 이동 / 탭 URL 변경
- [ ] 다중 창 / 같은 URL을 가진 다른 탭
- [ ] Chrome 재시작 후 수동 복구 UX

## 아직 구현되지 않은 것

- Windows 실행 파일(Tauri 등)
- 탭별 35분 스케줄러 및 SQLite
- Watchtower/GitHub 연동
- AI 실행기 및 자동 메시지 전송
- 로드맵 자동 갱신과 대화 이관

## 알려진 제약

- Chrome 탭/그룹 ID는 영구 식별자가 아닙니다. 안전성 때문에 재시작 후 수동 재연결이 필요합니다.
- 그룹 내 탭의 URL이 바뀌면 자동 연결을 해제하며 사용자가 다시 확인해야 합니다.
- 현재 상태는 **프로젝트/작업축 이름 직접 지정** 기능 없이 Chrome 그룹/탭 단위 등록만 지원합니다. Project → Workstream 매핑은 Phase 2에서 구현합니다.
- 명시적 등록은 대상 탭에 대한 이후 제어 허용으로 취급하지 않습니다. 이 단계는 조회/등록만 수행합니다.

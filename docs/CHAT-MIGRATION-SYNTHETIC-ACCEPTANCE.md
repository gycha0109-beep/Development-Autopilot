# 실제 길이 제한 없이 자동 이관 시험

## 범위
테스트 모드는 **경고 감지 신호만** 합성합니다. 이후에는 실제 Chrome 프로젝트 기존 채팅에서 이관문 작성 요청 → 응답 추출 → 동일 프로젝트 새 탭 생성 → 실제 첫 메시지 전송 → 첫 응답 대기 → 제목 번호 +1 변경 → 새 URL 등록·로컬 동기화 → 기존 유효한 주기 재개를 실행합니다.

## 사전 준비
1. 실사용 개발 트랙과 분리된 연습용 ChatGPT 프로젝트를 하나 만듭니다.
2. 연습용 프로젝트의 기존 채팅 하나를 열고 내용이 있는 assistant 응답을 한 번 생성합니다. 기존 대화 제목을 '자동 이관 테스트 1'로 지정합니다.
3. 해당 Chrome 탭을 그룹 및 Autopilot 확장에 등록하고 localhost에 연결합니다. 이전 자동 발송을 실수로 건드리지 않도록 다른 실사용 트랙은 중지하십시오.
4. Chrome 확장 버전 0.4.14 / 입력창 엔진 composer-2026-10-14-r14와 localhost 서버 연결을 확인하십시오.
5. 확장 옵션 > 길이 제한 자동 감지 → 자동 이관에서 연습용 탭, '자동 이관 테스트 1', 연습용 GitHub 저장소를 입력하고 자동 감시 켜기를 누릅니다.

## 테스트 실행
1. '테스트: 길이 제한 경고 1회 발생' 버튼을 누릅니다.
2. 설명과 실제 메시지 발송 경고를 확인합니다. 버튼은 선택된 등록 탭에서만 허용합니다.
3. 확장이 즉시 localhost와 동기화하며 이관 프로세스를 시작합니다. 이후 매분 확장 동기화/알람마다 다음 단계가 진행됩니다.
4. 자동 이관 상태 확인에서 진행 단계를 확인합니다. 필요하면 확장 옵션의 '지금 동기화'를 수동으로 눌러 다음 단계 확인을 앞당길 수 있습니다.
5. 원본 대화에 로드맵 기반 이관 요청이 정확히 한 번 나타나는지 확인합니다.
6. 같은 프로젝트에 새로운 채팅이 생기고, 원본 이관 답변이 새 채팅의 첫 메시지로 실제 전송되는지 확인합니다.
7. 첫 출력이 끝난 뒤 제목이 '자동 이관 테스트 2'로 바뀌는지 확인합니다.
8. 새 채팅에 작업축의 등록 탭이 이동했는지 확인합니다. 유효한 주기 설정이 있었던 경우 다음 주기부터 전송되는지 확인합니다.

## 실패 원인 확인
- needs_attention + MIGRATION_TITLE_CHAT_MENU_NOT_FOUND: Chrome 사이드바 UI에서 제목 변경 메뉴를 식별하지 못했습니다.
- needs_attention + INTERRUPTED_UNCERTAIN_NO_REPLAY: 전송/새 탭 만들기 등 완료 여부를 확정할 수 없습니다. 자동으로 다시 시도하지 않습니다.
- 자동 이관 재시작 불가: 이미 해당 원본 채팅에 대해 테스트 한 번을 수행했습니다. 새로운 연습용 대화를 등록하여 재시험하십시오.
- 브라우저/서버 연결이 끊어지면 실제 이관이 멈춥니다. 코드 자동 테스트 통과는 실제 UI 제목 변경을 보장하지 않습니다.

## 적용
PowerShell: git fetch origin
PowerShell: git switch --track origin/fix/migration-unattributed-marker-recovery
서버를 Ctrl+C로 종료한 후 npm.cmd start로 재시작하십시오.
기존 Chrome 확장 옵션 탭을 닫고 chrome://extensions에서 확장 새로고침 후 새 옵션 페이지를 여십시오.

## 이미 작성된 원본 이관문 복구 (Windows Chrome 실기기 미검증)

원본에 `AUTOPILOT_MIGRATION_HANDOFF`로 시작하는 완성된 답변이 있으면 새 요청을 전송하지 않습니다.
이번 브랜치에서 원본 탭과 기존 작업축을 선택하고 **작성 완료된 이관문 이어받기**를 누릅니다.
원본 URL·프로젝트·직전 이관 요청과 마지막 assistant 답변의 관계가 불확실하면 새 채팅을 만들지 않습니다.
실제 Chrome에서 추출 → 같은 프로젝트로 전송 → 첫 응답 → 제목 +1 → 작업축 재연결 → 승인된 주기 복구까지 각각 확인해야 acceptance가 완료됩니다.

## article 기반 ChatGPT DOM 및 원본 이관문 재회수

기존 일반 텍스트와 코드블록 모두 `.markdown` 또는 메시지 본문에서 읽습니다.
기존 `data-message-author-role` 외에 역할이 명확한 `article[data-turn="user"|"assistant"]` 구조를 검사합니다.
이전 요청 진행 상태에 저장된 assistant ID가 있고 원본 URL·탭·프로젝트가 일치한다면, 직전 사용자 요청이 가상화되어 DOM에서 사라진 경우에도 새 assistant ID와 정확한 `AUTOPILOT_MIGRATION_HANDOFF` 마커로 복구할 수 있습니다.
원본 요청의 재전송은 금지되며, 마커 및 증거가 불충분하면 중단해야 합니다.
새 채팅 전송·제목 변경·작업축 재연결·스케줄 재개는 여전히 실제 Windows Chrome 검증이 필요합니다.

## 2026-10-14 — assistant 역할 속성이 모두 없는 원본 화면

원본 이관문이 코드블록이 아니어도 지원하며, 마커가 본문 외부에 출력되고 코드블록에 본문이 있는 경우도 처리합니다.
사용자가 **작성 완료된 이관문 이어받기**를 직접 승인한 경우에만 원본 요청 텍스트, 고유 마커, 직후 단일 코드블록을 교차 검증하여 복구할 수 있습니다. 자동 감시 루프는 이러한 역할 없는 DOM을 추정해 복사하지 않습니다.

검증 실패 시 `MIGRATION_UNATTRIBUTED_MARKER_NOT_FOUND`, `MIGRATION_UNATTRIBUTED_SOURCE_REQUEST_NOT_FOUND`, `MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND` 등 원인을 구분합니다.
원본 대화에 **다시 메시지를 보내거나 실패 기록을 초기화하지 말고**, 기존 대화의 마지막 답변 상태와 오류 코드를 확인하십시오.

## 2026-10-14 — 중복 HANDOFF 마커의 출처 구분 (0.4.16)

원본 사용자 이관 작성 요청에 `AUTOPILOT_MIGRATION_HANDOFF` 문구가 인용되고, 실제 assistant 이관 답변에도 동일 마커가 단독 출력되는 경우가 있습니다. 이제 총 마커 개수가 2개 이상이라는 이유만으로 중단하지 않고, 가장 최근 실제 작성 요청을 확인한 뒤 해당 요청 뒤에 있는 독립된 마커와 동일한 답변 범위 내의 단일 코드블록을 결합합니다. 인라인 코드/인용 마커와 오래된 요청·답변은 제외합니다.

유효한 이관 후보가 2개 이상이거나 출처가 불분명하면 계속 중단합니다. `작성 완료된 이관문 이어받기`로만 수동 복구하며, 원본에 추가 메시지를 보내지 않습니다. Windows Chrome Acceptance는 미완료입니다.

체크아웃 브랜치: `fix/migration-marker-candidate-scoping`.

## 2026-10-14 — UNATTRIBUTED_CODE_BLOCK_NOT_FOUND 보완 (확장 0.4.17)

이관문 마커와 코드블록이 동일한 assistant 컨테이너 내부에 있지 않고, ChatGPT 렌더러가 형제 DOM 트리에 출력하는 경우가 있습니다. 수동 `작성 완료된 이관문 이어받기`에서만 **검증된 최근 원본 요청 → 단독 마커 → 근접한 첫 코드블록** 순서로 찾도록 보완했습니다. 다음 마커나 다수의 콘텐츠가 끼어 있거나 실제 코드블록을 식별하지 못하면 여전히 중단합니다.

실패 시 `markers`, `requests`, `structuredCodes`, `qualifiedReplies`, `orderFallbacks` 숫자만 보여줍니다. 메시지 본문은 진단으로 수집·전송하지 않습니다. 동일 이관문 재요청·실패 기록 초기화는 하지 마십시오. Windows Chrome 전체 이관 Acceptance는 별도 미검증입니다.

적용 브랜치: `fix/migration-unattributed-codeblock-order-recovery`.

## 2026-10-14 — 원본 시작 기록 소실 복구 (확장 0.4.18)

오류 `AUTO_MIGRATION_RECOVERY_ORIGINAL_NOT_PREVIOUSLY_TRIGGERED`는 자동 이관 감시의 `lastTriggeredUrl`과 세션 진행 상태가 모두 없는 경우에 원본 DOM 확인 전에 중단한 것이 원인입니다. 이 기록은 확장 재설정이나 감시 재등록 등으로 없을 수 있습니다.

이제 **사용자가 확인 버튼을 눌러 진행하는 수동 이어받기**에 한해 기록이 없어도 원본 DOM을 검사합니다. 이 경우 이관 작성을 요청한 원본 사용자 메시지의 정확한 저장소 `owner/repo`와 화면에서 확인한 트랙 제목, 원본 마커 및 assistant가 작성한 이관문이 모두 일치해야 복구합니다. 증거가 없으면 새 채팅을 만들지 않고 중단하며, 원본에 또 다른 이관 요청을 보내지 않습니다.

가상 경고 재실행, 감시 기록 초기화, 새 작업축 등록을 하지 말고 기존 채팅에서 '작성 완료된 이관문 이어받기'만 누르십시오. 실제 Windows Chrome 전체 단계는 여전히 Acceptance 미완료입니다.

적용 브랜치: `fix/migration-handoff-lost-trigger-proof`.

## 2026-10-14 — structuredCodes=0 지원 (확장 0.4.19)

실제 Windows에서 `AUTO_MIGRATION_RECOVERY_MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND (markers=2,orderFallbacks=0,qualifiedReplies=0,requests=2,structuredCodes=0)`가 보고됐습니다. 이는 이관문 마커와 원본 요청 텍스트는 보이지만 `pre code` / `pre` 컨테이너가 DOM에 존재하지 않거나 접근되지 않는 경우입니다.

수동 이어받기에서는 원본 작성 요청을 검증한 후 **그 이후의 단독 응답 마커**를 식별합니다. 구조화된 코드블록이 없으면, 해당 마커를 포함하면서 이전 사용자 요청을 포함하지 않는 **최소의 답변 전용 DOM 컨테이너**에서 표시 텍스트를 추출합니다. UI 조작 요소의 텍스트는 제외하며, 한 번에 검증되는 내용과 마커가 여러 개이면 계속 중단합니다. `main.innerText` 전체나 과거 대화 전체를 복사하지 않습니다.

오류 발생 시 `boundedTextScopes` 및 `textNodesAfterMarker`도 노출합니다(수치만, 본문 수집 없음). 답변 DOM의 안전한 경계를 찾을 수 없다면 추측하여 새 채팅을 생성하지 않습니다. 실제 Chrome 전체 이관 완료는 아직 검증되지 않았습니다.

적용 브랜치: `fix/migration-unstructured-reply-text`

## 2026-10-14 — 실기기 DOM 증거 수집 (확장 v0.4.20)

실제 Windows에서 `AUTO_MIGRATION_RECOVERY_MIGRATION_UNATTRIBUTED_CODE_BLOCK_NOT_FOUND (boundedTextScopes=0,markers=2,orderFallbacks=0,qualifiedReplies=0,requests=2,structuredCodes=0,textNodesAfterMarker=328)`가 반복 재현됐습니다. 종전 수정의 가정인 pre/code 구조와 안전한 reply-only 컨테이너가 현행 DOM에 존재하지 않는 것으로 관측됩니다.

추가 추정 복사 로직은 적용하지 않습니다. 확장 설정 → 자동 이관 → 테스트용 원본 채팅 선택 → **이관 답변 DOM 구조 진단 (읽기 전용)** 버튼을 누르고, **진단 결과 복사**로 나온 JSON을 전달합니다. 진단은 역할 메타데이터 유무, 정확한 마커/원본 요청의 조상 요소 태그, 요소별 텍스트 길이, 포함 관계와 주변 요소의 길이만 반환합니다. 원본 메시지 본문, 원본/대상 주소, HTML, 클래스 내용, 탭 ID를 포함하지 않고 로컬 브리지에도 저장하거나 전송하지 않습니다. 진단 버튼을 누르는 것만으로 원본 이관문 재요청, 새 탭, 실패 기록 초기화, 감시 재설정은 발생하지 않습니다.

구체적 브라우저 DOM 구조 확인 전까지 실제 이관 기능은 미검증으로 유지합니다.

적용 브랜치: `diag/migration-dom-boundary-evidence`.

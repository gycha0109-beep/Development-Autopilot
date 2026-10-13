# Phase 04-B — Codex CLI 로컬 실행 어댑터 (수동 명시 승인)

> Branch: feat/phase04b-codex-local-adapter
> Status: 로컬 실제 개발 도구 호출 어댑터 코드 + Git worktree 통합 테스트 구현
> **현재 사용자 PC의 실제 Codex 로그인·AI 실행은 미검증**. CI는 Codex 대신 테스트 스텁을 사용합니다.

## 선택한 실행 환경

공식 OpenAI Codex CLI의 **non-interactive `codex exec`**를 채택합니다. Chrome 탭/ChatGPT 웹 대화를 자동으로 클릭하거나 메시지 입력을 우회하는 방식이 아닙니다.

공식 문서:
- https://learn.chatgpt.com/docs/non-interactive-mode
- https://learn.chatgpt.com/docs/cli/reference
- https://github.com/openai/codex

비대화형 실행에 `--sandbox workspace-write`와 `--json`을 사용할 수 있으며, Codex CLI는 로컬 계정 로그인 상태를 사용합니다. 실제 모델/사용량은 Codex CLI 로그인 계정, 구독/크레딧 및 제공자 정책에 따라 달라집니다.

## 설치

Node.js 22.16 이상, Git, Codex CLI가 필요합니다. Windows에서는 먼저 터미널에서 다음을 실행해 계정을 확인합니다.

~~~powershell
npm install -g @openai/codex
codex login
codex login status
~~~

**보안:** Codex 토큰·API 키를 Autopilot 저장소, CLI 인수 또는 GitHub Secrets에 복사하지 않습니다. 로그인은 Codex CLI에서만 수행합니다.

## 첫 실제 작업 실행 — 두 단계

기존 작업 중인 브랜치·수정된 코드를 직접 건드리지 않도록 **깨끗한 feature 브랜치의 저장소 루트 경로**를 사용합니다. 현재 main/master 브랜치에서 바로 실행하지 않습니다.

작업 내용을 외부 개인 파일로 작성하고, 수정 가능한 **정확한 상대 파일 경로**를 명시합니다. 첫 검증은 민감정보와 배포 설정이 없는 문서나 비핵심 테스트 파일 한 개를 권장합니다.

예시: 별도 저장소 `owner/repo`, 대상 문서 `docs/example.md`.

~~~powershell
# 저장소 root 및 승인할 작업파일 경로를 자신의 PC에 맞게 지정
$workspace = "C:\dev\example-project"
$taskFile  = "C:\dev\autopilot-tasks\one-task.txt"

# 1. 실행 없이 대상 HEAD/브랜치/범위/작업내용 해시 확인
npm run codex-task -- prepare --workspace $workspace --repository owner/repo --task-file $taskFile --allow docs/example.md

# 2. 출력된 fingerprint가 승인하려는 정확한 요청과 일치하는지 검토 후 직접 입력
npm run codex-task -- run --workspace $workspace --repository owner/repo --task-file $taskFile --allow docs/example.md --approval <prepare가 출력한_64자리_fingerprint>
~~~

실제 명령에서는 `<...>` 부분을 SHA-256 fingerprint 문자열로 바꾸십시오.

## 실행 전 안전 검사

1. 경로가 실제 Git 저장소 root인지 확인.
2. 원본 checkout이 깨끗하고 branch가 main/master가 아닌지 확인.
3. GitHub origin이 사용자가 지정한 `owner/repo`와 일치하는지 확인.
4. 실행할 Task의 정확한 SHA-256, 원본 HEAD SHA, branch, 허용 파일 목록을 지문에 포함.
5. 운영자가 fingerprint를 입력하면 준비 단계를 **다시 실행하여** 일치 여부 확인.
6. `git worktree add --detach`로 OS 임시 경로에 별도 작업 공간 생성; 원본 checkout에 직접 적용하지 않음.
7. Codex CLI에는 workspace-write 샌드박스 및 network_access=false, approval_policy=never를 지정. `--json -`과 stdin 프롬프트로 입력하고 임의 shell interpolation은 사용하지 않음.
8. Codex 실행 30분 제한, 이벤트 로그 수신 용량 제한 2MiB, 실패 시 재시도 0회.
9. 완료 후 실제 worktree HEAD가 예상 SHA와 동일한지, 변경 파일이 허용 경로만인지, `git diff --check`가 성공하는지 확인.
10. 변경 파일을 독립 해싱하여 실행 감사 요약 저장.

**주의:** 프롬프트로만 강제되는 코드 영역 제한은 완전한 보안 경계가 아닙니다. Codex가 허용 파일 외부를 변경하면 원본에 합치지 않고 `OUT_OF_SCOPE_CHANGES`로 처리합니다. 실제 외부 네트워크 격리는 로컬 OS의 샌드박스 기능과 Codex 버전에 따라 검증해야 합니다. 중요·민감한 저장소에는 먼저 Windows 샌드박스/VM 사용을 권장합니다.

## 실행 결과

| 상태 | 의미 |
|---|---|
| WAIT_OPERATOR_APPROVAL | 출력 지문을 확인하고 직접 승인이 필요한 단계. Codex 미실행 |
| WAIT_GITHUB_PR_AND_CI | 별도 worktree에서 허용 범위의 로컬 변경을 검증. GitHub 미검증 |
| NO_CHANGES | Codex는 종료됐지만 검증할 파일 변경이 없음 |
| OUT_OF_SCOPE_CHANGES | 허용되지 않은 파일이 변경돼 격리 상태로 보류 |
| HEAD_CHANGED | 예상 Git HEAD가 바뀌어 승인한 기준점과 다름 |
| DIFF_CHECK_FAILED | Git diff 기본 검사 실패 |
| CODEX_REPORTED_FAILURE | Codex 프로세스가 실패 상태로 종료 |
| RUN_FAILED_UNKNOWN / PROCESS_TIMEOUT | 실행 결과 불명. 자동 재제출하지 않음 |

**WAIT_GITHUB_PR_AND_CI는 성공 완료가 아닙니다.** 사용자가 격리된 worktree의 diff를 검토하고 GitHub PR로 연결해야 합니다. 이후 기존 Watchtower + GitHub 사실 검증 계층을 사용해 **정확한 PR/Run/SHA/Attempt**를 별도로 검증합니다. 이번 PR에는 자동 commit, push, PR 개설, 병합, CI 자동 완료 인증이 없습니다.

## 로컬 기록과 개인정보

- 감사 기록: `<원본 workspace>/.autopilot/codex-runs/<runId>.json`
- 격리 worktree: OS 임시 디렉터리 `autopilot-codex-*` 아래 `worktree` (result에 정확한 경로 표시)
- 기록에는 작업 ID, 실행 fingerprint, Git 기준 SHA, 허용/변경 파일명, diff fingerprint 및 상태만 저장합니다.
- 작업 본문, Codex stdout/stderr, Codex 인증 토큰은 기록하지 않습니다.
- 종료된 작업은 자동으로 격리 worktree를 삭제하지 않습니다. 사람이 diff를 확인한 후 수동 정리해야 합니다.
- 임시 폴더 삭제만 수행하면 Git이 등록한 worktree 참조가 남을 수 있으므로 `git worktree remove <path>`로 정리하십시오.

## 현재 구조적 경계 및 남은 작업

- 이 명령은 **로컬 터미널에서만 명시적으로 실행**되며, localhost 대시보드나 35분 자동 스케줄러에 연결하지 않습니다.
- Phase 4-A MockExecutor는 계속 기본 실행기입니다.
- 사용자 PC에서 Codex 로그인, 권한, 토큰/요금 상태, 실제 파일 변경 여부 확인 필요.
- 사용자 승인 기록을 SQLite Workstream Task/PR/CI 등 현재 Decision Gate와 안전하게 연결하는 추가 구현 필요.
- 실제 변경 내용을 PR에 반영했음을 독립적으로 증명하는 파일·커밋 연계 검사, 실 CI/PR 최종 검증 및 Phase Closeout 필요.
- Windows의 별도 앱 설치/트레이 프로그램 및 긴급 정지·취소 확인은 이후 단계.

## Windows/Ubuntu CI 검증

테스트는 실제 Git을 사용해 feature 브랜치·origin·별도 detached worktree를 만든 다음, Codex 호출만 가짜 함수로 대체합니다. 이 방식으로 승인 지문, 원본 보호, 불허 파일 변경, 실패·무재시도 및 JSON 감사기록을 검증합니다.

**자동 테스트 통과는 실제 Codex 실행 또는 사용자의 Windows PC 인증 성공을 의미하지 않습니다.**

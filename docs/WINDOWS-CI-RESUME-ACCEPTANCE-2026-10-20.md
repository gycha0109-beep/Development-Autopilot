# Windows Chrome CI resume acceptance — 2026-10-20

**PASS for one approved original Windows Chrome test conversation:** normal
CI-wait response → exact Watchtower/GitHub RUNNING evidence → persisted automatic
rechecks without a prompt → exact Attempt 2 SUCCESS and merged/checks verification
→ one automatic continuation → next assistant complete → read monitoring with no
further send. This is a controlled actual-account acceptance, not 20-axis product
readiness or permission for additional development messages.

## Corrected browser diagnosis

The original `codex_ci_recovery` tab showed a completed **CI 확인 중입니다.**
reply to the approved seed. The separately registered copy of that same logical
conversation showed a response/conversation loading error. The earlier report
overgeneralized the copy's failure; it did not establish that the original
conversation had failed to generate an answer. The cause of the tab discrepancy
remains undetermined. No error predicate or observation threshold was relaxed.

The original tab's registration still pointed at the previous failed conversation.
The user used the existing extension **탭 재연결** control after privileged
extension-page access was unavailable to the agent. This preserved physical tab
`1042919563`, the `codex_ci_recovery` group, workstream `ci-recovery-20261020`,
session `a96b7051-5785-4a2f-b712-6cac2370fc09`, and all prior command records.
The old read/send scope was stopped before rebinding; a new read challenge then
corroborated the exact current binding and normal CI-wait reply.

No further seed or regeneration was sent during this corrected test. The remaining
approved conditional continuation was assigned only to the original workstream;
the copy's campaign remained disabled. The original `codex_test` retained its
two commands and paused state. Watchtower Registry and Track attribution were
preserved. No PR merge or deployment is authorized by this acceptance.

## Actual target and observed running-state behavior

| Field | Exact target |
|---|---|
| Repository | `gycha0109-beep/CI-Watchtower` |
| Watchtower Project / Track | `ci-watchtower` / `ops` |
| Watchtower Repository ID | `1` |
| PR | `65`, already merged |
| Head SHA | `5ce649ca24e4825917d8eabb5a490e6c4cca0cff` |
| Workflow / Run | `CI` / `38357525075` |
| Attempt | **2**, independently confirmed after one approved rerun |

1. The actual extension delivered `verified=true`, `ciWaitCue=true`,
   `contentComplete=true`, `assistantBusy=false`, `composerHasDraft=false` and
   `uiAmbiguous=false`. The original response fingerprint remained stable.
2. Persisted a one-use rerun intent, then requested the already-approved GitHub
   rerun once. GitHub first returned a transient Attempt 1 / queued state; no
   target was guessed from that response. After GitHub confirmed Attempt 2 /
   in_progress, the workstream's exact Watchtower/GitHub targets were configured.
3. Watchtower initially rejected the cached previous attempt. Automatic resume
   remained unapproved/blocked until both sources corroborated Attempt 2 RUNNING
   with the existing `ops` attribution. No previous green attempt was substituted.
4. A stale preview prevented initial activation. Requested another actual Chrome
   observation and kept the 180-second freshness limit unchanged.
5. Armed one-hour, one-minute-interval, **maximum one** `계속 진행` campaign with
   conditional target hash
   `5c57f87206331a8dae8bd2bb5e4ac4210dd0acc3b66319b12c2ced8aaad24df9`.
   Activated the existing SQLite coordinator using the fresh original-tab binding.
   No manual `send-now` was used for the conditional continuation.
6. The actual engine selected **WAIT_CI / CI_RUNNING**, persisted `ciWait.startedAt`
   `1792479886885`, and an independent `next_external_check_at`. A later automatic
   read/recheck retained WAIT_CI and advanced that timer from `1792479946888` to
   `1792480057966`, without any continuation command or budget consumption.

7. The approved real CI rerun completed successfully. GitHub reported Attempt 2
   / completed / success, with `run_started_at=2026-10-20T07:00:43Z` and
   `updated_at=2026-10-20T07:13:49Z`. While GitHub had SUCCESS but Watchtower still
   had RUNNING, no continuation was sent. After Watchtower independently reached
   FRESH / SUCCESS / `ops`, the same target remained approved. GitHub corroborated
   PR 65 MERGED_CONFIRMED and required checks verified: main was explicitly
   unprotected with independently empty rules, not a guessed absence of checks.
8. The engine selected **CONTINUE / STABLE_RESPONSE_AND_APPROVED_SCOPE** and
   reserved SQLite operation `6b0ea35e-bf19-489b-a912-9bf4ff592272` before dispatch.
   Its single submitted response claim bound command
   `88819a85-6908-49f9-8441-1f7eb8d6ceed`, **sent / attempt 1**, with send ACK
   `1792480598380` (**16:16:38.380 KST**). The normal phase gate remained
   WAIT_HUMAN / executionAllowed=false; only the bounded conditional chat scope
   authorized this continuation. No merge/phase review was fabricated.
9. The original tab visibly contained exactly one user **계속 진행**, followed by
   **CI 재개 확인 완료.** All three visible turn states were complete and the
   composer was empty. This independent DOM evidence establishes the next answer;
   the button-click ACK alone does not establish assistant completion.
10. The still-enabled real worker then observed that new reply with
    `verified=true`, `contentComplete=true`, `assistantBusy=false`,
    `ciWaitCue=false`, same physical binding and new reply fingerprint
    `dd4b24d917f19783b195ae3f1471c9638ea7502f2865a823122c1ebb7fe75c35`.
    The coordinator selected **NO_ACTION / APPROVED_MESSAGE_LIMIT_REACHED**.
    Campaign count was **1/1**, disabled/expired with APPROVAL_LIMIT, while the
    read schedule remained enabled. There was one response claim, one automatic
    continuation command, no third test message and no repeat attempt.

All five minimum conditions are therefore observed on the original test tab:
completion detection, one conditional continuation, next-answer completion,
continued monitoring without duplication, and no further manual action after
initial enrollment/approval and runtime activation. Initial manual tab rebinding
remains an onboarding limitation, not evidence of fully automatic enrollment.

## Local evidence and source boundaries

Ignored local files under `.autopilot/acceptance-evidence/`:

- `2026-10-20-original-tab-correction.json`
- `2026-10-20-original-recovery-ci-cue-confirmed.png`
- `2026-10-20-original-ci-cue-fresh-worker.json`
- `2026-10-20-ci-rerun-38357525075-intent.json`
- `2026-10-20-ci-rerun-attempt-confirmed.json`
- `2026-10-20-original-running-observed.json`
- `2026-10-20-ci-resume-before-configure.json`
- `2026-10-20-ci-resume-runtime-first.json`
- `2026-10-20-ci-wait-auto-recheck.json`
- `2026-10-20-ci-github-success-awaiting-watchtower.json`
- `2026-10-20-ci-auto-resume-sent.json`
- `2026-10-20-ci-resume-sqlite-ledger.json`
- `2026-10-20-ci-resume-timeline.jsonl`
- `2026-10-20-actual-ci-auto-resume-dom.json`
- `2026-10-20-actual-ci-auto-resume-complete.png`

The selected CI result is [Run 38357525075, Attempt 2](https://github.com/gycha0109-beep/CI-Watchtower/actions/runs/38357525075/attempts/2).
Local raw evidence remains ignored, with no authentication tokens or credentials
included in this committed report.

These use real Windows Chrome UI, actual MV3 worker challenges/receipts,
SQLite-backed runtime snapshots and GitHub/Watchtower responses. They are not an
isolated fixture or an actual-browser Playwright trace ZIP. The agent used the
supported browser Playwright surface for read-only DOM inspection. Native CDP
network initialization was unavailable; network failure origin is not inferred.

Live extension: **0.4.38**, worker protocol `composer-2026-10-15-r17`. The running
server was started from PR #70; the additional whole-conversation diagnostic in
PR #71 was not installed into the live extension. That diagnostic does not change
the successful normal-response CI path. Current source regressions/isolated E2E
and actual browser acceptance remain separate evidence.

CI failure, long wait, query-unavailable recovery, disconnection recovery,
migration, messenger and 3/10/20-tab real unattended operation remain separate
uncompleted acceptance scenarios.

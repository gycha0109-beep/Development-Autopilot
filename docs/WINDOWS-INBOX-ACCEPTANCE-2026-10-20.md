# Windows local Inbox acceptance — 2026-10-20

## Live result

The existing real Windows Chrome `codex_ci_recovery` test tab passed: human-action
cue → axis pause → dashboard hold/approval record → paused read-only inspection →
unresolved resume blocked → normal response inspection → request closed and
monitoring resumed. This follows the separate [CI auto-resume acceptance](WINDOWS-CI-RESUME-ACCEPTANCE-2026-10-20.md).

The user authorized continued test messages. Codex sent two short prompts through
the real ChatGPT UI: one asked for the exact local-test cue; the other simulated
completion of the human action. These are test inputs, not evidence that Autopilot
can perform the human action. No real Windows test, payment, merge, regeneration,
new automatic continuation, or Watchtower rerun occurred in this test.

- Existing workstream `ci-recovery-20261020`, Chrome tab `1042919563`, session
  `a96b7051-5785-4a2f-b712-6cac2370fc09` were retained. No re-registration or
  extension Reload was needed. The server restarted with the existing SQLite.
- Actual assistant: `로컬 Windows 테스트가 필요합니다.`. A verified, complete worker
  observation with `humanActionCategory=local_test` opened request
  `54ff3c14-48da-4508-95b0-39aafe38b5b5` and paused only this axis.
- Dashboard hold and approval changed revisions 1→2→3, without unpausing or
  changing the already exhausted 1/1 campaign. Paused challenge
  `ecdcc7b4-7951-4734-bc65-d8e3e6e744bb` received the same unresolved cue. The resume
  button stayed disabled, and a same-origin API resume was rejected with
  `OPERATOR_ACTION_STILL_REQUIRED`.
- After simulated human completion, the actual assistant answered
  `테스트 조치 확인 완료.`. Paused challenge
  `dcb81e92-26fc-4c1b-867e-31fd09f475cc` received a verified normal complete response
  from the original binding, with no draft, busy state, warning, CI or human cue.
- Dashboard resume succeeded at **16:54:46 KST**. Revision 4 is closed; only this
  axis was unpaused and inspection/external checks became due. Before/after
  campaign settings and command IDs/states were equivalent. The prior CI test's
  single automatic `계속 진행` remained the sole automatic continuation.
- A subsequent autonomous worker read after the resume barrier received the
  normal completion response again. At 16:57:50 KST the decision remained
  `APPROVED_MESSAGE_LIMIT_REACHED`, with no new commands, unchanged campaign
  settings, and unchanged sibling workstream states/pauses.

Ignored local evidence under `.autopilot/acceptance-evidence/`:
`2026-10-20-inbox-live-intent.json`, `2026-10-20-inbox-approved-still-paused.json`,
`2026-10-20-inbox-premature-resume-blocked.json`, `2026-10-20-inbox-live-chat-dom.json`,
`2026-10-20-inbox-resumed.json`, `2026-10-20-inbox-reviewed-resume.png`.
`2026-10-20-inbox-post-resume-no-duplicates.json` records the later worker read.
These browser/HTTP artifacts are not a Playwright trace of the real account.

## Connected behavior

Same-origin JSON-only `/api/v1/operator-inbox/command` and dashboard buttons expose
status, hold, approval recording, rejection, reinspection and reviewed monitoring
resume. Request revision/action/SHA/task checks and durable command receipts reject
duplicate/stale actions. Remote decisions invalidate local reviews.

An existing observation scope can read a paused axis for one exact request revision;
all dispatch guards remain in force. Resume requires fresh normal same-binding
evidence matching the request, configured targets and current server process.
Restart, rebind, task/target drift, STOP, stale/negative evidence or an uncertain
operation blocks resume. Other unresolved requests retain the pause.

Resume never replenishes, re-enables or extends a campaign, or grants cost, merge
or CI authorization. Two post-resume observations must establish stability before
any future dispatch. A resolved warning recurring later reopens a new revision and
pauses again; old commands/observations cannot resolve the new occurrence.

## Verification and limits

Windows local `npm run check`: **509/509 pass**. Isolated Playwright MV3 E2E passed
the production HTTP/dashboard Inbox path, including blocked premature resume and
reviewed resume with zero sends. These fixtures are separate from the real account
above. Windows/Ubuntu CI results are recorded on the feature PR.

The first Windows CI attempt passed all 509 code tests but exposed a dashboard
race in the earlier tab-linking portion of E2E: an asynchronous refresh replaced
the selected tab with the first option. The UI now retains each unsubmitted choice
only while that exact session remains available, and starts with a disabled
placeholder instead of selecting a tab implicitly. E2E forces a real refresh
between selection and assertion, leaves the production polling timer enabled,
and retains exact-tab assertions. This fixes the cause rather than weakening the
test or retrying a wrong-tab registration.

The resume path requires an existing active observation schedule, a non-expired
Inbox request and a recovered normal response. A CI cue/error still present does
not count as normal recovery. STOP and expired/stale enrollments are not cleared.
Messenger transport remains disabled and unimplemented. Disconnect Stop/report
adapters, decision-engine handoff execution and real 3/10/20-axis acceptance remain
unfinished separate work. This change does not complete those flows.

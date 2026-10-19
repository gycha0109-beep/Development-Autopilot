# Windows Chrome acceptance — 2026-10-19

Scope: the approved `codex_test` group in the user's signed-in Windows Chrome, one physical tab, an existing Workstream, and at most two real account messages. This report distinguishes actual ChatGPT execution from fixture tests. No PR was merged.

## Runtime fixes discovered by the real test

- PR #60 (`feat/localhost-created-chat-rebind`): a seed sent from the registered ChatGPT landing page creates a conversation URL. Keep the same tab, session and Workstream, and confirm the generated address explicitly from localhost instead of leaving continuation permanently `url-changed`.
- PR #61 (`fix/current-chatgpt-response-observation`): the actual response renderer uses conversation/assistant unit boundaries, corroborated message IDs and explicit turn completion state rather than the legacy author-role selector. Unknown or contradictory layouts still fail closed.
- PR #62 (`fix/created-chat-rebind-after-extension-reload`): Chrome extension Reload clears session storage and makes the existing registration `needs-rebind`. An explicit, short-lived confirmation bound to the current browser-epoch hash can restore the original single-member bootstrap group. It cannot silently reactivate other registrations.
- `fix/observe-after-approved-send-limit`: the real post-send check found that a normally exhausted campaign opened a `SCOPE_NOT_APPROVED` Inbox item and paused observation. The coordinator now keeps independent read consent active with `NO_ACTION / APPROVED_MESSAGE_LIMIT_REACHED`; exhausted queue/claim budgets still prevent another message. Actual cost/provider/human requests retain their gates.

The unpacked extension was updated at the user's confirmed load path, `D:\cha\Development-Autopilot\extension` (0.4.36). The local server uses the existing acceptance SQLite file. The original missing registration named `자동 이관 검증 1` is retained. No old registrations, failures or settings were reset.

## Actual account test

1. Opened one new, empty ChatGPT test tab and placed it in `codex_test`; other chats were untouched.
2. Discovered it through the paired extension and confirmed its enrollment into the existing Workstream from localhost. Tab/window/group identity and URL fingerprints were checked by the extension.
3. The existing SQLite command queue and extension executor sent `Development Autopilot 테스트입니다. 짧게 응답하고 멈춰 주세요.` once. The actual assistant replied `Development Autopilot 테스트 응답 완료.` The command has one claim attempt and one sent receipt; it was never replayed.
4. After the runtime updates and Chrome Reload, confirmed the generated address on the same physical tab. Original session and Workstream IDs were preserved, previous execution/observation permissions were stopped, and fresh read consent was applied.
5. The actual extension-to-server observer reported a complete response, no active generation, no draft and no ambiguity. This is separate from the preliminary direct read-only collector diagnostic.
6. Configured the remaining approval as **one** scheduled `계속 진행`, one-minute send eligibility, one-hour expiry. Runtime policy retained 30-second stability, 60-second inspections, 180-second freshness and 80-second observation timeout.
7. The unattended coordinator observed the unchanged response repeatedly, reserved its operation before dispatch, and decided `STABLE_RESPONSE_AND_APPROVED_SCOPE`. The extension sent `계속 진행` once. The actual assistant replied `Development Autopilot 테스트를 계속 진행합니다. 현재 응답 정상입니다.` Both real message commands have exactly one claim attempt. The scheduled approval expired automatically after its one allowed send.
8. The extension-to-server observer confirmed the **new** assistant response fingerprint as complete and not busy after the second sent receipt. The first post-limit check exposed the observation pause above. After applying the server-only fix, the one newly generated test Inbox item was closed **without approval**, retaining its audit record. Only that test Workstream was unpaused for read-only monitoring; the campaign stayed expired and both sent commands stayed immutable. Two subsequent fresh real observations, 120,069 ms apart, confirmed the same completed second response, active reading, an unpaused Workstream and `APPROVED_MESSAGE_LIMIT_REACHED`, with exactly two sent commands and no third command.

No user interaction was required between enabling the final bounded campaign and its automatic continuation/reply. Loading updates and explicit setup/rebinding required user/agent setup actions; this is not a claim of unattended installation, restart recovery for every registration, or automatic setup after arbitrary navigation.

The two approved messages were consumed before the final server-only observation-limit correction. That correction is checked against the existing real completed response and exhausted campaign without sending a third message. A fresh two-message campaign entirely on the final build was not run; the historical first monitoring attempt's timeout remains in the evidence.

## Evidence and validation

Local evidence lives under `.autopilot/acceptance-evidence/` and is excluded from Git: screenshots of the seed and next real response, sanitized snapshot/command receipts, the actual observation stream, and a JSONL monitor trace. SQLite retains enrollment intents, observation timestamps, response fingerprints and operation/command IDs. No full Playwright trace ZIP for the user's profile is claimed.

Code validation: `npm run check` 453/453; isolated unpacked-MV3 Playwright E2E passes. Windows and Ubuntu GitHub Actions for PRs #60–62 succeeded, including their isolated E2E jobs ([PR #62 run 39220918949](https://github.com/gycha0109-beep/Development-Autopilot/actions/runs/39220918949)). The final observation-limit change has its own CI run. Fixture tests are not counted as actual ChatGPT acceptance.

## Still unverified in the real environment

- CI Watchtower waiting/recheck/resume: bridge credentials unavailable; no actual CI-wait test was run.
- Actual disconnection stop/report/resume and length-limit same-tab migration.
- Messenger authentication, notifications and remote commands.
- Concurrent real-account operation at 3, 10 or 20 tabs. Existing scale tests use isolated fixtures.
- Installed Windows service/EXE lifecycle and unattended restart of the full stack. The local development server was run directly for this acceptance session.

The first completed slice is the bounded normal-response loop only; the items above remain separate acceptance work.

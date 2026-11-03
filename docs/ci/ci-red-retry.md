# CI RED automatic investigation and retry prompt

Autopilot 0.8.8. This change affects the server-side default chat macro only; the browser extension remains 0.4.53.

## Expected behavior

A registered chat associated with a repository sends one CI RED prompt when the direct CI observer has a fresh FAILURE for the exact repository, Run ID, attempt and HEAD SHA, and the incident ledger independently reports the same run as failed.

The prompt asks ChatGPT to inspect the GitHub Actions failure logs and steps, identify the root cause, fix the code/configuration, re-run applicable tests, retry CI, and verify the outcome. It includes the failure's repository, Run ID, attempt and SHA. A prompt is an *investigation instruction*, not proof that the code was fixed or the CI rerun succeeded.

- RUNNING / QUEUED or unverified CI: hold; do not dispatch a RED prompt.
- An open draft, active generation, other warning, or otherwise unsafe editor: wait and observe again rather than forcing manual intervention; never overwrite a draft.
- The same failed run+attempt+SHA: send at most once, backed by the persistent chat macro store and browser-side submit proof.
- A genuinely new failed attempt: independently verify the new evidence and a fresh, stable reply before sending again.
- Stale/unavailable evidence, missing matching incident, unrelated repository, prior run attempt, full system STOP, or an unregistered chat: no automatic send.
- Real ChatGPT messages, CI reruns and production changes were not performed as part of the test.

## Validation

- Local full check: 497/497 passing.
- Isolated Playwright Edge with the earlier Codex synthetic ChatGPT simulator, but latest Autopilot code in a newly generated test-only server and extension: synthetic CI RUNNING produced zero sends, switching to RED produced exactly one message, repeated RED did not send again, and no Workstream was needed.
- Test-only browser was isolated from chatgpt.com by extension host permissions and network restrictions; test-only server used its own SQLite and synthetic CI facts.
- The Playwright test evidence is retained in the older simulator worktree at .autopilot/e2e-artifacts/ci-red-current-results.json. This test is not a live Github or live ChatGPT acceptance.
- Installed academy Autopilot remains unchanged and globally STOPPED pending separate rollout.

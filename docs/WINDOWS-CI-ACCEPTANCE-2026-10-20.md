# Windows CI integration acceptance — 2026-10-20

Base: PR #63, `34e225b494b4157f9453918caf64125a59104ac5` (open/unmerged;
Windows and Ubuntu workflow `39223438119` succeeded).

## Actual installed Windows results

- Restarted Autopilot on port 48173 with the existing `.autopilot/acceptance.sqlite3`.
  Existing `codex_test` registrations, two sent commands, failures and Inbox history retained.
- Actual Chrome profile `내 Chrome` is accessible through the supported browser interface.
  It has no open tab groups; the previous test tab is absent and its link needs rebind.
  No existing registration was repointed and no ChatGPT message was sent.
- Launched the pre-existing `Downloads/ci-watchtower-windows/ci-watchtower.exe`, file
  version 0.3.39, SHA256 `59120a61a4eb244f000bf676f79261a3d0a0cc549f8dc9236e3345073455a792`.
  Its actual window and localhost listener were confirmed. Installer commit is unknown.
- Reproduced `CREDENTIAL_UNAVAILABLE` while the real bridge was listening.
  Root cause: Autopilot decoded keyring 3 `set_password` data as UTF-8; the producer
  stores 64 hex characters as 128 bytes of UTF-16LE. Fixed decoding and strict validation.
- Production `WatchtowerClient` authenticated to actual `/v1/health` and `/v1/registry`.
  Registry contained 3 projects, 1 enabled repository and 2 tracks. The only repository
  was `gycha0109-beep/CI-Watchtower`; **Development-Autopilot is not registered**.
  No Watchtower Registry, Track, credential or DB was edited by Autopilot.
- Playwright controls in the actual Windows Chrome localhost page clicked
  `CI 상태 새로고침` and confirmed `연결됨 · 계약 1.0`.
- Read an exact existing CI-Watchtower run `35647965141`, attempt 1, SHA
  `11a163e7adebb505b3cb28d9103f9953d3e4bd4c`, track `pipeline-reliability`.
  Its cached raw CI state was SUCCESS but evidence was STALE; the production decision
  returned UNKNOWN / UNTRUSTED_EVIDENCE / safeToAdvance=false. It was never mapped
  to `codex_test` and is not evidence of that workstream's CI success.

Private ignored evidence: `.autopilot/acceptance-evidence/2026-10-20-watchtower-connected.json`,
`2026-10-20-watchtower-exact-stale.json`, `2026-10-20-real-chrome-watchtower.png`.
No token or PAT is recorded. These are live HTTP/UI observations, not a Playwright trace ZIP.

## Automated regression boundary

`npm run check`: 454/454 passed locally on Windows. The added Windows-only test executes
the production PowerShell decoder's synthetic SelfTest, rejecting UTF-8, non-hex and
oversized blobs without accessing Credential Manager. Ubuntu skips this Windows-only
test. This unit test does not replace the live authenticated observations above.

## Still unverified / required before a real CI resume test

- No actual ChatGPT CI-wait response, pending-to-completed transition, automatic resume,
  or next assistant response was tested today. The old two-message approval is exhausted.
- Official GitHub CLI 2.102.0 was subsequently downloaded to ignored `.autopilot/tools`
  and its published SHA256 asset digest verified. `gh auth status` confirms no logged-in
  GitHub host. No credential was borrowed from Watchtower, Git or the connector.
- A suitable exact Watchtower Repository/Project/Track and PR/SHA/Run/Attempt must be
  established without changing the existing `codex_test` mapping or inventing attribution.
- Fresh explicit permission is required for any new account messages. Closed user groups
  have not been restored or reused silently.
- Watchtower lifecycle/restart credential continuity, prolonged CI, CI failures, disconnect
  recovery, migration, messenger and real 3/10/20-track operation remain separate gates.

## Exact CI verification and bounded waits (follow-up)

The production GitHub observer now forwards the configured Watchtower Run ID and
Attempt to the verifier. It reads that Run twice, requires exact repository/head SHA,
current attempt and an explicit PR/head association, and rejects retries or state changes
during verification. Empty PR association (including some push/fork workflows) stays
unverified; no association is inferred from a green commit. The success gate also
requires matching Watchtower/GitHub run state. Concurrent Watchtower target changes
invalidate an in-flight GitHub refresh. Existing review and bounded message scopes remain.

CI recheck timers retain their existing independent SQLite schedule. New persistent CI
wait episodes retain exact workstream/revision/binding/response/target identity, start time,
and continuous unknown time. 30 minutes pending or 5 minutes continuously unverified
creates a categorized Inbox request and pauses only that axis. Episodes survive restart;
changed targets/responses end the prior episode without deleting history. The local UI
shows recheck/start times and actionable CI instructions.

Local Windows `npm run check`: 463/463 passed. Exact identity/rerun-race, deadline,
restart, one Inbox and sibling isolation checks are **synthetic regressions**.
They do not establish the real pending-to-success ChatGPT loop.

An additional **live public GitHub diagnostic** ran the production verifier with an
injected read-only official REST client against actual PR #64 / SHA
`0275912ece31ea7df7490dffa8477afaa5c20a58`, Run `39349694210`, attempt 1.
It independently confirmed `runVerified=true` / SUCCESS. Branch protection access
returned HTTP 401, so the overall result correctly remained UNKNOWN /
REQUIRED_CHECKS_UNVERIFIED. This was not the server's authenticated CLI adapter,
did not modify local targets, and did not authorize a send. Private evidence:
`2026-10-20-real-github-exact-run.json`.

PR #64 Windows and Ubuntu CI (including isolated browser E2E) passed, run `39349694210`.

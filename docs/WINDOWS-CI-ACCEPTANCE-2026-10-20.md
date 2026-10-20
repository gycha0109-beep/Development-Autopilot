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
during verification. Missing PR association stays unverified unless independently established
by the official commit-to-PR endpoint and unchanged PR branch (see live case below);
no association is inferred from a green commit. The success gate also
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

## Explicit consent while CI is pending (follow-up)

Found a separate operational gap: the old campaign configuration required an already
reviewed successful CI snapshot, so an operator could not approve a bounded future
continuation while that exact CI was still running. Added an opt-in checkbox displaying
Repository, canonical Track, PR, SHA, Run and Attempt. The UI captures the exact target
hash at selection time; polling or choosing another workstream cannot silently replace it.

The server only accepts this consent with fresh, independently corroborated source/Run
identity. It stores the hash alongside the existing message, expiry and maximum count.
This grants chat continuation after **merged + all required checks verified**, not a
merge, deployment, phase completion or expenditure. Pending CI still blocks queue and
claim. Unknown/failure/stale evidence blocks. Removed mappings, changed PR/SHA/Run/
Attempt/revision/Track or reconfigured target timestamps require new consent. Queue
and claim use the same CI permission check. Legacy approvals default to null and are
not upgraded automatically.

Local Windows `npm run check`: 470/470 passed. New synthetic integration tests arm
while pending, retain consent through runtime restart, release after exact merged
success, claim once, observe a new response and retain a one-message budget. Negative
tests cover absent/forged consent, target removal, late target drift, stale/failed/
unmerged evidence, drafts, generation and expiry. No phase review is fabricated.

After a development-server restart on the original DB, actual Chrome Playwright verified
Watchtower connected and the CI consent checkbox disabled for the unconfigured existing
workstream. The two original command records and workstream rows were compared unchanged;
no conditional consent was added (`ciResumeTargetHash=null`), no ChatGPT message was sent,
and no original browser group/registration was changed. Private evidence:
`2026-10-20-readonly-final-runtime.json`.

The official CLI is now on the development server's process-local PATH, but authentication
still requires the user. Public GitHub cannot verify the protected-branch endpoint (401).
Actual CI-to-ChatGPT resume acceptance remains **NOT COMPLETED** pending a registered
test CI target, authentication and separately approved new account-message scope.

PR #65 Windows and Ubuntu CI (including isolated browser E2E) passed, run `39350310883`.

### Additional actual GitHub compatibility defect

Actual CI-Watchtower PR #65's merged branch Run `38357525075` returned an empty
`pull_requests` array. The official commit-to-PR endpoint independently returned exactly
PR #65, SHA `5ce649ca24e4825917d8eabb5a490e6c4cca0cff`, branch
`chore/desktop-version-0-3-40`. Added a strict fallback for empty Run arrays only:
exact repository/PR/head SHA, matching unchanged head branch across both PR reads,
and one exact commit association. A base-branch push additionally requires both PR
reads to prove that exact SHA is the merged commit. Contradictory/nonempty Run
associations, ambiguous commit results and unrelated branches remain blocked.

Re-executed against real sources: Watchtower returned FRESH SUCCESS for the exact
`ops` Track / repository 1 / Run `38357525075` / attempt 1. The GitHub verifier
confirmed the same Run/Attempt through `commit_pull_association` and merged PR #65.
The overall result **remained UNKNOWN / REQUIRED_CHECKS_UNVERIFIED** because the
public client cannot read branch protection. No local Workstream or Watchtower
mapping was created for this diagnostic. Evidence:
`2026-10-20-real-matched-ci-sources.json`.

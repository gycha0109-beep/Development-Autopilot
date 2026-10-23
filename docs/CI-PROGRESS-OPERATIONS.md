# PR-scoped CI Progress / Supervision (2026-10-23)

## Purpose and scope

This is the Development Autopilot consumer-side increment to the CI Watchtower bridge. The existing merge/phase-approval gate, Watchtower database, production server and Chrome extension behavior remain unchanged.

It distinguishes **PR preflight checks** from a separately initiated **integration check**, keeps exact GitHub/Watchtower evidence bound to a workstream and exposes advisory GREEN/RED/PENDING/UNKNOWN states. No CI result, including GREEN, directly authorizes roadmap advancement, prompt dispatch, PR merge or production deployment.

Implemented in `local/ci-progress.js` (assessment and stage target) and `local/ci-incident-ledger.js` (persistent failures, repair attempts, blocker threshold and alert outbox).

## Evidence boundary

To produce a non-UNKNOWN verdict, the current revision requires:

- A single configured GitHub PR target with exact full HEAD SHA.
- A Watchtower bridge (contract 1.0) connected to a single exact repository, Run ID, SHA and latest Attempt.
- Matching workstream repository, canonical track where configured, run identity and GitHub independent run verification.
- Fresh observations and complete GitHub commit Check Runs (the existing max-page limit of 100 is fail-closed).
- A verified nonempty required-check set from GitHub policy.

The existing GitHub verifier emits both `checks` (required contexts) and `observedChecks` (complete Check Runs for the exact HEAD). `CI Integration Verify` is the default optional integration context and is configurable per workstream. There are no hardcoded producer repository names.

The integration gate becomes relevant if it is explicitly selected, required by GitHub policy, **or an integration check is actually present** on that SHA. An optional check that has never run does not automatically block the ordinary preflight stage. A selected but absent integration check is PENDING, not GREEN. Any missing or conflicting proof yields UNKNOWN.

The selected stage is stored in a separate `ci_stage_targets` table. The POST API is same-origin only:

`POST /api/v1/workstreams/:id/ci-stage`

Body example: `{"stage":"integration","integrationCheck":"CI Integration Verify"}`.

`GET /api/v1/snapshot` now includes `ciProgress` (per-workstream proof) and `ciSupervision` (persistent blockers, retry receipts and alerts). The Activity view shows these without injecting HTML or requesting execution.

## Failure and notification policy

- RED creates **one unresolved incident per workstream/task revision/set of failed check names**. New commits with the same failing checks update evidence without creating a duplicate.
- Polling RED does **not** consume retry budget. `CiIncidentLedger.acknowledgeRepair` increments attempts only after an authorized executor acknowledges one distinct operation; it is **not yet attached** to a real repair executor.
- At most two acknowledged repair attempts are allowed. A further RED produces a `CI_RETRY_EXHAUSTED` blocker.
- Three distinct unresolved blocker/approval items pause the affected workstream, not its siblings. A critical blocker pauses at one.
- The pre-existing Operator Inbox intentionally pauses on the first approval request. The new three-item policy is an **additional limit** and does not weaken this existing safety rule.
- Reobserved GREEN closes only CI-generated failure blockers. Manual/approval blockers survive; no automatic unpause occurs.
- Each transition into an over-threshold/critical episode stores one notification intent in `ci_alert_outbox`. Additional items during the same episode do not create more intents; a new episode after resolution may create a new one.
- **SMS is not transmitted.** No provider credential, destination phone number or authorized delivery transport has been configured. The outbox is pending work for an independent notification adapter. Do not claim notification delivery.
- The display and ledger are observational/safety-restricting only. Automated code repair, roadmap continuation, SMS delivery and PR merge need separate authorized execution adapters.

## Compatibility / current prerequisites

- Watchtower currently provides a bounded historical run sample (`completeCoverage=false`); it cannot by itself prove every required check. The GitHub verifier is authoritative for required check coverage.
- The consumer currently needs manually bound exact Watchtower Run + PR targets, so future improved Watchtower multi-Run API can replace the manual binding without weakening the gate.
- The local GitHub verifier runs the `gh` CLI for read-only GitHub API requests. In the tested Windows development context, `gh` is **not on PATH**. Real live GitHub verification remains unavailable until an approved, authenticated local GitHub CLI is configured. The GitHub connector in ChatGPT is not automatically available to the local process.
- The v1 dashboard still distinguishes `CHECKS_PASSED_NOT_MERGED` from `MERGED_CONFIRMED`. Existing approvals are unchanged.

## Test evidence

- `npm run check`: 620 tests passed (initial run before the small final alert-dedupe changes).
- `node --test tests/ci-progress.test.js tests/ci-incident-ledger.test.js`: 21 tests passed following those changes.
- Headless Edge at an isolated `127.0.0.1:48174` with disposable SQLite: Activity UI, API stage selection and conservative UNKNOWN for a deliberately unbound test workstream passed, 0 JavaScript page errors.
- Neither the real 48173 application, production SQLite, existing Chrome account nor GitHub PRs were modified during these tests.

## Follow-up (not falsely marked complete)

1. Re-run full test suite after final edits, then review PR CI.
2. Merge Watchtower's consumer contract only after its own independent tests and exact multi-Run attribution are available. Do not guess future fields.
3. Register and verify a real **exact** MyeongHa PR/Run/HEAD/Attempt, then a Saju PR on the authorized Windows profile with GitHub CLI available.
4. Connect a separately approved repair executor to `acknowledgeRepair` with an authenticated operation receipt; never increment attempts merely because a model says it attempted a repair.
5. Connect an opt-in SMS provider, recipient, secure credential source and idempotent delivery receipts to the outbox, and test failure/restart recovery before allowing actual messages.
6. Consider automatic exact target discovery only after the Watchtower bridge explicitly supports it; keep stale/conflict/fail-closed invariants.

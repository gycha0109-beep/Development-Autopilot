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

- `npm run check`: 636 tests passed, 0 failed after Watchtower 0.3.41 consumer integration. This is isolated test evidence, not live real-account acceptance.
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

## Watchtower PR #66 consumer integration (added 2026-10-23)

Producer candidate: https://github.com/gycha0109-beep/CI-Watchtower/pull/66 (still unmerged and not assumed installed). Version 0.3.41 adds `GET /v1/runs?repository_id=...&pr_number=...`, extends exact `GET /v1/runs/{runId}` with `pr_number`, and adds exact `GET /v1/runs/{runId}/jobs`. The read-only consumer has been implemented in `local/ci-pr-evidence.js` and the `WatchtowerClient` requests. Existing 1.0 envelope remains unchanged.

- Once the Watchtower/GitHub target pair is configured and both current observations are fresh, Autopilot loads PR-scoped Runs from the Watchtower bridge. It then re-reads the most recent `general` and `integration` Run by exact repository/Run ID/attempt/**Run SHA**/PR number. The list has `completeCoverage=false`; absent integration is NOT_OBSERVED, not proof it passed.
- For general CI, Run SHA must match PR HEAD SHA. For the separately dispatched MyeongHa integration workflow, **integrationCandidateHeadSha** must match PR HEAD SHA, while the workflow Run's own `headSha` may be different. They are not interchangeable.
- A Project-wide integration CI may have no Work Track. A contradictory claimed Work Track is not silently accepted.
- Integration RUNNING/QUEUED is PENDING. A verified failed linked Run is RED (diagnostic, not permission to send repairs). Integration SUCCESS with missing pinned `integrationCandidateBaseSha`/baseline confirmation is **UNKNOWN** (not GREEN). Even a later bridge-provided baseline confirmation would still require independent GitHub corroboration before automatic progression. The existing exact-Run/PR merge approval gate remains separate.
- `CiPrEvidenceObserver` never calls a GitHub mutation, never submits a ChatGPT prompt, and never issues an SMS. It refreshes with normal Watchtower/GitHub observation cycles.
- Legacy Watchtower bridge deployments without the new `ciKind`/PR identity fields report unsupported/unavailable evidence. No optimistic compatibility mode is used for the integration stage.
- New per-check labels on the Activity tab explain the difference between normal and integration check outcomes and show both the workflow Run SHA and PR candidate SHA.

**Remaining integration dependency:** Watchtower PR #66 documents `integrationCandidateBaseSha=null` and `integrationBaselineVerified=false` because the pinned admission baseline is not yet observed. The local Autopilot cannot safely equate an integration success with full integration acceptance without this proof plus independent GitHub verification. The producer or verified GitHub admission trail must expose the pinned baseline before this can become automatically GREEN. This is an intentionally blocking safety check, not a test failure.

The local GH CLI requirement and production deployment restrictions described above remain unchanged.

## Historical cancelled CI → newer effective Run (W-01 / A-01)

Producer contract under review: [CI-Watchtower #68](https://github.com/gycha0109-beep/CI-Watchtower/pull/68), stacked on #67/#66. The fields `historicalDisposition` and `supersededByRunId` are **historical annotations** on PR-scoped Run lists; the original cancellation, Run ID/Attempt, and `ciState` never change. In an exact single-Run lookup the producer intentionally does not assert full lineage.

Autopilot's `CiPrEvidenceObserver` now includes bounded advisory `ancillary` observations for `other` workflow kinds that have an observed cancelled Run. A typical example is Saju PIE (which is not a `general` or `integration` workflow). For each such workflow:

- Require the same **repository + PR + current candidate HEAD SHA + workflow ID/path**; do not group only by a check name, Work Track, or display title.
- Re-fetch the latest selected Run with exact Run ID, latest Attempt, actual Run SHA and PR. Changed identity, unavailable bridge, missing proof, or stale observations are **UNKNOWN**.
- Recognize a prior cancellation as `SUPERSEDED` only if WatchTower explicitly links it to the exact newer selected Run. An older success never cancels a newer failure/cancellation.
- Preserve `safeToAdvance=false`. `ancillary` is informational and never changes the existing general/integration phase gate or GitHub independent required-check/review/merge/approval policy. A displayed `GREEN (observed)` means **that specific workflow Run** succeeded, not PR-wide GREEN.
- Limit additional exact ancillary Run queries to 8 workflows per refresh; mark truncation rather than assuming complete coverage. Render ancillary history on the Activity page only from fresh PR-scoped observations.

Observed regression [Saju PR #2704](https://github.com/gycha0109-beep/Saju/pull/2704): historical cancelled PIE Run `39906779844` and later successful Run `39906837903`, both on HEAD `406dcf68d0c79c15c6da6495233534b4377d4f30`. Historical GitHub X remains; it does not imply the newest PIE failed. The exact trigger of the cancellation is not independently confirmed.

**Deployment status:** Both producer #68 and consumer A-01 are unmerged. Real Windows installed-app/Credential Manager and live PR acceptance remain pending; the synthetic regression does not constitute live acceptance.

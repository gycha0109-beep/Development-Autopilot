# Development Autopilot — Master Roadmap

> Status: Planning / Iterative discovery
> Last updated: 2026-10-12 (Asia/Seoul)
> Target: Windows local-first developer operations tool
> Principle: **Build a thin vertical slice first; evolve implementation details from measured results.**
>
> This document is the top-level roadmap, not a claim that features have been implemented.

## 1. Product vision

Development Autopilot coordinates multiple ongoing software-development workstreams so the operator does not need to repeatedly issue routine commands such as "continue", check every CI run, manually reconstruct context after a long conversation, or write the same handoff instructions.

Desired operator journey:
1. Turn on the computer and open the registered development sessions.
2. See projects, workstreams, and their current execution or waiting state in one place.
3. Let approved work continue within clearly bounded scopes.
4. Validate actual repository / PR / CI state before treating a step as complete.
5. Persist roadmap and handoff state outside ephemeral AI conversations.
6. Receive a notification when a human decision is required.
7. Resume safely after browser, desktop app, or computer restarts.

**North star:** Complete one approved, bounded development phase — execution, verification, CI observation, and handoff — with no repetitive manual follow-up commands, while preserving hard human-approval boundaries.

**Not a guarantee:** Unattended, unlimited, 24/7 development. AI-execution availability, service terms, rate limits, GitHub permissions, code quality, and user decisions constrain operation.

## 2. Agreed high-level architecture

```text
                  +-------------------------------------------+
                  |   Development Autopilot (Windows local)   |
                  | dashboard / policy / scheduler / history  |
                  +-------------------------------------------+
                         |          |              |
              +----------+          |              +----------------+
              v                     v                               v
       Chrome MV3 extension    Orchestration core               Work memory
       tab/group inventory     task/state machine               docs/ + SQLite
       browser session hints   retry / decision gates           roadmap / handoff
              |                     |
              |                     +------ Execution adapter(s)
              |                               authorized AI/runtime
              |
              +-------- Read-only Watchtower bridge
                         Project / Track / repo / run evidence
                                      |
                                      v
                                 GitHub PR / CI
```

Responsibilities:
- **Chrome extension:** Find and select user-authorized Chrome tab groups and tabs; expose safe session inventory and applicable UI signals. Not the source of truth for code completion.
- **Local orchestrator:** Per-workstream scheduling, policy evaluation, persistence, replay protection, notifications, and human intervention.
- **CI Watchtower adapter:** Consume existing CI Watchtower observations. Do not duplicate its workflow classification/Track attribution logic.
- **GitHub verifier:** Check exact PR, commit SHA, required checks, merged state, and documentation changes where permission and access allow.
- **Execution adapter:** Replaceable integration for a supported, authorized code-execution/AI environment. The UI of a consumer web app must not be treated as an unlimited unattended execution API.
- **Durable work memory:** Repository files describe goals and work; local SQLite describes scheduler/runtime state and audit history.

Detailed boundaries are in [ARCHITECTURE.md](ARCHITECTURE.md). Operating/safety rules are in [OPERATING-POLICY.md](OPERATING-POLICY.md).

## 3. Product scope

### In scope
- User-selected Chrome tab-group discovery and session registration.
- Project / workstream / tab mappings, with stable identity beyond session-local tab IDs.
- Per-workstream cadence (initial idea: 35 minutes), pause/resume and manual override.
- State categories: READY, RUNNING, WAIT_EXTERNAL, WAIT_HUMAN, BLOCKED, COMPLETE, UNKNOWN.
- Read-only CI Watchtower integration and independent GitHub fact verification.
- Task/roadmap phase tracking, next-step recommendation and governed transition.
- Repository documents for roadmap, current state and session handoff.
- Human-approval gates, Windows notifications, logs, restart recovery and kill switch.
- Testable, pluggable execution integration using permitted access methods.

### Out of scope for early releases
- Arbitrarily expanding project scope or generating infinite new phases.
- Silently merging code, deploying production, deleting data, editing credentials or authorizing spending.
- Defeating provider rate limits, extracting protected consumer UI content, or relying on unsupported ChatGPT-web automation as a guaranteed product pathway.
- Replacing CI Watchtower’s responsibility/attribution/registry system.
- Multi-user SaaS, remote fleet management, hosted sync, mobile app.
- Autonomous resolution of ambiguous legal, financial or irreversible decisions.

## 4. Phased delivery

Phases represent dependency order, **not fixed calendar estimates**. Design choices marked *provisional* must be validated in the implementing phase.

### Phase 0 — Repository foundation & engineering contract
**Goal:** Make the project executable and change-safe without overdesigning.

Tasks:
- [ ] Define package/workspace layout and minimum supported Windows/Chrome versions.
- [ ] Select TypeScript tooling and test runner; set lint/typecheck/test/build scripts.
- [ ] Establish docs index, lightweight ADR log, issue/PR templates and CI checks.
- [ ] Define extension minimum permissions and explicit opt-in UX.
- [ ] Establish change discipline: small PR, observable behavior, regression test, handoff note.

Acceptance:
- One clean bootstrap build and CI run.
- A new contributor can locate roadmap, architecture and run/test commands.
- No privileged browser or GitHub operations run by default.

Artifacts: repository skeleton, README, CI pipeline, versioned decisions.

### Phase 1 — Chrome tab-group inventory & operator dashboard (MVP-A)
**Goal:** Show which development sessions exist. No automated message submission.

Tasks:
- [ ] Build a Manifest V3 Chrome extension with tabGroups/tabs/storage APIs.
- [ ] Detect creation, movement, renaming and closure of groups/tabs.
- [ ] Explicitly select monitored group(s), and enroll individual tabs separately.
- [ ] Show title, URL origin, group, connection/last-seen and permission status.
- [ ] Handle Chrome restart, group ID changes, duplicate URLs and multiple windows.
- [ ] Establish a versioned extension-to-local-host transport prototype (choose after validation).
- [ ] Build compact Windows dashboard or a temporary localhost dashboard.

Acceptance:
- Correct inventory of multiple tab groups and 10+ tabs.
- Closing/reopening Chrome cannot silently reassign a tab to the wrong project.
- Non-enrolled tabs are never inspected or operated on.
- Browser activity is not interrupted by routine inventory refresh.
- No chat content is read and no content is submitted in this phase.

Artifacts: extension prototype, dashboard, persisted enrollment map, UI test fixtures.

### Phase 2 — Durable local scheduler & state engine (MVP-B)
**Goal:** Manage autonomous *decisions* robustly, independently of any AI provider.

Tasks:
- [ ] Model Project → Workstream → Session mappings.
- [ ] Implement per-workstream next-eligible-at and configurable cadence (default proposal: 35m).
- [ ] Persist state transitions and monotonic operation IDs in SQLite.
- [ ] Implement idempotency keys, lease/lock and duplicate-job rejection.
- [ ] Detect RUNNING/WAIT_HUMAN/UNKNOWN using local simulation and approved signals.
- [ ] Add global emergency stop, per-project pause, per-session pause, resume guard and notification.
- [ ] Recover safely from power loss, app restart and stale operations.

Acceptance:
- No duplicate action after restart or repeated alarms.
- Unknown/ambiguous state does not execute.
- A blocked workstream does not block unrelated workstreams.
- Manual input/session activity does not get overwritten.
- All transitions have timestamp, reason and evidence source.

Artifacts: state machine, local DB migration, scheduler, state dashboard, fault-injection tests.

### Phase 3 — Watchtower/GitHub evidence bridge (MVP-C)
**Goal:** Know whether *the exact associated development work* is still in CI or actually finished.

Tasks:
- [ ] Inspect CI Watchtower’s existing Rust/Tauri interfaces and local data contract.
- [ ] Implement a **read-only**, versioned bridge (localhost loopback API or approved IPC; choose after inspection).
- [ ] Map Autopilot workstream to Watchtower Project/Repository/Track canonical keys.
- [ ] Associate exact PR number, head/merge commit SHA, workflow run ID and run attempt when available.
- [ ] Distinguish PR merged, required checks passed, jobs still running/queued, failed, stale and unlinked.
- [ ] Preserve Watchtower responsibility semantics: Project-wide vs Track-owned vs dynamic; do not infer Track from superficial CI names.
- [ ] Introduce freshness, evidence timestamps and explicit source-unavailable handling.
- [ ] Add focused recheck on CI state changes without repeated model calls.

Acceptance:
- A queued CI run causes WAIT_EXTERNAL rather than unnecessary "continue".
- A *different* Track’s successful CI does not unblock the current workstream.
- Old successful runs cannot overwrite a newer failure.
- Unknown, stale or conflicting run attribution fails closed.
- No changes are made to Watchtower’s existing registry or CI responsibility rules.

Artifacts: Watchtower adapter, contract tests, evidence matching tests, read-only status view.

### Phase 4 — Authorized execution adapter & bounded continuation
**Goal:** Safely issue the *next permitted* development action when evidence and policy allow it.

Tasks:
- [ ] Define ExecutionAdapter contract: capabilities, submit, status, cancel, result, context pointer.
- [ ] Prototype against a local mock executor first, then a supported/authorized coding runtime.
- [ ] Separate operator-approved work plan from generated next-step suggestion.
- [ ] Implement bounded retry/backoff, concurrency caps, budget/usage caps and provider-unavailable state.
- [ ] Support configurable continuation templates per workstream (e.g. "continue", analyze CI failure).
- [ ] Require actual completion evidence before any next-step submission.
- [ ] Explicitly verify provider terms/permissions; do not ship unattended ChatGPT consumer-web submission as a presumed supported adapter.

Acceptance:
- One approved task can be dispatched, observed, checked, and reconciled end-to-end.
- Idempotency and stale-context protection hold across restarts.
- Failure/approval/usage limits stop work or wait safely.
- Adapter replacement does not modify scheduler, Watchtower or roadmap layers.

Artifacts: adapter interface, mock/real authorized adapter, capability matrix, execution audit.

### Phase 5 — Roadmap-aware phase transitions
**Goal:** Advance along bounded, repository-backed work plans.

Tasks:
- [ ] Define human-readable roadmap + machine-readable task-state schema.
- [ ] Track goal, phase, task IDs, dependencies, completion checks and related PRs.
- [ ] Verify phase closeout from tests, linked PR/commit, required CI and acceptance criteria.
- [ ] Draft successor phase only within user-approved product goal/scope.
- [ ] Save proposed roadmap changes to a branch/PR by default; apply only by configured approval policy.
- [ ] Prevent endless scope expansion and redundant phase generation.
- [ ] Track decisions, rejected alternatives and residual risks in docs.

Acceptance:
- No successor work starts on unverified completion.
- Unnecessary feature generation stops at a defined goal or budget.
- Roadmap revisions are diffable, attributable, reversible and auditable.
- A new human approval request cannot be auto-resolved by the same generated model text.

Artifacts: roadmap parser/schema, phase gate, proposed-doc-PR workflow.

### Phase 6 — Long-session handoff & session migration
**Goal:** Avoid depending on one indefinitely long AI chat.

Tasks:
- [ ] Write/update ROADMAP.md, CURRENT_STATE.md, HANDOFF.md and TASK_STATE.json (in target repositories or designated locations).
- [ ] Persist branch, PR, commit SHA, failing tests, last verified step, blockers and next action.
- [ ] Trigger handoff proactively by operator-defined message count/task count or provider-supported context signal.
- [ ] Launch a fresh session only using an authorized session-creation mechanism.
- [ ] Restore from docs and independently revalidate GitHub before resuming.
- [ ] Verify continuity without copying unrelated personal chat history or credentials.
- [ ] Halt and ask for operator help when a new session cannot be created or the context cannot be verified.

Acceptance:
- A second session can resume a simulated multi-step workstream without duplicate PR or task.
- Handoff includes source references and evidence freshness.
- State mismatch or missing docs halts rather than guessing.
- Migration is not presented as a guaranteed ability to programmatically create ChatGPT consumer conversations.

Artifacts: handoff format, migration interface, replay tests, recovery UI.

### Phase 7 — Human intervention, reliability & observability
**Goal:** Make extended operation understandable, interruptible and recoverable.

Tasks:
- [ ] Tray notifications with deep link to exact project/workstream and reason.
- [ ] Approval queue with explicit operator intent and expiry.
- [ ] Reason-coded event log, filterable by project, task and PR.
- [ ] Throttling and protection against infinite retries/CI thrash.
- [ ] Audit sensitive actions and enforce principle of least privilege.
- [ ] Add local export/backup/restore and retention policies.
- [ ] Measure false continuation, duplicate submit, stale evidence and intervention latency.

Acceptance:
- User can stop all queued work immediately.
- A human-required state cannot advance without explicit applicable approval.
- No secrets are written to telemetry or repository docs.
- Restart and failure drills pass.

Artifacts: tray UX, approval inbox, diagnostics, reliability report.

### Phase 8 — Controlled long-run pilot & distribution
**Goal:** Validate multiple simultaneous workstreams under realistic usage.

Tasks:
- [ ] 1 workstream dry-run → 3 workstreams → 10+ sessions test.
- [ ] Test browser crash, app crash, offline GitHub, stale Watchtower and approval delays.
- [ ] Validate installer, startup setting, extension install instructions and upgrades.
- [ ] Review real provider usage rules and supported execution routes before enabling unattended action.
- [ ] Publish a release checklist and clearly documented feature limitations.

Acceptance:
- Pilot meets defined safety metrics rather than an hours-running vanity metric.
- Zero unauthorized approvals; zero duplicate irreversible actions.
- Reproducible installation and rollback on supported Windows host.
- Any unsupported/unverified adapter is clearly labeled disabled/experimental.

Artifacts: beta installer, release checklist, test report, operator guide.

## 5. Milestone definitions

| Milestone | Phases | Evidence of success |
|---|---|---|
| M0 — Governed skeleton | 0 | Build + CI + documented constraints |
| M1 — Session inventory | 1 | Chrome group discovery and durable enrollment |
| M2 — Reliable control plane | 2 | State transitions + timers + kill switch + restart recovery |
| M3 — CI-aware decisions | 3 | Exact run/PR evidence prevents false continuation |
| M4 — One verified development cycle | 4–5 | Bounded execution → verify → next approved task |
| M5 — Context-independent continuation | 6 | Correct new-session handoff |
| M6 — Operational beta | 7–8 | Multi-workstream fault-tolerant pilot |

## 6. Non-negotiable decision gates

- **Fail closed:** Missing, stale, conflicting or ambiguous evidence ⇒ WAIT_HUMAN/UNKNOWN, never speculative execution.
- **Approval boundary:** Merges, deployments, data loss, secret/permission changes, purchases and major architecture/product changes require explicit policy; default is human approval.
- **Project scope:** A new plan may only elaborate existing approved goals. Product pivots require a human.
- **No provider-bypass:** Respect service terms, account access, limits and automation restrictions. Paid/API-free is not equivalent to permission to automate a consumer UI.
- **Source of truth:** Docs record goals/intent, GitHub records code/PR state, Watchtower records CI attribution/status, local DB records orchestration events. Chat output is evidence to verify, not sole authority.
- **No silent action:** Each automated step must have an operation ID, linked workstream, timestamp, input policy and observable outcome.

## 7. Open decisions (resolve when implementation makes them necessary)

1. Tauri 2 vs alternative Windows shell, based on packaging and Watchtower IPC reuse.
2. Extension ↔ desktop transport: native messaging, loopback HTTP/WebSocket with authentication, or other supported transport.
3. Reliable session identity across duplicate URLs, reopened Chrome windows and new chats.
4. Supported AI execution runtime and its billing/usage model.
5. The minimum structured output contract that an AI agent can reliably produce.
6. Roadmap file naming/ownership policy per downstream repository.
7. When proposed documentation/PR merges may be auto-approved.
8. Extent of browser content access; minimum permissions and privacy review.
9. Automated phase-boundary detection independent of model-generated claims.
10. Pilot project and quantitative false-positive/false-negative thresholds.

Record major decisions in [DECISIONS.md](DECISIONS.md), not by silently rewriting past assumptions.

## 8. Next actionable slice

**Start with Phase 0 → Phase 1.** Deliver a locally loadable Chrome MV3 extension that lists opted-in groups/tabs and a small dashboard that persists mappings, **without sending any prompts**. Establish fixture-based browser tests, then add state scheduling and Watchtower evidence before enabling any external execution.

## 9. Maintenance rules

- Update this roadmap only when delivery scope or phase boundaries change.
- Track specific implementation tasks in Issues/PRs, rather than expanding this file into a daily activity log.
- Every completed phase records: purpose, changed files, validation evidence, remaining risk and next decision.
- Mark planned vs implemented vs verified distinctly.
- End work only with a supported status: completed / blocked / needs human approval / needs external evidence.

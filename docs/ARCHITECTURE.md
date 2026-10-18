# System Architecture (evolving design)

> Architecture baseline / not yet implemented. Date: 2026-10-12.
> [Master roadmap](ROADMAP.md) · [Operating policy](OPERATING-POLICY.md) · [Validation](VALIDATION.md)
>
> We favor separate responsibilities and replaceable adapters. Do not commit to transport, DB internals, or browser inspection strategy until a working vertical slice demonstrates the trade-offs.

## 1. Components & boundaries

```text
    Chrome session                          Windows local machine
┌──────────────────────┐       ┌────────────────────────────────────────┐
│ MV3 Chrome extension │       │ Development Autopilot                  │
│ - selected tab groups│  IPC  │ - desktop UI / tray                    │
│ - tab inventory      ├───────┤ - state engine + per-workstream queue  │
│ - explicit opt-in    │       │ - audit / SQLite / policy              │
│ - permission signals │       │ - notifications + approvals            │
└──────────────────────┘       └───────────────┬────────────────────────┘
                                               │ versioned adapters
                     ┌─────────────────────────┼───────────────────────┐
                     v                         v                       v
              ┌──────────────┐         ┌────────────────┐      ┌─────────────────┐
              │ CI Watchtower│         │ GitHub verifier│      │ Execution       │
              │ read-only    │         │ exact PR / SHA │      │ adapter         │
              │ status bridge│         │ required checks│      │ permitted tools │
              └──────────────┘         └────────────────┘      └─────────────────┘
                     │                         │                       │
                     └───────────┬─────────────┴───────────────────────┘
                                 v
                      Repository working memory
                 roadmap / status / handoff / task metadata
```

### Chrome extension (Manifest V3)
- Request only the minimum tabGroup/tabs/storage permissions and scope-specific host permissions.
- Use `chrome.tabGroups` and `chrome.tabs` to find user-selected groups and tabs. Tab-group IDs are browser-session-scoped; they are not permanent project keys.
- MV3 service workers are event-driven and can be suspended; persist intent and use supported event/alarm mechanisms rather than an immortal in-memory interval.
- Group/tab list discovery can work with tab metadata without reading whole chat content.
- Any page-specific inspection requires separate host permission, documented purpose, and a provider-appropriate authorization review.
- Extension is **not** the canonical scheduler, durable job store or source of CI truth.

### Local orchestrator
- Stores approved enrollment, project/workstream identity, next eligible time, lease, previous operations and approval state.
- Evaluates policies and dispatches via a replaceable execution adapter.
- Owns notifications, audit, global stop, project pause, tab pause and restart reconciliation.
- **Target (not implemented):** independently schedule each opted-in session's observation tick, interpret provider-permitted observation signals, run one state-driven action decision per workstream, and apply global concurrency/rate budgets.
- **Target:** persist CI reinspection deadline, disconnect-recovery phase, last confirmed answer fingerprint, latest verified dispatch and one-use notification/remote-command state. Extension popup text is never canonical long-term state.
- Defaults to **no execution adapter enabled**.
- Initial desktop-shell candidate is Tauri 2 because CI Watchtower is Tauri/Rust; keep this provisional until an integration spike.

### Observation/classification adapter (proposed; capability and permissions gated)
- [WP-04 A disconnect stages](WP-04-DISCONNECT.md) reuse existing operations/events with a local recovery checkpoint. Stop/report writers and independent provenance checks are injected fakes only; no live control selector or coordinator activation has been added.
- WP-03's [conditional coordinator](WP-03-SCHEDULING.md) connects the staged decision/ledger to existing ChatContinuation via queue/claim guards and independent SQLite inspection/CI clocks. It has injected test adapters, no default live page reader or operational server activation. Unmanaged preexisting campaigns are not silently enrolled.
- WP-02 adds the [single-action decision and local response-consumption ledger](WP-02-DECISION.md), reusing `decideGate()` and `WorkstreamStore`. It remains unconnected to the operational worker/scheduler; WP-03 will connect existing command claim/ACK behind this ledger.
- WP-01 now has an **offline, unconnected implementation slice**: `extension/chat-observer.js` collects a minimal DOM projection, and `local/chat-observation.js` binds one registered tab and classifies snapshots. [Contract and limitations](WP-01-OBSERVATION.md). The worker, scheduler, SQLite and dispatch path do not call it yet; the state-driven operating loop below remains a target.
- Report a **structured observation** tied to exact registered session, URL/project, observation time and source type: assistant response active/complete, length-warning shown, disconnect-warning shown, stop button available, composer draft present, human-intervention cue, CI-wait cue or UNKNOWN.
- Page/assistant text is untrusted **classification input**, not authorization or proof that a GitHub operation completed. Detecting "CI running" only triggers the relevant exact Watchtower/PR lookup.
- Normalize provider/UI-specific selectors in replaceable adapters and use bounded inspection; do not retain entire conversations by default. Unsupported provider extraction, ambiguous DOM, user draft, or unpermitted automation means UNKNOWN/WAIT_HUMAN.
- Keep the **observation timer** distinct from the **prompt-dispatch due time** so periodic checks do not become timed unconditional sends.

### Remote operator notifier/command gateway (proposed)
- Local Inbox is the source of truth for exceptional requests. A Telegram (or other supported messenger) adapter may deliver deduplicated status/approval-required alerts and accept authenticated `status / hold / resume / approve / reject` commands.
- Verify sender, target workstream, exact action fingerprint, expiry, nonce and current permission/CI state before applying anything. Offline delivery or missing response is never consent.
- Do not couple the scheduler to the availability of Telegram/KakaoTalk; messenger outages cannot stop unrelated preapproved development sessions.

### Watchtower bridge
- The existing CI Watchtower repository documents a Project → Track → Repository registry, Project-wide vs Track-owned workflow distinction, run/attempt tracking and polling.
- Its documented default polling as inspected on 2026-10-12 was 25s active / 90s idle. Autopilot should consume its timestamps instead of duplicating the same poll loop.
- Watchtower's built-in resolver remains authoritative for *its* CI attribution; Autopilot only maps already-established workstream identities to that information.
- A stable external read API has **not yet been verified**. First inspect existing app commands/storage, then implement an explicitly versioned read-only local interface if needed.
- Do not access or mutate Watchtower's SQLite tables directly without a deliberate compatibility contract. Never write its project registry or responsibility rules.

### GitHub verifier
- PR is linked by repository ID/full name and PR number; exact commit SHA guards against stale CI evidence.
- Merge state, required checks, review constraints and current branch head are separate facts.
- "Some CI passed" is not proof that a particular PR is ready/merged.
- Watchtower may report project-wide or dynamic runs; never arbitrarily attach them to a workstream.
- Rate limiting, stale responses, authorization errors or partial coverage ⇒ evidence unavailable, not success.

### Execution adapter
Proposed interface (contract sketch, not final TypeScript):
```ts
interface ExecutionAdapter {
  capabilities(): Promise<CapabilityReport>;
  submit(command: ApprovedCommand, idempotencyKey: string): Promise<ExecutionHandle>;
  status(handle: ExecutionHandle): Promise<ExecutionSnapshot>;
  cancel(handle: ExecutionHandle): Promise<CancelOutcome>;
}
```
- Only authorized, supported execution routes may be enabled.
- A local fixture/mock is the default adapter for state-engine tests.
- If a code agent needs a filesystem, PR rights or shell, those permissions are supplied and scoped by the execution environment, not conjured by the Chrome extension.
- Consumer ChatGPT web-page auto-submission is not a guaranteed/supported API and must remain a blocked/unapproved integration candidate unless independently authorized and reviewed for terms compliance.
- Adapter failures cannot create an implicit retry storm or bypass a user approval.

## 2. Identity and mappings

```text
Project ID (Autopilot, stable)
  └─ Workstream ID (Autopilot, stable)
      ├─ Repository full name + internal repo ID
      ├─ Watchtower Project / Track canonical key [optional]
      ├─ Chrome session enrollment(s) [optional]
      ├─ Current Task ID / phase
      ├─ Exact PR ID / head SHA / run ID + attempt [when known]
      └─ Execution adapter / handle [when active]
```

Important constraints:
- A Chrome tab ID, group ID, title or URL alone is **not** a workstream identity.
- Two tabs can have the same URL. A tab may move groups or be replaced after a browser restart.
- Rebind an ambiguous replacement tab only after operator confirmation.
- One PR may have multiple CI runs; one workstream may have multiple PRs. Store explicit links with creation timestamps.
- A Project-wide CI can be a gate for several tracks, but its attribution is not reassigned to a particular track.

## 3. State machine

```text
   DISABLED
       | operator enroll + enable
       v
   OBSERVING ------------------------------┐
       | eligible, fresh evidence, policy  |
       v                                   |
   READY -> DISPATCHING -> RUNNING         |
                |              |           |
                |              +--> WAIT_EXTERNAL --[fresh event]--+
                |              +--> VERIFYING ---------------------+
                |              +--> WAIT_HUMAN --[approval]-------+
                |              +--> BLOCKED                        |
                |              +--> COMPLETE                       |
                |                                               v  |
                +--- ambiguity / failure ---------------> OBSERVING |
                                                                 |
   PAUSED <--------- manual pause / global stop -----------------+
```

Canonical states (initial proposal):
- `DISABLED`: not enrolled or not enabled.
- `OBSERVING`: collecting safe, opted-in metadata/evidence; no action due.
- `READY`: due and passed **all** execution gates.
- `DISPATCHING`: operation lease acquired, adapter submission in progress.
- `RUNNING`: execution acknowledged.
- `WAIT_EXTERNAL`: waiting on mapped CI/PR or supported external prerequisite, with persisted exact evidence refs and a reinspection timer.
- `VERIFYING`: gathering evidence for output/merge/acceptance.
- `WAIT_HUMAN`: explicit approval, login, scope clarification, missing permission.
- `BLOCKED`: failure, repeated retry exhaustion, provider restrictions or incompatible state.
- `COMPLETE`: task/phase complete as supported by required evidence.
- `PAUSED`: operator-controlled stop.

On restart, `DISPATCHING` and `RUNNING` must be **reconciled** using idempotency key/handle and evidence, never blindly re-sent.

### Derived decisions
- `CONTINUE`: confirmed completed assistant response + approved scope + eligible + no conflicting external gate or unreconciled send + authorized adapter.
- `WAIT_CI`: exact linked run is queued/pending/running; arm watch/recheck schedule and do not dispatch another ChatGPT follow-up.
- `ANALYZE_FAILURE`: linked required check failed; requires an approved error-analysis scope.
- `HANDOFF`: supported session transition needed, checkpoint complete.
- `PROPOSE_PHASE`: verified phase closeout and approved roadmap goal; proposal only by default.
- `RECOVER_DISCONNECT`: repeatable UI warning and uniquely verifiable stop control; persist stop → report → resume as separate, at-most-once steps with cooldown and attempt cap.
- `CALL_OPERATOR`: missing approval, local Windows testing, costs, unclear evidence, auth issue, policy conflict, or repeated recovery failure; deliver through local Inbox/authorized messenger.

Never infer `CONTINUE` merely because the assistant text says "done" or the previous message contains a convenient marker.

## 4. Scheduling and concurrency

- Each workstream owns separate **inspection eligibility** and **message dispatch eligibility** clocks. The former initial `minIntervalMinutes = 35` suggestion must not become a hard-coded prompt timer.
- Scheduler events mean **inspect eligibility**, not "unconditionally send a prompt".
- Store `lastDispatchedAt`, `nextEligibleAt`, `lastObservedAt` and active operation ID.
- Signal-driven Watchtower changes can immediately update evidence state. They do not bypass the normal due/approval gate unless the operator explicitly configures that policy.
- Serial dispatch **per workstream**; bounded concurrency **across workstreams** (target pilot 1 → 3 → 10 → 20 registered tabs). Apply global/per-provider rate budgets, round-robin fairness, jittered backoff, and independently paused CI/recovery timers.
- A workstream in `WAIT_HUMAN` does not lock unrelated workstreams.
- On wake/resume after PC sleep, reconcile elapsed periods; do not replay missed slots in bulk.

## 5. Persisted records (logical schema; provisional)

| Table / aggregate | Minimal fields |
|---|---|
| `projects` | stable ID, name, goal, scope, policy ID |
| `workstreams` | stable ID, project ID, repository, Watchtower mapping, status |
| `sessions` | session ID, workstream ID, provider, URL/origin, enrollment status, last seen |
| `schedule` | workstream ID, inspect interval/next inspection, dispatch eligibility, pause, concurrency and throttle policy |
| `tasks` | task ID, phase, acceptance, commit/PR refs, lifecycle |
| `operations` | unique operation ID, idempotency key, lease, adapter handle, result |
| `evidence` | source, refs, observed-at, fresh-until, checksums, verification outcome |
| `approvals` | exact proposed action hash, scope, expiry, operator, decision |
| `events` | append-only timestamp, actor, reason code, related ID |
| `observations` *(proposed)* | workstream/session, source/capabilities, state classification, timestamp, stable response fingerprint, reason, freshness |
| `waits` *(proposed)* | workstream, external PR/SHA/run/attempt, next Watchtower inspection, deadline, reason, attempts |
| `recoveries` *(proposed)* | workstream, stage: suspected/stop intent/stop confirmed/status request/status confirmed/eligible, retries, cooldown, operation ID |
| `operator_requests` *(proposed)* | workstream, kind, hashed action target, authentication/expiry, local Inbox state, delivery attempt/ack, operator decision |

Schema migrations are forward-only and backward compatibility is explicit. Never use URLs or tab IDs as primary keys.

## 6. Local integration contract (provisional)

```json
{
  "contractVersion": "1",
  "workstreamId": "my-workstream-id",
  "repository": "owner/repo",
  "watchtower": {
    "projectId": "stable-project-id",
    "trackKey": "canonical-track-key"
  },
  "target": {
    "prNumber": 123,
    "headSha": "verified-commit-sha",
    "runId": 456,
    "runAttempt": 1
  },
  "evidence": {
    "observedAt": "2026-10-12T00:00:00Z",
    "fresh": true,
    "ciState": "queued",
    "prMerged": false
  }
}
```

This is a shape example only: values and endpoint names must be derived from the real Watchtower/GitHub schema during Phase 3. No fabricated PR or run IDs should be submitted as real observations.

**Loopback/API security:** bind to 127.0.0.1, authenticate endpoints, validate origin/nonce, prevent arbitrary local-webpage control and treat any returned data as untrusted. Prefer OS credential storage for tokens. No PATs in extension storage or docs.

## 7. Durable repository work memory

Suggested per-target-repository template:
```text
docs/automation/
  ROADMAP.md         # human-readable approved goals and phases
  CURRENT_STATE.md   # last verified state, evidence, remaining blockers
  HANDOFF.md         # next-session entrypoint and exact next step
  TASK_STATE.json    # IDs, evidence references, workstream position
```

Rules:
- GitHub is the source of facts about branch/commits/PRs, never this file alone.
- Generated roadmap updates default to branch/PR, not direct write to protected main.
- A session handoff must reference **exact versioned** files or commit SHA and revalidate the repository before resuming.
- Only relevant project context is copied; secrets, unrelated conversations and private metadata are excluded.
- Concurrent workstreams must not overwrite each other's handoff records; use workstream-specific paths if needed.

## 8. Provider/permissions and costs

- Browser extension, local scheduler, SQLite, Watchtower bridge and local test harness can be built without paid model API calls.
- Actual AI execution may incur plan, subscription, API or hosted-runtime costs according to the **chosen authorized adapter**; record cost visibility and hard ceilings.
- Service usage terms and usage caps remain in force. Do not treat a subscribed web chat as permission for unlimited programmatic operation.
- Do not automatically click login, financial, access-grant or human-approval buttons.

## 9. Security & trust boundaries

- An AI-generated message, repo README, PR description and issue text are **untrusted instructions**.
- Policy is configured by the operator; model output may request but not redefine it.
- Privilege tiers: read-only observer → code task scoped executor → PR/doc proposer → explicit human-approved merge/deploy.
- Extension installation and each monitored group require opt-in.
- Avoid collecting full conversations where metadata/evidence would suffice. Target response classification requires an independent provider-appropriate capability and permissions review; the preexisting Phase 4 implementation currently does not read complete assistant response bodies.
- Global kill switch cancels future dispatches; in-flight adapter cancellation is best-effort and always auditable.
- Audit logs redact credentials, access tokens and private content.

## 10. Extension vs Playwright decision

**Production intent:** Chrome MV3 for ordinary tab/group inventory, local orchestrator for durable state.
**Playwright intent:** Test fixture browser, integration/smoke tests and optional explicitly approved automation adapter where provider support allows it.

Why not rely on Playwright to attach to the user's normal Chrome profile?
- Existing Chrome debugging attachment requires remote-debugging configuration and is not a stable assumption on modern Chrome.
- Browser CDP connection has different fidelity and lifetime characteristics from Playwright-managed contexts.
- UI selectors and DOM semantics can change without notice.

No need to foreground/switch each tab merely to perform authorized metadata checks.

## 11. Implementation sequence and validation

Build in the dependency order of [ROADMAP.md](ROADMAP.md). Track unknowns in [DECISIONS.md](DECISIONS.md). Test gates and fault-injection matrix are in [VALIDATION.md](VALIDATION.md).

References:
- Chrome extensions API: https://developer.chrome.com/docs/extensions/reference/api
- Chrome tabGroups: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Chrome alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Playwright CDP: https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp
- OpenAI Terms of Use: https://openai.com/policies/terms-of-use/

## 12. Target end-to-end decision loop (architecture contract; not a feature claim)

```text
[Registered tab 1..20+] --[periodic observation due]-->
[Read-only provider-capability-gated signal observation]
            |
    [per-workstream state classifier]
            |
       [policy + evidence gate]----- [Watchtower / exact GitHub PR+SHA]
            |
   +--------+----------+------------+-------------+---------------+
   |                   |            |             |               |
NORMAL_COMPLETE   CI_WAIT     LENGTH_LIMIT   DISCONNECTED    HUMAN_ACTION
   |                   |            |             |               |
approved scoped      CI recheck    same-tab      bounded stop,   local Inbox
"계속 진행"            timer         handoff       status report,  / messenger
   |                   |            |             revalidation   |
   +--------+----------+------------+-------------+---------------+
            |
[one dispatch per workstream, durable lease, bounded global concurrency]
            |
[observe result → reconcile actual effects → schedule next observation]
```

The same input can be partly interpreted in several ways; a **safe gating precedence** is required. Hard stops and human approval win over every automatic branch; incomplete/uncertain operation blocks dispatch; only then may verified disconnect, length-limit, CI or normal-completion logic run. Inconsistent evidence moves to UNKNOWN instead of choosing a guessed button. Details and bounded disconnect stages are defined in [OPERATING-POLICY.md](OPERATING-POLICY.md).

A UI disconnect warning such as `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.` does not establish a provider rate-limit condition. The recovery adapter must independently verify the precise warning, the unique active stop-generation control, its action result and when the composer becomes available. Automated resume after status report remains subject to the same verified CI, approval and scope gates. Never retry an uncertain stop or send operation.

CI status phrases are only **lookup triggers**. Watchtower/GitHub remain authoritative for matching repository/track/PR/SHA/run/attempt and current required checks; observed queued/running schedules a CI-only recheck, not a new chat prompt. No Watchtower registry mutation.

Remote exceptions require a durable local approval request as well as optional messenger delivery; receiving a remote command is an input to the existing approval/policy gate, not direct execution. This design deliberately **does not add a paid AI API, switch execution adapters, or enable automatic sensitive actions**.

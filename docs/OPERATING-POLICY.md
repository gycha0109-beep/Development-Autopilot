# Operating Policy — Safety, Approval & Continuity

> Status: Proposed defaults to be validated in MVP.
> This is product operating policy, not an authorization to access a third-party service or repository.
>
> Related: [ROADMAP.md](ROADMAP.md) · [ARCHITECTURE.md](ARCHITECTURE.md) · [VALIDATION.md](VALIDATION.md)

## 1. Operating modes

| Mode | May do | Must not do |
|---|---|---|
| **Observe** (default) | Enroll selected tabs, inspect allowed metadata, summarize Watchtower/GitHub, notify | Submit prompts or write code |
| **Supervised** | Execute a bounded, explicitly approved task via an authorized adapter, run checks, propose docs/PR | Exceed approved scope or independently approve sensitive actions |
| **Extended** | Within approved project goals, propose and prepare subsequent roadmap phases and handoff | Indefinite goal expansion or policy self-modification |

Switching to a more permissive mode requires an explicit operator action; a model-generated instruction cannot enable it. Each project/workstream has its own mode. Global STOP overrides all modes.

## 2. Approval matrix — defaults

| Action class | Default decision |
|---|---|
| Inventory of enrolled tab/group metadata | Allow after enrollment |
| Read-only Watchtower/GitHub evidence | Allow after connector permission |
| Local simulated execution | Allow in test sandbox |
| Dispatch approved scoped coding task via authorized executor | Allow in Supervised/Extended |
| Update `docs/automation/CURRENT_STATE.md` on a branch | Allow within approved scope |
| Propose next roadmap in PR | Allow in Extended; not silently merge |
| Modify code inside approved branch/task scope | Executor-specific; require explicit authorization |
| Merge pull request / change branch protection | Ask operator unless separately reviewed scoped policy |
| Production deploy / migrate DB / delete data | Ask operator |
| Edit secrets, PAT, OAuth scopes, permissions, billing | Ask operator |
| Major product pivot, irreversible architecture choice | Ask operator |
| Resolve ambiguous CI attribution or missing evidence by guessing | Deny |
| Click through login, human confirmation or external payment UI | Deny |
| Bypass usage limits, automate extraction forbidden by provider terms | Deny |

**Policy precedence:** global emergency stop > provider access/terms > hard safety restrictions > project policy > workstream policy > AI suggestions. More permissive task text never overrides an upstream deny.

## 3. Decision pipeline

Every potential action passes these gates in order:
1. **Enrollment:** Exact workstream and session/executor registered?
2. **Authority:** Appropriate provider/service access permitted; no account or rate-limit bypass?
3. **Liveness:** Current task actually due; no active lease or conflicting operation?
4. **Observation & evidence:** Current response/rendering state sufficiently known to classify; required target PR/SHA/run/attempt mapped; data fresh and unambiguous?
5. **Approval:** Proposed action within approved scope and still authorized?
6. **Safety:** No waiting login, human review, in-progress manual entry, provider limitation or stop state?
7. **Dispatch:** Create immutable operation ID and idempotency key; acquire exclusive workstream lease.
8. **Reconcile:** Read actual outcome; do not equate a successful submission with task completion.

If any gate cannot answer decisively, **do not execute**. Record a reason code and schedule safe reinspection or operator review.

## 4. Wait vs failure semantics

- **WAIT_EXTERNAL:** Specific linked CI/PR is queued/running or a required external prerequisite is pending. The scheduler persists the next evidence inspection; resume eligibility check on fresh evidence, not on a chat text claim. No "continue" message merely to fill time.
- **WAIT_HUMAN:** Explicit approval/choice, login, missing rights, or unreconcilable session mapping. Operator action required.
- **BLOCKED:** Provider-denied operation, exhausted bounded retries, corrupted state or failed critical invariants.
- **UNKNOWN:** Observed state is incomplete, stale or contradictory. No execution until it becomes inspectable.
- **COMPLETE:** Only after required external evidence is verified.

For example, "병합 확인 중" in an AI report implies a reason to inspect the exact PR and CI; it is *not* evidence that the PR merged and it is not a trigger to send another prompt.

## 5. Operator interaction

### Approval request contents
- Project/workstream, target repository and exact PR/branch.
- Requested action and why it is needed.
- Evidence snapshot and timestamp.
- Potential impact and whether it is reversible.
- Options: approve this action / reject / keep paused.
- Approval expiry and a unique action fingerprint.

The operator must approve **the concrete action hash**. If target branch, SHA, diff or relevant conditions change before execution, the old approval expires. The local AI and Watchtower bridge cannot approve on the operator's behalf.

### Stop and resume
- STOP prevents *new* dispatch immediately, revokes pending local leases where safe and sends cancellation to an active execution adapter when supported.
- Since cancellation can fail, the app must show `cancellation_pending` until independently confirmed.
- Resume rechecks provider access, task freshness, branch head, CI, active operation and approval. Never replay missed intervals in a burst.

## 6. Duplicate and feedback-loop prevention

- Generate `operationId` before dispatch; persist it before external side effects.
- Deduplicate by workstream + task version + action kind + approved target fingerprint, not just by text.
- One active write/dispatch operation per workstream; independent monitoring/recheck timers and shared global concurrency and request-rate budgets across workstreams.
- Every automated retry has count, reason, backoff and hard maximum; approval-sensitive retries cannot self-approve.
- A failed CI should not trigger unlimited reruns or create new tasks without bounded policy.
- The UI should show the last **verified** action, not the last claimed model message.

## 7. Roadmap governance

Goal definition must include:
- What product/problem is being built.
- Approved scope, non-goals and stop conditions.
- Acceptance criteria for each phase.
- Maximum phase expansions or remaining budget/time if configured.
- Areas requiring human design/architecture sign-off.

When a phase is finished:
1. Compare GitHub PR/commit/tests/CI with explicit phase acceptance.
2. Write an evidence-backed closeout note.
3. Determine whether the approved goal has remaining meaningful work.
4. If yes, **propose** a bounded next phase and save a diffable docs PR.
5. Start next implementation only after the proposed phase becomes approved under project policy.
6. If no, mark goal COMPLETE and stop; do not invent work.

Reject plans that merely optimize vanity metrics, add unrelated scope or reopen settled decisions without evidence.

## 8. Handoff / context-loss policy

Treat conversations as disposable execution surfaces. Source of truth is repository code, PRs, CI evidence and versioned task docs.

### Before handoff, persist
- Approved product goal and roadmap revision.
- Workstream and current task ID; last completed acceptance item.
- Repository, branch, base/head SHA, PR number, related run IDs and attempts.
- Completed tests and failures with log references.
- Changes not yet committed; whether working tree is clean.
- Pending human decisions and conditions for safe resume.
- Exact next action and why it is safe.
- Last evidence timestamp and any stale/unverified parts.

### Handoff lifecycle
1. Freeze new task dispatch for that workstream.
2. Reconcile in-flight commands and capture state.
3. Create/update HANDOFF and CURRENT_STATE; commit to a safe branch or approved store.
4. Validate snapshot consistency against GitHub.
5. Open a new session only via a provider-supported, allowed mechanism.
6. Load only the necessary versioned handoff and revalidate external state.
7. Resume exactly once; on mismatch, enter WAIT_HUMAN.

If a consumer chat cannot be reliably reopened or a provider denies programmatic session control, stop with a clear recovery instruction rather than pretending migration succeeded.

## 9. Costs, privacy, credentials and compliance

- **Local components:** No model API required for extension, scheduler, DB, UI or Watchtower bridge.
- **Execution:** May require separate subscription/hosted compute/API charges; each authorized adapter reports its own limits.
- **No guarantee of free unattended AI coding:** ChatGPT web subscription does not by itself grant an automation API.
- **Terms:** OpenAI consumer Terms of Use restrict automated/programmatic extraction of Output and bypassing rate limits/restrictions. Do not ship those as assumed legal/technical product features. Recheck terms for any selected provider.
- **Secrets:** PATs and tokens stay in OS-backed secure storage. Never put secrets in repo docs, local telemetry, extension sync storage, screenshots or handoff text.
- **Privacy:** Inventory only opted-in tabs; redact message content unless demonstrably needed, properly authorized and approved.
- **Audit:** Record action, authorization basis, versioned target, evidence source and result. Support operator-controlled retention/purge.

## 10. Operator-facing health states

- **GREEN / Eligible:** fresh evidence, approved target and adapter available.
- **BLUE / Working:** one active operation.
- **AMBER / Waiting:** CI/PR or human intervention.
- **RED / Blocked:** action denied or a verifiable error.
- **GREY / Unknown:** stale/conflicting source or missing session mapping.

Colors are purely presentation: logs and rule IDs must explain the decision.

## 11. Operational success metrics

1. **Unauthorized sensitive actions:** 0.
2. **Duplicate externally executed actions:** 0.
3. **Wrong-Track PR/CI unblock:** 0.
4. **Ambiguous-state auto-dispatch:** 0.
5. **Handoff replay/double submission:** 0.
6. **Verified task throughput:** measured with evidence; never inferred from message counts.
7. **Human interventions:** count and classify; decreasing intervention count is meaningful only if safety metrics stay at zero violations.
8. **Resource usage:** operator-visible per provider/executor.

Policy defaults are intentionally conservative. Future relaxation needs documented evidence, an explicit decision record and regression coverage.

## 12. State-driven session inspection and conditional follow-up (target contract; not implemented)

A scheduled workstream tick is an **inspection event**, not a permission to click Send. The local scheduler retains workstream identity, current session/tab registration, observation fingerprint, last confirmed assistant-turn state, last send operation, recovery phase, current external gate and next inspection time. Provider-permitted signals must be observed through a replaceable adapter; a failed or unsupported page inspection never becomes an assumed "completed response".

At each tick, apply the following **conservative precedence**. This is an ordering for deciding which *gate* blocks execution, not an order to click all related controls:

1. **Hard stop / human approval / provider restriction:** global or individual PAUSE; money or permission approval; login; local Windows acceptance; unclear authority → WAIT_HUMAN/BLOCKED. A provider usage limit is not a recoverable connectivity error.
2. **Unfinished or uncertain action:** generation still active, ChatGPT is still composing a response, prior send ACK unknown, user is editing the composer or browser registration mismatches → RUNNING/UNKNOWN; no more input.
3. **Verified connection failure UI:** if the warning `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.` (or an independently verified equivalent) persists, enter bounded disconnect recovery; do not classify this as successful output or automatically ignore restrictions.
4. **Verified length-limit UI:** enter the existing source-authored handoff workflow; never send the last unfinished instruction again, open additional unrelated Chrome tabs or silently re-register a different session.
5. **CI/merge/pending-external cues:** when a response says CI is running or "checking CI after merge", resolve the exact linked workstream and read Watchtower/GitHub; cues only initiate a **read-only** lookup. WAIT_EXTERNAL requires fresh matching evidence; unknown linkage stays UNKNOWN.
6. **Stable assistant reply / verified normal completion:** only once the latest response is complete, unchanged/stable, belongs to the registered session, previous send is reconciled, no WAIT_CI/approval/error branch applies and the approved roadmap still has work, allow exactly one scoped `계속 진행`.
7. **Verified terminal goal complete:** mark COMPLETE and stop rather than continuously expanding the roadmap.

If two conditions materially conflict, or DOM provenance is insufficient, hold UNKNOWN/WAIT_HUMAN and request bounded reinspection. Do not turn every "assistant says done" into authorization or a GitHub completion signal.

### Disconnect recovery as a persisted mini-state-machine

`DISCONNECT_SUSPECTED → RECHECK_WARNING → STOP_REQUESTED → STOP_CONFIRMED → STATUS_REQUESTED → STATUS_CONFIRMED → CONTINUE_ELIGIBLE → NORMAL`

- Confirm the exact registered tab/project/URL and a continuing, visible disconnect warning; debounce transient rendering. A stop-shaped control alone is not enough.
- Click **the unique, verifiable stop-generation control** only while the error state is still present. Persist a one-shot intent before the click. Confirm generation stopped; if click result is uncertain, do **not** click again blindly.
- Ask for an approved, non-destructive current-work and remaining-work summary **once**, after the UI becomes ready, then wait for its completed reply.
- Reconcile GitHub/CI/approval gates again and send `계속 진행` once only when eligible. A report may disclose a cost/approval/CI wait and then the correct next action is WAIT_HUMAN/WAIT_EXTERNAL instead.
- Limit auto-recovery attempts per workstream with cooldown/exponential backoff and a configured cap. Distinguish network transients from authentication, rate/usage caps, login and explicit provider restrictions; the latter require a hold/operator rather than repeated stop-and-retry.
- Persist each stage across MV3/service/Windows restarts; no replay after unknown click/send result. Failure in one workstream must not block other workstreams.

**This is a proposed policy requiring provider support/permissions review and real Chrome control identification; its presence in this file does not mean working Chrome automation exists or makes circumvention permissible.**

## 13. Evidence-tied CI reinspection and timers (target contract)

- A message such as "병합 후 CI 확인중입니다" or "CI가 장기 실행중이므로 대기중입니다" is *not proof* of an existing CI job. It triggers an exact repository/PR/head SHA/run ID/attempt lookup via CI Watchtower and GitHub.
- Queued/running correctly attributed run: persist WAIT_EXTERNAL with timestamped observation, next inspection deadline/backoff and correlation IDs. Do not send `계속 진행` while waiting.
- Fresh verified success: check merge state, required checks and approved next task again, then schedule one eligible follow-up. Fresh failure: send a bounded authorized failure-analysis task, or WAIT_HUMAN when a decision is required. Missing/stale/conflicting evidence: UNKNOWN and reinspection, not success.
- Extended run with no progress: bounded slower polling, operator notification only after a configured anomaly/timeout threshold; don't flood ChatGPT or GitHub.
- Watchtower polling and Autopilot response observation are separate schedules; avoid duplicate network polling and multiple tabs reacting to the same project-wide run as if it belonged to them.

## 14. Remote exception notifications and commands (target contract)

The target operator experience is **hands-off except for meaningful exceptions**. Windows local Inbox is canonical; Telegram is an initial *candidate* delivery/command adapter (phone number/KakaoTalk or other messengers require separate authorization/feasibility review). Messages must identify the workstream, severity/reason, required operator action, current paused state and action expiry. Group repeated identical alerts; never leak credentials, private conversation bodies or full code in messenger notifications.

- Examples: **cost/payment authorization**, manual Windows acceptance, login/permission, architecture/product choice, provider/account restriction, repeated disconnect-recovery failure, prolonged anomalous CI.
- Default commands: read-only `status`, `hold`, `resume` after revalidation, and **approve/reject an exact scoped action**. Sending `resume` never authorizes a new payment, merge, deploy or wider project goal.
- Bind remote commands to a pre-enrolled account/chat, authenticated transport or provider verification, unique workstream/action fingerprint, expiry, one-use nonce/operation ID and durable audit. Recheck the action's target and latest evidence before executing.
- If the messenger is unavailable, delayed, sends a duplicate message, or cannot be authenticated, keep WAIT_HUMAN and use local Inbox; no implicit approval and no repeated uncontrolled notifications.
- A registered workstream may continue ordinary preapproved tasks while a **different** workstream is waiting for the operator. Global STOP still overrides every remote instruction.

## 15. Multi-session fairness, rate safety and definition of unattended success

- Each of 10–20+ registered tabs has its own timer, observation fingerprint, lease, state, external CI linkage and recovery counters. Use bounded concurrent inspections and dispatched actions, round-robin/fair scheduling and per-provider budget/backoff; do not interpret provider throttle/disconnect as permission to bypass usage limits.
- All retries, disconnect recovery, context handoff and remote approvals are **idempotent state transitions**; uncertainty blocks replay.
- Pilot success requires 1 → 3 → 10 → 20 tab runs with mixed normal-completion, CI-wait, length-limit, disconnect, human-approval and active-generation states. A blocked session cannot silently block all others.
- Measure **verified work completed, wrong-target sends, duplicate external actions, unauthorized sensitive actions, unnecessary operator pages and end-to-end manual interventions**. CI green on mocks does not equal real Windows/Chrome unattended acceptance.

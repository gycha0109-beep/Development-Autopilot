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
4. **Evidence:** Required target PR/SHA/run/attempt mapped; data fresh and unambiguous?
5. **Approval:** Proposed action within approved scope and still authorized?
6. **Safety:** No waiting login, human review, in-progress manual entry, provider limitation or stop state?
7. **Dispatch:** Create immutable operation ID and idempotency key; acquire exclusive workstream lease.
8. **Reconcile:** Read actual outcome; do not equate a successful submission with task completion.

If any gate cannot answer decisively, **do not execute**. Record a reason code and schedule safe reinspection or operator review.

## 4. Wait vs failure semantics

- **WAIT_EXTERNAL:** Specific linked CI/PR is queued/running or a required external prerequisite is pending. Resume eligibility check on fresh evidence; no "continue" message merely to fill time.
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
- One active write/dispatch operation per workstream.
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

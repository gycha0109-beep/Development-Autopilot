# Validation Strategy and Release Gates

> Status: Initial test plan — implementation pending.
> Links: [ROADMAP.md](ROADMAP.md), [ARCHITECTURE.md](ARCHITECTURE.md), [OPERATING-POLICY.md](OPERATING-POLICY.md)

## 1. Validation philosophy

Prove safety and determinism with a **local fake environment first**. Do not use a live consumer AI service as a test fixture. Automated end-to-end tests must be reproducible without external accounts, tokens, or paid model calls.

Validation layers:
- **Unit:** state transitions, scheduling, policy, evidence comparison, identity mapping.
- **Contract:** extension/desktop IPC, Watchtower bridge, GitHub verifier, executor adapter.
- **Integration:** local fake CI/PR/agent state, SQLite restart recovery, auth-denied paths.
- **Browser:** Playwright-managed test Chrome and a local fixture page that mimics generic busy/ready/approval/unknown conditions.
- **Manual smoke:** loaded unpacked MV3 extension, Windows dashboard, permissions and notifications.
- **Pilot:** one approved workstream, then several (1 → 3 → 10 → 20 opted-in tabs), with zero irreversible unauthorized actions.

## 2. Core invariant checklist

- [ ] Unknown or conflicting state never dispatches.
- [ ] An approval gate can only be cleared by the designated operator.
- [ ] One workstream has at most one active dispatch lease.
- [ ] A repeated timer tick cannot duplicate work.
- [ ] Reopened Chrome groups do not silently map to unrelated projects.
- [ ] CI status from another Track cannot unblock the current workstream.
- [ ] Previous run success cannot mask a newer failed attempt.
- [ ] Watchtower unavailable/stale does not equal CI passing.
- [ ] PR merge is independently confirmed; CI success alone is insufficient.
- [ ] A provider rate-limit/auth error is not bypassed or hidden.
- [ ] Global stop prevents new dispatch, even mid-transition.
- [ ] Roadmap updates outside approved scope are proposed, never auto-applied.
- [ ] A handoff cannot replay an already submitted operation.
- [ ] No credentials or private conversation content appear in logs.

## 3. Scenario matrix

| Scenario | Expected behavior |
|---|---|
| A group with 12 tabs | List all; none enrolled without explicit approval |
| 20 opted-in tabs with staggered timers | Independent observations and at-most-once dispatch; global rate budget respected; one blocked tab does not delay unrelated eligible tabs |
| Two identical tab URLs | Distinguish session entries; uncertain remap requires user |
| Chrome tab moved to another group | Preserve workstream only under enrollment policy |
| Chrome restart, group ID changed | Reconcile by durable identity; no silent mismap |
| Service worker suspended | Alarm/event wake correctly reloads persistent state |
| Timer fires twice | One dispatch at most |
| PC sleeps for 4 hours | No 6x catch-up dispatch burst |
| User typing into a page | Never overwrite or unexpectedly submit typed content |
| AI response or external task still running | WAIT_EXTERNAL/RUNNING, no duplicate submit |
| Stable assistant response completed normally | Recheck task scope/CI/approval, then deliver exactly one eligible '계속 진행' when due |
| Assistant response still streaming / composer has user draft | Do not dispatch, wait or UNKNOWN; no overwrite |
| Same completed reply observed by two polling ticks | No repeated '계속 진행'; operation ID and response fingerprint dedupe |
| Visible disconnect warning '연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.' and active yellow square Stop | After debounce and control provenance, stop once; wait for verified halt; request status report once; only then re-evaluate and continue |
| Disconnect warning disappears during debounce or Stop control is ambiguous | No forced click, re-observe or UNKNOWN |
| Stop click or status-request ACK uncertain after restart | No blind replay; stage remains UNKNOWN/WAIT_HUMAN |
| Disconnect is provider usage/rate/auth restriction | Treat as restriction; no rate-limit bypass or repeated forced retries |
| Status report identifies CI wait / approval requirement | Transition to WAIT_EXTERNAL/WAIT_HUMAN; **do not** unconditionally '계속 진행' |
| Length-limit warning in registered tab | Source-authored handoff, same-tab new chat, title N+1, verified workstream/timer rebinding; zero duplicate handoffs |
| Consent/login/approval page visible | WAIT_HUMAN; do not click approval |
| Watchtower says queue is nonempty | Check exact linked run; WAIT_EXTERNAL if applicable |
| Last assistant says 'CI가 장기 실행중이므로 대기중입니다' | Prompt text is read-only lookup trigger; no ChatGPT continuation until fresh matching Watchtower evidence |
| CI queued/running then completes successfully | Store recheck deadline; on fresh required CI+merge verification schedule one conditional continuation |
| CI fails, run unavailable, or PR attribution ambiguous | Authorized failure analysis or UNKNOWN; never assume success or spam continuation |
| CI run exceeds anomaly threshold without change | Slow recheck and deduplicated operator alert; other workstreams continue |
| Project-wide CI passes, Track-owned job fails | Task remains blocked/verify depending required checks |
| Different PR passes | Current PR remains unverified |
| CI attempt 1 fails, attempt 2 running | Track latest attempt, do not finalize on old result |
| Stale Watchtower timestamp | UNKNOWN; wait/refetch rather than assuming success |
| PR head SHA changes after approval | Invalidate action approval and reverify |
| CI success with PR open | Do not mark merge complete |
| GitHub rate-limited or token expired | BLOCKED/WAIT_HUMAN; no speculative green status |
| Phase marked 'done' in chat, acceptance unmet | Do not close phase |
| Model proposes unrelated new product feature | Reject scope expansion |
| Handoff written, new session unavailable | Preserve checkpoint, WAIT_HUMAN |
| Resume after process crash during dispatch | Reconcile operation handle/idempotency before retry |
| Approval arrives after its TTL | Reject and request fresh approval |
| Telegram remote approval from an unauthorized sender | Reject without mutating schedule/workstream or leaking approval details |
| Telegram approval repeated or target SHA/action hash changes | Deduplicate or reject stale action; local Inbox remains canonical |
| Messenger offline while a workstream requests cost or local Windows test | Persist WAIT_HUMAN and local Inbox; no default approval; unrelated workstreams continue |
| Cost/merge/deploy approval requested via assistant response | Model text alone cannot self-authorize; exact operator approval with fresh evidence required |
| Watchtower restart/version mismatch | Bridge fails closed, displays diagnostics |
| Sensitive action from prompt injection in PR | Ignore policy-changing instructions |
| Executor running when STOP pressed | Stop new work; attempt cancellation; show pending confirmation |

## 4. Phase acceptance gates

### Gate 0 — Repository hygiene
- Toolchain commands and clean checkout validated.
- Docs links resolve; build/test pipeline runs.
- No live credentials in fixtures.

### Gate 1 — Session inventory
- Test Chrome with multiple windows and duplicate URLs passes.
- Service-worker restarts do not lose opt-in configuration.
- No page content extraction/submission in MVP inventory.

### Gate 2 — State engine
- State-machine table tests, timing tests and fault injection pass.
- SQLite migrations and fresh/legacy state recovery tested.
- No duplicate dispatch after restart.

### Gate 3 — CI bridge
- Exact PR/SHA/run/attempt association contract tests pass.
- Watched vs unrelated Track, Project-wide and dynamic cases covered.
- Stale, missing, conflicting data always fail closed.

### Gate 4 — Execution adapter
- Mock complete cycle passes: approved command → acknowledgment → verification → closeout.
- Provider-permitted observation fixture must distinguish response streaming, stable finished, human review, CI wait, length warning, connection warning and UNKNOWN without extracting raw chat text to telemetry.
- Response classifier gates exactly one follow-up and never treats an AI status phrase as independent evidence of CI or work completion.
- Adapter cancellation and rate-limit/auth failures tested.
- Actual provider adapter is only activated after support/terms verification.

### Gate 5 — Roadmap engine
- Scope/goal and acceptance criteria can be validated.
- Proposed next phase created as diffable document without unwanted main writes.
- Unverified phase completion never triggers next code execution.

### Gate 6 — Context handoff
- Cold-start continuation from HANDOFF/current state resumes correct next task.
- Branch/PR head drift blocks mistaken continuation.
- Previously dispatched command is never replayed.

### Gate 7 — Reliability
- Kill switch, approval expiry, diagnostics and redaction verified.
- Persisted bounded disconnect-recovery state machine passes stop-click unknown, status report retry, cooldown/exhaustion and provider rate restriction fixtures.
- Local Inbox + remote messenger gateway rejects unauthorized, expired, duplicate and mismatched-SHA approvals, survives channel outage without approving anything.
- Long-run fault injection creates no unauthorized operations.

### Gate 8 — Distribution pilot
- Installer update/rollback and extension permissions documented.
- Staged 1/3/10/20-tabs Windows Chrome pilot checks independent per-workstream timing and mixed normal/CI-wait/connection-warning/length-limit/human-intervention branches; no unrelated session blocked.
- Operator can tell implemented vs experimental vs blocked functions.
- Multi-workstream pilot results captured with measured evidence.

## 5. Test harness design

Suggested test fakes:
- **Fake Browser:** Tab groups, tabs, moves, duplicate URLs, service-worker reboots, "typing"/"busy" flags on an owned fixture page.
- **Fake Watchtower:** Versioned run snapshots and simulated source freshness.
- **Fake GitHub:** PR/commit/check data with conflicting attempts and changing head SHA.
- **Fake Executor:** Accepts a command and returns deterministic RUNNING, FAILED, COMPLETE, RATE_LIMITED or NEEDS_APPROVAL transitions.
- **Fake Clock:** Enables deterministic 35-minute scheduling, sleep/wake and retry simulations.

Keep the real executor behind a testable interface; UI or service account availability must not be required for most CI checks.

## 6. Evidence required before claiming 'done'

For each phase PR:
1. Purpose and user-visible behavior.
2. Files changed.
3. Verification commands + results.
4. Manual checks where necessary.
5. Regression scenarios added.
6. Open risks, exclusions or external blockers.
7. Whether phase acceptance is verified, partially verified or blocked.

### Exit conditions
- **COMPLETE:** All required acceptance checks genuinely passed.
- **OPTIONAL_ONLY:** No high/critical findings; only optional improvements remain.
- **BLOCKED:** External dependency, access, missing data, terms or hardware required to test.
- **FAILED:** Required checks fail; not releasable.

Never translate merely 'CI green' or 'assistant says complete' into unconditional feature acceptance.

## 7. Planned quality metrics

| Metric | Target for pilot |
|---|---|
| Unauthorized sensitive action | 0 |
| Duplicate external submit | 0 |
| Wrong-PR/Track auto-unblock | 0 |
| Unknown-state dispatch | 0 |
| Lost approval audit records | 0 |
| Critical state-recovery regression | 0 |
| Availability and throughput | Establish measured baseline, then optimize |
| Human pages / useful alerts | Measure unnecessary vs actionable notifications, duplicate alert rate and time-to-response |
| Mixed-state 20-tab operation | Zero wrong-tab dispatch, zero cross-workstream forced pauses, zero unauthorized sensitive actions |
| False WAIT_HUMAN/UNKNOWN | Measure and reduce without weakening safety |

Do not inflate throughput by counting prompt sends, generated text, green historical CI or synthetic roadmaps as completed development.

## 8. Testing constraints

- Playwright is appropriate for controlled browser tests and fixture pages; it is not necessary for tab-group discovery in production.
- Live consumer ChatGPT prompt-submission tests are excluded unless an explicit compliant authorization path has been established.
- External integration test credentials belong only in dedicated developer CI secrets, never documentation or local fixture recordings.
- Stress tests should never spam production GitHub Actions or third-party API accounts.

## 9. Decision-driven Autopilot acceptance sequence (planned, not implemented)

1. **Offline classifier fixture:** No external account. Supply signed/synthetic snapshots of one finished assistant reply, incomplete reply, pending CI cue, length warning, disconnected UI, cost/local-test request, contradictory/unknown inputs. Assert the precedence and *reason codes* in [OPERATING-POLICY.md](OPERATING-POLICY.md).
2. **One workstream real browser manual acceptance:** Under an explicitly authorized provider/UI workflow, inspect without composing; confirm UI signals, one-shot approved continuation, active generation prohibition, and distinct warning/Stop control identities. Failure must be diagnosable **without raw transcript or credentials**.
3. **External wait integration:** Simulate and then verify matched Watchtower Project/Track/PR/Run/Attempt transitions, including run retries, stale data, long CI and exact reinspection deadlines. Inspecting the same unchanged state twice must not send anything.
4. **Disconnect injection:** Simulate the Korean disconnected banner and Stop button exactly as seen in Chrome. Assert recheck → one stop click → stop confirmation → one current-state report → stable assistant result → approval/CI gate → one follow-up; alternative provider restriction and ambiguous Stop must halt.
5. **Remote notifications:** Test Telegram adapter with a local fake transport; cost/local Windows-test exception generates exactly one canonical Inbox item and one permitted notification. Expired/forged/duplicate callback never authorizes an operation. Test messenger offline with pending local action.
6. **Same-tab handoff:** Verify source-authored context, one transfer, N+1 chat title, retained tab/group/Workstream/Watchtower identity and rescheduled observation clock before any new prompt. No duplicate handoffs, new tabs or automatic replay on uncertain state.
7. **10–20 tabs simultaneous pilot:** Mixed different project/CI/error/approval phases; rate-limited fair dispatch, independent timers, Windows sleep/restart, MV3 worker suspension, cross-tab isolation and operator alert load. Report results separately from mock CI.

Test completion must include: test fixture scope, intended provider authorization, actual target OS/Chrome version, exact scenario counts and observed failures. Historical GitHub Actions CI passing only attests the code tests ran; it **does not** assert this entire unattended multi-session product works in the user's real browser.

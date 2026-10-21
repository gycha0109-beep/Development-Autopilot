# Local ChatGPT simulator

## Scope and isolation

Based on PR #76 (`31ab4f2`), including its complete ancestor stack. Parallel historical alternatives (#24, #35) are not merged into this branch. None of the existing PRs is merged by this work.

This is a **synthetic test service**, not ChatGPT or an account proxy. It has no login, cookies, remote API, account import or real messenger. Production extension sources, installation path, approvals and SQLite are untouched. Generated test builds accept one exact `http://127.0.0.1:PORT` page origin instead of `https://chatgpt.com`, and remove the latter from extension host permissions. Do not load these builds into a user profile. A disposable profile, separate bridge port and separate SQLite are mandatory for integration tests.

The build copies the extension and local server, replacing only exact origin constants and their migration URL regex equivalents. Policies, completion checks, response fingerprints, approvals, Operation IDs, deduplication, WAIT_SLOT, reload serialization and backoff are retained. Optional CI adapters replace external I/O, while retaining the production Watchtower HTTP parser, exact target reconciliation and GitHub verifier. These adapters never query an actual Registry, credential manager or GitHub account.

## Run

Node >=22.16 and `npm ci` are prerequisites.

```powershell
npm run simulator
# http://127.0.0.1:48273 — room creation/scenario dashboard
```

State is saved to `.autopilot/simulator/state.json`; override `SIMULATOR_PORT` / `SIMULATOR_STATE` to use an independent location. Do not point these at production files. Restarting the simulator preserves messages, queued response configuration, room/project identity, events and send request IDs.

Generate a test-only copy into a directory that does not already exist:

```powershell
node simulator/build-cli.mjs --output .autopilot/simulator-runtime --simulator http://127.0.0.1:48273 --bridge http://127.0.0.1:48274 --synthetic-ci
$env:AUTOPILOT_PORT='48274'
$env:AUTOPILOT_DB=(Join-Path $PWD '.autopilot/simulator/lab.sqlite3')
node .autopilot/simulator-runtime/local/server.js
```

Use the generated `extension` only in an isolated browser profile. The automated MV3 suite handles profile creation, pairing, registration, explicit test approvals, browser control, assertions and cleanup itself; no real Chrome credentials are needed. Stable Chrome releases may ignore unpacked-extension command flags; use Playwright Chromium or a supported test browser. Local Windows execution may use Edge (Chromium); report its actual product name rather than calling it Google Chrome.

## Deterministic control API

All mutations require `Origin: http://127.0.0.1:PORT` and exactly `Content-Type: application/json`. Host must match the listening loopback address; no CORS is enabled. Routes accept owned synthetic content only.

| Request | Purpose |
|---|---|
| `GET /simulator/api` | Rooms, scenarios, CI configuration and sequenced event journal |
| `POST /simulator/api/rooms` | `{id, title, project?, renderer?, empty?, scenario?, responses?}` |
| `GET /simulator/api/rooms/:id` | Current response/stream state and effects |
| `POST /simulator/api/rooms/:id/scenario` | `{scenario, answer?, responses?, recoverOnReload?, duplicate?, reverse?, draft?}` |
| `POST /simulator/api/rooms/:id/messages` | `{requestId, message}`; request IDs are idempotent within a room |
| `POST /simulator/api/rooms/:id/stop` | Stop a stream once |
| `POST /simulator/api/rooms/:id/title` | `{title}` |
| `POST /simulator/api/ci/ops` | `{state: running|success|failure|unknown, merged?, identity?}` |

Example response plan: `{"responses":[{"answer":"다음 응답 완료.","delayMs":1500,"scenario":"normal"}]}`. Streaming uses a persisted completion time and resumes after process/browser restart. `loading-error` updates the mounted DOM without navigating; the next page navigation heals it only when `recoverOnReload:true`. Persistent failure remains a failure. `duplicate` / `reverse` deliberately create adversarial projections of existing turns. Empty project landing sends create a new conversation URL in the same tab. Current and legacy renderer projections are explicit, never mixed to make the current observer pass.

## REA and DOM evidence

Official sources: [morluto/rea](https://github.com/morluto/rea), [rea.tools](https://rea.tools/), [rea-agents on npm](https://www.npmjs.com/package/rea-agents). Verified npm repository identity and pinned CLI **6.7.0**. Ran `--help`, `setup --client codex --dry-run`, `inspect-web-page --schema`, `list-browser-targets` and `inspect-web-page`.

REA supports Codex MCP setup (`npx rea-agents@6.7.0 setup --client codex`), which proposes editing Codex configuration and installing its skill; activating that MCP registration requires restarting the client. The CLI was executed directly here, without changing global Codex configuration or stopping this task. Native binary analysis providers are unnecessary for this website task.

The running user Chrome exposed no `--remote-debugging-port` or `--remote-debugging-pipe` switch. REA requires a CDP endpoint and cannot attach to the existing browser-tool extension as if it were CDP. We did not restart the user's Chrome or copy its profile. Instead, the supported browser tool performed a read-only structural inspection. Only the sanitized [selector evidence](fixtures/chatgpt-dom-2026-10-21.json) is retained. REA separately connected successfully to the disposable simulator's CDP endpoint; this is **REA simulator evidence, not REA capture of the authenticated ChatGPT page**.

| DOM/state | Evidence and compatibility boundary |
|---|---|
| Completed modern turn, user/assistant units, three message ID boundaries, composer ownership | Observed read-only on actual Windows Chrome on 2026-10-21; reproduced with synthetic IDs/text |
| Writing Block extra editor | Two `DIV[role=textbox][contenteditable]`, only one in composer, observed; simulator reproduces ambiguity, does not weaken observer |
| Empty composer without Send/Stop | Observed; simulator uses a synthetic Send control to permit controlled fixture actions |
| Modern response-loading status and reload success/failure | Prior separately documented actual acceptance in PR #75/#76; current simulator transition is synthetic |
| Streaming, disconnect/Stop, CI/cost/test/approval, quota | Synthesized from existing production selectors and fixtures, not newly observed live states |
| Length limit, source handoff, project navigation/title editing | Synthetic public-UI contract; legacy migration compatibility must be reported separately from modern renderer compatibility |
| Account-level network/root cause | Not inferred from simulator behavior or from a successful reload |

Raw actual DOM, private message bodies, account IDs, session URLs, cookies, tokens and actual screenshots are deliberately absent. Isolated traces contain only synthetic content and ephemeral test pairing data.

## Validation boundaries

Existing `npm run test:e2e` remains the MV3 regression suite; its legacy/current DOM generator and wait/port helpers were extracted into `test-support` for reuse, not removed. `npm run check` includes simulator HTTP, persistence, identity, invalid-control, build isolation and unchanged-policy regressions. New mixed-runtime integration results are recorded separately after execution. A simulator pass never certifies actual ChatGPT recovery, actual Watchtower service compatibility, actual messenger delivery or real 20-chat unattended operation.

## MV3 integration suites

```powershell
npm run test:simulator
npm run test:simulator:migration
```

The first suite creates twenty independently persisted project conversations, registers them through the actual MV3 options UI, pairs a separate local server, and obtains worker observations in batches of 5, 10 and 20. It uses real wall-clock 30-second stability/debounce, 60-second inspection/rate limits, and existing SQLite approval/claim machinery. Expect about 10–15 minutes, not a subsecond unit test.

Ten normal conversations, recoverable/persistent loading failures, a disconnect, a CI wait, cost/local-test/approval requests, ambiguous Writing Block/composer states and an ongoing response operate concurrently. Thirteen bounded continuation campaigns can send once; disconnect additionally permits the existing one fixed report. The suite checks all fourteen UI sends, independent observation of completed next replies, exact tab retention, one reload per error episode, Inbox isolation, and server/browser/extension restart without replay. Browser restart preserves registration/history but deliberately holds physical-tab execution until rebind rather than treating old tab IDs as authority.

The second suite reproduces source-first migration through the actual extension state machine using an explicitly **synthetic legacy renderer**. It verifies one source authoring request, one transferred payload (marker stripped by the existing copy contract), same physical tab/project, N+1 rename, the original workstream/session link, unchanged campaign approval/expiry/limit/count and restored scheduling. Modern Writing Block migration is not certified by this legacy test.

Outputs under `.autopilot/e2e-artifacts/` include `simulator-results.json`, `simulator-runtime-trace.zip`, the restart trace, and separate `simulator-migration-*` evidence. Failures add synthetic server/SQLite snapshot diagnostics. GitHub Actions runs these in a separate Windows/Ubuntu matrix, uploads only synthetic evidence, and retains artifacts seven days. See [PR #77 checks](https://github.com/gycha0109-beep/Development-Autopilot/pull/77/checks) and the stacked integration PR checks for exact revisions/results.

### Operational defect exposed by this suite

Previously, `MigrationContinuity` had no runtime proof adapter. Even after a same-tab migration and verified rename, a managed campaign stayed at `MIGRATION_OBSERVATION_BINDING_REQUIRED`. A concurrent length observation could also open `HANDOFF_NOT_APPROVED` while an explicitly enabled extension watcher was already performing that handoff.

The follow-up adds authenticated **enabled** watcher capabilities separately from retained watcher inventory, plus a one-minute process-local proof challenge. The worker verifies the source binding, same physical tab/window/group/project, source-authored handoff, stable first reply, actual N+1 title and retained watcher; it independently captures the new response DOM. The server validates the exact migration/checkpoint/campaign/CI-target identity and new binding before restoring the existing campaign. Missing, stale, wrong-session, revoked or replayed proof fails closed. After restoration, a new observation barrier forces the normal completion/CI/Inbox/dedup gates to run again. No extra send, merge, spending or approval authority is granted.

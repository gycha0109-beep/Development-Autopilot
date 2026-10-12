# Decision Log and Unresolved Questions

> Purpose: Keep early architectural direction clear **without prematurely freezing implementation detail**.
> Date opened: 2026-10-12.

## Accepted product-direction decisions

| ID | Decision | Reason | Status |
|---|---|---|---|
| D-001 | Development Autopilot is a Windows local-first developer operations manager, not just a timed text macro. | Need CI, roadmap and session continuity, not only keyboard automation. | Accepted |
| D-002 | Build a custom Chrome Manifest V3 extension for opted-in tab/group discovery. | User wants explicit Chrome tab-group targeting; official tabGroups/tabs APIs exist. | Accepted for prototype |
| D-003 | Keep scheduling and durable workstream state in a local orchestrator. | MV3 workers are ephemeral; restart safety and cross-project control need persistence. | Accepted |
| D-004 | Integrate existing CI Watchtower **read-only**, reusing its Project/Track/CI responsibility model. | Avoid duplicated monitors and conflicting classification. | Accepted |
| D-005 | Treat repository docs + exact GitHub PR/commit evidence as durable development state. | Long AI conversations are not dependable canonical memory. | Accepted |
| D-006 | Use human approval gates and fail-closed behavior. | Prevent accidental approval, duplicate execution, incorrect CI assumptions. | Accepted |
| D-007 | Deliver thin vertical slices and decide implementation specifics from tests. | User preference is to establish detailed process during construction. | Accepted |
| D-008 | Execution adapters must be replaceable; do not couple architecture to one unsupported browser automation route. | Provider APIs, usage limits and permissions can change. | Accepted |
| D-009 | Initial default continuation interval idea: 35 minutes **per workstream**, configurable. | Avoid synchronized blindly repeated commands. | Provisional |
| D-010 | Default mode is Observe; model prompts cannot grant themselves more authority. | Explicit consent and safe onboarding. | Accepted |

## Open architectural decisions

| ID | Question | Decision point | Evaluation evidence |
|---|---|---|---|
| Q-001 | Tauri 2 desktop UI or another Windows host? | Phase 0–1 | Installer size, IPC security, Watchtower interoperability, update/rollback |
| Q-002 | Native messaging vs authenticated local loopback bridge? | Phase 1 | Chrome deployment UX, reconnect behavior, privilege boundary |
| Q-003 | How to identify replaced/duplicated tabs without false reassignment? | Phase 1 | Restart/multiple-windows fixtures |
| Q-004 | Exact scheduler/event model and storage schema? | Phase 2 | Idempotency, sleep/wake, restart fault injection |
| Q-005 | What stable read API can Watchtower expose? | Phase 3 | Direct review of existing Rust/Tauri commands and schema |
| Q-006 | Which authorized AI coding/execution runtime? | Phase 4 | Terms, cost, permissions, developer experience, interruption |
| Q-007 | Structured signals vs external task state vs optional UI cues? | Phase 4 | False-positive continuation tests |
| Q-008 | Per-repo roadmap layout and phase approval policy? | Phase 5 | Multi-workstream conflicts and docs diff/review |
| Q-009 | Provider-supported conversation/session creation and handoff? | Phase 6 | Recovery tests, capability review |
| Q-010 | Policy for programmatic PR merge / deploy? | Phase 7 | Explicit action matrix and operator review |

## How to change decisions

Use an ADR-style entry:
```text
ID:
Date:
Status: proposed | accepted | superseded | rejected
Context:
Decision:
Alternatives considered:
Consequences / risks:
Validation evidence:
Linked PR:
```

Do not silently change an accepted architectural boundary via a small unrelated PR. For a product-scope change, update ROADMAP.md and the relevant policy/tests in the same PR.

## Early technical reference links

- Chrome extensions API: https://developer.chrome.com/docs/extensions/reference/api
- Chrome tabGroups: https://developer.chrome.com/docs/extensions/reference/api/tabGroups
- Chrome alarms: https://developer.chrome.com/docs/extensions/reference/api/alarms
- Playwright browser connections: https://playwright.dev/docs/api/class-browsertype
- OpenAI Terms of Use: https://openai.com/policies/terms-of-use/
- CI Watchtower codebase: https://github.com/gycha0109-beep/CI-Watchtower

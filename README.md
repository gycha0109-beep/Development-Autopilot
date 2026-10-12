# Development Autopilot

**Local-first development orchestration for multiple workstreams** — a Windows coordinator designed to connect opted-in Chrome development sessions, CI Watchtower observations, verified GitHub state, repository roadmaps and safe human-intervention gates.

> **Current status: Planning only.** The repository currently contains architecture/roadmap documents, not a working Chrome extension, Windows executable, or AI coding agent.

## Documentation

1. **[Master roadmap](docs/ROADMAP.md)** — vision, phases 0–8, delivery gates, MVP sequence and acceptance criteria.
2. **[System architecture](docs/ARCHITECTURE.md)** — extension / desktop / Watchtower / GitHub / executor boundaries, states, scheduling and data model.
3. **[Operating policy](docs/OPERATING-POLICY.md)** — permitted actions, approval boundaries, stop/recovery, phase changes, handoff and service compliance.
4. **[Validation plan](docs/VALIDATION.md)** — tests, fault injection, per-phase release gates and non-negotiable invariants.
5. **[Decision log](docs/DECISIONS.md)** — accepted product principles and implementation details deliberately left open.

## Planned first deliverable

A locally loaded **Manifest V3 Chrome extension** and simple dashboard that inventory explicitly enrolled tab groups/tabs, persist their project/workstream mappings and remain safe across browser restarts. No unattended chat submission in the first slice.

## Long-term direction

```text
Chrome tab groups → Local orchestrator → Authorized execution adapter
                             ↕
                     CI Watchtower + GitHub
                             ↕
                    Roadmap / task / handoff docs
                             ↓
                   Human approval when necessary
```

Operational target: finish **one approved bounded development phase**, verify PR/CI state and preserve a reliable handoff without repeatedly asking the operator to issue routine next-step prompts.

This is **not** a promise of unrestricted, free or perpetual unattended AI execution. Third-party terms, supported execution interfaces, approval gates and resource limits apply.

## Engineering principle

**Implement → test → observe → revise the next decision.** The major responsibilities and safety boundaries are set; low-level processes should be refined through working prototypes rather than speculated exhaustively in advance.

## Related project

[CI Watchtower](https://github.com/gycha0109-beep/CI-Watchtower) — existing Windows GitHub Actions monitor; Development Autopilot plans to use a read-only integration rather than duplicate its CI responsibility logic.

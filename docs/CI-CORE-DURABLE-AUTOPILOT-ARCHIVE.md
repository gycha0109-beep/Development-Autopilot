# Autopilot-owned CI history (no second WatchTower writer)

This implementation makes the **running Autopilot service**, not the WatchTower desktop UI, persist bounded GitHub Actions observations. The existing WatchTower `ci-watchtower.sqlite3` remains opened **read-only** by registry and history readers; never open it for writes. Existing Windows Credential Manager PAT remains internal to pinned Rust scanner, never stored by Node.

## Collection and storage

- Existing `ci-core-scan.exe` obtains up to 30 recent runs for 2 enabled repositories every 2 minutes, bounded by 6 GET requests per repository. The existing 15-minute auth/rate-limit cooldown remains active.
- The new `CoreRunArchive` writes only to the **Autopilot-owned** SQLite database (`%LOCALAPPDATA%\Development-Autopilot\data\autopilot.sqlite3`). It creates new `ci_core_runs`, `ci_core_events`, `ci_core_receipts` tables, under the existing single Autopilot server's SQLite connection and transaction helper.
- Each unique repository/Run ID/Attempt is stored once. Later status/conclusion changes are updated only when GitHub's `updatedAt` has not moved backward. A new Attempt is recorded separately; errors/rollbacks never leave half-recorded batches. Replayed scans do not duplicate events or writes.
- Historical Track affiliation can only be copied if the **same Run ID and 40-character SHA** matches one record in the existing read-only history, and the local Track belongs to the same project. Conflicts and unknowns remain unassigned; the program does not infer Track ownership from a workflow name, title or branch.
- Validated, short-lived scanner observations are required. A historical SUCCESS, missing checks, stale snapshot or incomplete source never produces authorization to continue work. Every new database/view result explicitly sets `safeToAdvance=false` and `completeCoverage=false`.

## Operator interfaces

- Autopilot `GET /api/v1/snapshot` includes `directCiArchive` totals and current status. The WatchTower panel distinguishes new Autopilot-local CI records from the legacy desktop-run history.
- `GET /api/v1/ci-core/archive` returns at most 60 recent recorded attempts and 50 state transitions, locally on the existing loopback port. This is read-only, without PAT or raw GitHub response.
- `POST /api/v1/ci-core/scan/refresh` and `POST /api/v1/ci-core/archive/refresh` trigger the same bounded scanner and one transaction. Both routes require the existing same-origin JSON/CSRF protections. A two-minute scheduler automatically persists results even while `globalStopped=true`; stopping applies to **work execution**, not passive CI observation.
- The newly added schema is in the Autopilot DB, **not the WatchTower DB**. Take SQLite online backups prior to updating the running server. Old Autopilot binary remains recoverable from the previous app backup.

## Important boundaries

This achieves **headless ongoing CI collection into Autopilot's own database** and leaves the WatchTower UI and database writer inactive. It does not clone the whole historical WatchTower database or provide unbounded full GitHub coverage, exact required checks, merge approval, full Producer/Track attribution, Telegram incident notifications or automatic execution/resume. Those require separately validated policies and explicit operator actions. Do not turn partial green into authorization or turn global stop off during migration.

The Rust shared staging writer and cooperative lease PRs #76–#78 remain separate unmerged previews. Do **not** launch that writer against the existing WatchTower DB; the Autopilot-local recorder eliminates the immediate two-writer conflict without attempting a dangerous in-place migration.

# Independent GitHub Repository Directory (Autopilot 0.8.6)

## Architecture

Repository selection is owned by Autopilot, **not** CI Core, WatchTower, GitHub PR targets, or Workstreams.

- **GitHub accessible repositories:** the server uses the existing authenticated GitHub CLI (`gh api /user/repos`) with bounded pagination, a 12-second timeout per page, a read-only metadata endpoint, and a 10-minute in-process cache. No API token is copied into Chrome or Autopilot SQLite.
- **Existing Workstreams and macro bindings:** their repository names remain selectable even with no GitHub authentication and no CI Core binary.
- **Manual registration:** the operator can enter `owner/repository` in the Chrome popup. This creates a durable SQLite catalog entry, independently of CI Core and Workstreams. Invalid identifiers are refused.
- **Per-chat binding:** the existing macro configuration stores the selected repository for each registered chat. Existing settings are preserved. Repository selection is optional.
- **CI monitoring:** a separate read-only property `ciMonitored` is true only when a matching repository is actually present in a connected Direct CI Core registry. Selecting a repository **does not** enable CI monitoring or imply fresh CI evidence.

## Boundaries

- The authenticated Chrome bridge exposes `macro-state`, `macro-repositories-refresh`, `macro-repository-add`. The unpaired extension origin cannot list or mutate repositories. The ordinary localhost dashboard API remains separate.
- GitHub CLI lookup errors return sanitized error codes; stale saved/manual/workstream entries remain selectable if GitHub is offline.
- Authenticated GitHub metadata discovery is repeated separately on each PC. A manually entered repository is stored locally and **is not silently claimed to be synced across PCs**.
- The original operator stop, pairing, session identity, CI fail-closed approvals and Telegram opt-in remain in place.

## Operator procedure

Open the Chrome extension and select a ChatGPT conversation. The repository list now shows known entries even when CI Core is disabled. Press **조회** to refresh from GitHub, or enter `owner/repository` and press **등록** to save an unverified local selection. Choose the repository and press **채팅 등록 및 매크로 설정**. No Workstream registration or Chrome tab group is required.

If GitHub is unavailable, direct manual registration still works. For GitHub private repository discovery, the current Windows account must be authenticated with `gh auth login` (existing CLI credentials are reused, never printed in logs).

## Test evidence

- Isolated local server with a copy of the academy SQLite database retained all five Workstreams and its global stop.
- With **Direct CI Core disabled**, authenticated GitHub discovery returned **34 repositories** on the academy PC. Direct manual registration increased the isolated catalog to 35 without a Workstream.
- Unit/HTTP tests cover disabled CI, offline GitHub, existing Workstreams, manual registration, duplicate prevention, authentication, identifier sanitization, repository-to-chat binding and exact CI monitoring label requirements.
- Live ChatGPT automatic sends, global-stop release, and Telegram sends were **not** used to validate this change.

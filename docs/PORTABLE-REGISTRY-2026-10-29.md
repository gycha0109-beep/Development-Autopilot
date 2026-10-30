# Autopilot Chrome registry and workstream backup (2026-10-29)

## Automatic recovery after restarting Chrome

The registered extension retains a stable session key for each explicitly registered tab. On every normal bridge synchronization and every options-page refresh, it checks whether a saved ChatGPT conversation URL is present in exactly one live tab of the matching named group. The group is restored only if that group can be proved by the exact saved conversation URL. A duplicate, missing, changed URL, or ambiguous group stays disconnected. This recovery does not send any ChatGPT messages.

Local Autopilot workstream-to-session mappings persist in SQLite. Restoring the same exact registered session key makes those existing links usable again. Re-pairing a browser extension deliberately clears its prior server-side links; importing an exported backup restores links by explicit import intent.

## One-file backup

The Chrome extension options page provides:
- **설정 JSON 내보내기**: downloads `autopilot-chrome-registry.json`. Includes explicitly registered ChatGPT group labels, exact conversation URLs, stable session keys, and connected local Autopilot workstream definitions and link session keys.
- **설정 JSON 가져오기**: validates the file and merges safely into the existing registry, creates missing local workstreams in *observe* mode, and restores saved exact-session links once the corresponding Chrome tab is unambiguously connected.

To import on another PC, install/run the extension and local Autopilot server and perform the initial local-server pairing. Open the relevant ChatGPT conversations in named Chrome groups. Then import the JSON. Pending exact matches can restore on the next bridge sync after the appropriate tab opens.

The export intentionally EXCLUDES the extension's bearer token, local pairing code, GitHub credentials, Telegram credentials, OpenAI API keys, CI approval state, and scheduled message approvals. The backup contains private conversation URLs; treat it as sensitive, never commit it to Git or share publicly.

The local API paths `POST /api/v1/bridge/config-export` and `POST /api/v1/bridge/config-import` are authenticated extension-only bridge endpoints. Import applies only via an operator action in the extension options page. Each workstream is deduplicated by repository and track key. Existing workstreams and links are never deleted or overridden.

## Validation

- `node --test tests/registry-portable.test.js tests/portable-config.test.js`
- `npm run check` (317 passing checks observed on 2026-10-29)
- Restart the local server to load the new bridge endpoints and reload the unpacked Chrome extension in `chrome://extensions`.
- Verify the export action includes `workstreams`, that an import is idempotent, and that the workstream links reappear after exact matching group/tabs.
- A live browser restart/recovery smoke is a separate verification and cannot be claimed by unit tests alone.

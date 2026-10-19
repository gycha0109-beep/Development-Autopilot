# Isolated browser E2E

Run `npm ci`, `npx playwright install chromium`, and `npm run test:e2e` on Windows. Ubuntu CI installs Chromium and runs the headed extension test under `xvfb-run`.

The test creates a disposable SQLite database, ephemeral localhost server, temporary browser profile, and a copy of the unpacked MV3 extension configured for the ephemeral port. It intercepts `https://chatgpt.com/` and serves local fixtures, so it never authenticates to or mutates a real ChatGPT account. It exercises the extension options UI pairing flow, 1/3/10/20 tab enrollment, extension-to-server observation transport, observation classification, draft redaction, and one-shot composer submission. An unregistered tab is included as a negative control.

The normal completed-response case intentionally remains `UNKNOWN` from one browser sample. Production continuation needs a second fresh, stable sample and the existing SQLite claim/approval path. CI waiting is classified as a cue only; this E2E does not connect to a real Watchtower or GitHub run. Disconnect is classified but the complete stop/report/recheck sequence is not driven here. Length warning detection is exercised without creating or migrating a real conversation. Messenger delivery is not tested; local Inbox and fake transport remain covered by unit tests.

This is an isolated Playwright browser acceptance test, not acceptance of the user's installed Chrome profile or live ChatGPT sessions. Actual account behavior, CI run binding, recovery, migration, and messenger authorization require separate explicitly approved acceptance scenarios.

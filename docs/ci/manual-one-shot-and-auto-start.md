# Chat popup: auto-start and manual one-shot (v0.8.12)

## What the buttons do

- **자동 작업 시작** appears immediately below **매크로 문구 저장** when automatic mode is selected.
- In manual mode the same control is labeled **수동 모드 등록**.
- The button registers the selected, exact ChatGPT conversation and stores its macro configuration. It starts automatic work only if the global control is running and the normal reply, interval and CI gates permit it.
- While global STOP is active, configuration is saved but **automatic execution does not start**. The popup confirmation and completion notice explicitly say this.
- **선택 매크로 수동 1회** always requires an explicit user click and a confirmation. It can request exactly one message while global STOP remains active. This is a narrowly scoped, user-triggered exception; it never resumes other chats or Workstreams.

## Manual dispatch safety

The authenticated extension's macro-send route is the only source of a manually authorized queued command. The SQLite ledger persists a one-bit `manual_once` flag for that command. Ordinary scheduled commands cannot set that flag.

- Only the registered, connected, unchanged chat can receive the message.
- Duplicate/pending commands, legacy Workstream links and disconnected chats are rejected.
- During global STOP, the server claims **only** `manual_once=1` commands, and the extension permits the dispatch only if the server confirms this command flag and authenticated status.
- Queued manual clicks expire after **two minutes**; no late replay.
- Claimed commands with uncertain result become terminal after restart, with no automatic retry.
- Normal automated messages, recovery operations and CI-driven sends remain blocked while global STOP is active.
- UI action must not claim that simply configuring the chat resumed global execution.

## Verification

- Full Node/SQLite regression tests.
- HTTP integration verifies the authenticated, paired extension manual-send route while global STOP remains true.
- Playwright in a **synthetic ChatGPT browser**, isolated SQLite and extension, verifies precisely one physical message reaches the test chat while global STOP remains true; the message equals the saved default macro, and no second message is sent.
- No production ChatGPT messages were sent during implementation or tests.

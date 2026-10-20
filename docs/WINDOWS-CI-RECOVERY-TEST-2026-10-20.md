# Windows CI recovery test — 2026-10-20

## Actual Chrome result: blocked before a normal CI-wait reply

Starting point: PR #70 head `984e68ba1fa8f539dcacd46dbf2aaa66607d91da`,
real Windows Chrome profile `내 Chrome`, live Autopilot extension **0.4.38**, worker
`composer-2026-10-15-r17`, and the existing acceptance SQLite database.

The user explicitly approved two messages in a fresh `codex_ci_recovery` group:
one short seed asking for a CI-wait sentence and one conditional automatic
`계속 진행`. No regeneration was approved. The original `codex_test`, failed
`codex_ci_test`, read-only probe, their registrations and command records were
preserved. No Watchtower Registry or Track attribution was changed.

- Created workstream `ci-recovery-20261020` and enrolled actual physical tab
  `1042919563`, group `502487416`, through the localhost candidate API and the
  extension's independent confirmation.
- Queued the seed once through the product's existing bounded manual campaign.
  Command `5aefe2fc-240b-44a4-8e40-0e9777ee832e` was claimed/sent **once**, attempt 1.
  Its button-click ACK was corroborated by the actual user message in the DOM;
  it is not proof that an assistant response succeeded.
- The same tab became a conversation. Its response displayed
  `이 응답을 불러오지 못했습니다`. After an ordinary reload, the entire thread
  displayed `이 ChatGPT 대화를 불러올 수 없습니다`, with a `다시 시도` button and
  **no composer**. One ordinary conversation-load retry left the same error.
  Neither action regenerated an answer or resent the seed.
- Confirmed the created conversation using the existing same-tab rebind flow.
  Session `a96b7051-5785-4a2f-b712-6cac2370fc09` was preserved. Read-only preview
  request `afb94ad8-c679-437c-880b-5b2fff46f2af` was delivered in **26,773ms**,
  current binding, receipt `RECEIVED / UI_OBSERVED`. On the deployed 0.4.38
  collector this page was generic ambiguous evidence: `assistantBusy=null`,
  `composerHasDraft=null`, `replyFingerprint=null`, `contentComplete=false`,
  `uiAmbiguous=true`, `ciWaitCue=false`. No execution schedule was enrolled.
- Stopped the seed campaign. No second command, automatic continuation,
  regeneration, merge or deployment occurred. The remaining approved conditional
  continuation is unused. The separately approved CI rerun is also unused:
  actual GitHub Run `38357525075` still has Attempt **1**, completed/success,
  SHA `5ce649ca24e4825917d8eabb5a490e6c4cca0cff`. It was not rerun without a readable
  CI-wait response to test against.

The actual console query returned no errors/warnings. CDP Network initialization
was denied while Browser Use was resolving a paused document response. No
alternate access was attempted. Thus this new run has **no captured network
response or service-worker trace** establishing the loading failure's origin.
The visible page error and the product's observation agree that no usable answer
exists. They do not identify whether ChatGPT, its client, or browser integration
caused the failure. It is not an extension observation delivery timeout.

Local ignored evidence under `.autopilot/acceptance-evidence/`:

- `2026-10-20-recovery-seed-intent.json` and `2026-10-20-recovery-seed-command.json`
- `2026-10-20-recovery-actual-boundary.json`
- `2026-10-20-recovery-chat-failure-main.png`

These are actual UI/DOM and localhost receipts, not a native Playwright trace ZIP.

## Code correction and validation boundary

The observation diagnostic missed the standalone **whole-conversation** failure
panel when the composer and all turns were absent. This follow-up introduces
`CONVERSATION_UNAVAILABLE` for the exact visible main-panel text plus retry
control, excluding drafts, transcript/quoted content and sidebar text. It remains
unverified negative evidence, has no reply fingerprint, and cannot authorize a
send, regeneration or click. It is projected through the existing transport and
coordinator into one recovery Inbox request, pausing only that workstream.
Local UI explains the conversation error separately from an observation timeout.

Extension source version is **0.4.39**, with unchanged permissions and worker
protocol. This source update has **not** been loaded/revalidated in the user's
live Chrome; the actual result above is from 0.4.38. Fixing this diagnostic does
not fix the upstream conversation-loading failure or complete CI acceptance.

Regression coverage includes private-field redaction, standalone-panel versus
quoted/sidebar/draft lookalikes, sibling continuation, restart/Inbox deduplication,
and transport receipt versus trust. Isolated Playwright uses owned fixture pages
to exercise the unpacked worker and localhost error UI without sending messages.
It cannot establish actual account recovery.

Windows local `npm run check`: **487/487**. Isolated unpacked-extension
Playwright E2E passed, including the whole-conversation panel and no-command
assertions. Windows/Ubuntu GitHub Actions status is recorded on the follow-up PR.

The next actual acceptance step requires the existing test conversation to become
readable. Then reobserve it, verify an actual CI-wait cue, rerun the approved Run
once, capture the new exact Attempt, and arm only the remaining single bounded
continuation. Pending-to-success auto resume, its next assistant completion, CI
failure/long-wait behavior on real ChatGPT, migration, messenger and 3/10/20-tab
unattended operation remain **unverified**.

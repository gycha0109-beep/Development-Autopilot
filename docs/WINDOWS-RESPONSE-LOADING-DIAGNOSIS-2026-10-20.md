# Actual Windows Chrome response-loading diagnosis — 2026-10-20

This follows open PR #69 (`bbee438b2817daeadd05b09c05744e00aabd20b0`).
The ChatGPT load failure has **not** been repaired, and actual CI-to-chat automatic
resume remains **incomplete**. No new ChatGPT messages/regenerations or CI reruns
were used during this investigation.

## Actual network, DOM and worker evidence

In the morning Windows Chrome test tab `1042919341`, supported CDP Network/Log/
Runtime observation could be enabled. A normal same-tab reload captured the
approved test conversation's existing GET response:

- `/backend-api/conversations/6ad6bfe6-1c80-83ee-b787-5beeec26e16e`: HTTP **200**,
  `application/json`, HTTP/2, `fromDiskCache=false`, `fromServiceWorker=false`.
- No HTTP errors or Runtime exceptions appeared in the retained event window.
  Some unrelated requests were cancelled with `net::ERR_ABORTED`; no evidence
  associates them with this conversation's HTTP 200 response.
- The event buffer reported **truncated=true**. This is a partial capture, not
  proof that every request succeeded or no exception ever occurred.
- `Network.getResponseBody` was denied while Browser Use was resolving a paused
  document response. No alternate protocol/profile/request mechanism was used
  to bypass that restriction, and no response body/credentials were extracted.
- ServiceWorker CDP commands were unsupported. The response metadata above
  establishes only that this particular GET did not come from a service worker;
  it does not establish that no service worker exists.

The actual DOM still displayed **이 응답을 불러오지 못했습니다**, including
after normal page reload and the sidebar's read-only history retry. The composer
was empty and no stop button was present. After explicitly stopping this test
axis's Autopilot observation/execution and reloading the same physical tab, the
same error reappeared. No new observation request or message was armed during
that comparison. The r17 collector's negative result therefore agrees with a
real page condition; a false-positive collector error has not been reproduced.
This does **not** establish whether the underlying cause is ChatGPT server data,
client rendering, browser integration or another component outside the collector.
HTTP 200 alone is insufficient to decide that.

The collector source executes only in an explicitly requested registered tab's
ISOLATED world. It reads bounded DOM state and does not replace page network
handlers or submit messages. Authenticated extension heartbeats and actual
observation replies corroborate worker execution; privileged worker console and
response-body access were not available. No claim of a full native Playwright
trace or complete service-worker inspection is made.

Private evidence under ignored `.autopilot/acceptance-evidence`:
`2026-10-20-loading-network-dom-diagnosis.json`,
`2026-10-20-loading-error-observer-disabled.png`, and
`2026-10-20-before-loading-diagnosis-stop.json`.

## Diagnostic correction

The control page previously displayed **관찰 미허용** while a permitted preview
was actually waiting for a worker reply. It also had no persisted delivery receipt,
so operators could not distinguish a delivered page error from a bridge timeout.

The existing observation scope now gains an additive nullable `receipt` column.
Receipts contain only a server-generated challenge ID, binding identities,
requested/finished timestamps, elapsed milliseconds and allowlisted projected
reason/outcome. They are **diagnostic delivery records, never dispatch proof**.
The snapshot exposes the current process-local pending challenge separately;
restart does not resurrect it. A relink, revision drift, offline or obsolete
worker labels an earlier receipt historical. Existing SQLite events retain
received/timeout/cancelled outcomes without page text, URLs, drafts or tokens.

The UI distinguishes pending delivery, response received, timeout, cancellation
and a page-reported response-load failure. A failed delivery clears the previous
preview so it cannot be reused as fresh evidence. Timeouts and cancellations do
not regenerate, queue a prompt, create a CI success or alter approvals.

## Afternoon continuation and preserved identities

At the 15:09 KST continuation the earlier local server process was no longer
listening and the original test tab was absent from actual Chrome inventory.
The server was restarted on the **existing** acceptance database. The extension
automatically reconnected without Reload, reporting r17, with the old sessions
`needs-rebind`. Their mappings were **not** pointed at a different physical tab.

The same existing test conversation was opened read-only in new actual Chrome
tab `1042919561`, window `1042919446`, isolated group `codex_ci_probe` (`9726726`).
The response-loading error was still visible. To validate the new receipt path
without replacing either old registration, a separate observation-only Workstream
`ci-loading-probe-20261020` was created and registered by normal discovered-tab
intent `7e03684b-6cff-48bc-9a64-b427bbb4ad00`. It has no message configuration,
execution schedule or commands. Original `codex_test` / `codex_ci_test` registrations,
two/one sent commands and failure records remain; no Registry/Track attribution
was edited. Opening this tab is **not** restoration of the original physical tab.

A real read-only challenge showed **Chrome 관찰 응답 대기 중** in the actual
localhost Chrome UI, with independent request and expiry times. Its final receipt
was **RECEIVED / ASSISTANT_RESPONSE_UNAVAILABLE**: request
`bfc04c14-a006-4dce-b6b1-f0868710d1bf`, requested at 15:13:43 KST, received at
15:14:37 KST, **54,733ms** round trip, exact current binding. This proves the
live worker delivered an error observation; it is not a bridge timeout. The
projected observation remained `verified=false`, with challenge issuance as
`observedAt`. A real activation attempt returned HTTP 400
**AUTOPILOT_FRESH_PREVIEW_REQUIRED**. Probe commands remained **0**, the original
workstreams retained **2/1**, and no schedule was created. Evidence:
`2026-10-20-actual-delivery-receipt.json` and
`2026-10-20-actual-delivery-guard.json`. The actual localhost UI also displayed
the received timestamp/latency and the page-error explanation; see
`2026-10-20-actual-delivery-ui.png`. A subsequent real server restart preserved
the same receipt and negative observation, with pending=null, no schedule and
no new commands (`2026-10-20-delivery-after-server-restart.json`).

CI Watchtower was unavailable in the afternoon. Automatic approval review rejected
the shell command containing its known installed executable launch with
`blocked by policy`, without a more specific reason. The executable was then
confirmed to still exist at `C:/Users/M/Downloads/ci-watchtower-windows/ci-watchtower.exe`,
version 0.3.39, with the exact previously verified SHA-256
`59120a61a4eb244f000bf676f79261a3d0a0cc549f8dc9236e3345073455a792`.
After the user's correction, a single-purpose launch of that verified file through
the same shell tool was allowed, without installation, alternate access, arguments,
credentials or settings changes. Process 15744 started, and the authenticated
Autopilot refresh returned connected / contract 1.0 / the unchanged Registry.
No manual launch was ultimately needed.

Actual Watchtower and GitHub revalidation corroborated the existing `ops` target:
repository `gycha0109-beep/CI-Watchtower`, PR 65, head
`5ce649ca24e4825917d8eabb5a490e6c4cca0cff`, Run 38357525075, **Attempt 1 SUCCESS**,
merged confirmed and required checks verified. The normal phase gate remained
WAIT_HUMAN, with executionAllowed=false; no review or continuation approval was
fabricated. This is a restored success baseline, **not** evidence of the requested
pending-to-success automatic resume. Details:
`2026-10-20-watchtower-relaunched-exact-baseline.json`.

## Validation and remaining work

Windows `npm run check`: **484/484**. Regressions cover delivered negative page
evidence versus timeout, stale-preview invalidation, duplicate/late upload refusal,
private-field redaction, additive old-schema migration, restart/cancellation,
binding drift and independent sibling reads. Isolated unpacked-extension Playwright
E2E passes and verifies the receipt/error UI with no commands. It uses intercepted
fixture pages and is **not** actual ChatGPT acceptance.

The actual ChatGPT response must become readable before CI-wait detection and
conditional automatic continuation can be evaluated. The approved CI rerun and
automatic continuation remain unused; the earlier one approved regeneration is
already consumed. No additional generation, new seed, retry, merge or deployment
was performed here.

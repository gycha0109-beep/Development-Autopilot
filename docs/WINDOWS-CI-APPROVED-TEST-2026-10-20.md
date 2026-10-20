# Approved actual Windows CI test — 2026-10-20

## Authorization and preserved identities

The user approved one rerun of CI-Watchtower Run `38357525075` and two ChatGPT
messages total: one seed and one automatic `계속 진행`, in a new `codex_ci_test`
group. Official GitHub CLI authentication completed under the user's account.
No token was extracted or persisted by the test. Watchtower Registry/attribution and
the original `codex_test` workstream/registrations/two-message history were preserved.

New isolated test identities (private snapshots also retained under ignored
`.autopilot/acceptance-evidence`):

- Workstream `ae9abbfb-21b1-4683-a67d-d36f340f76ac`, project `ci-watchtower`,
  repository `gycha0109-beep/CI-Watchtower`, existing canonical Track `ops`.
- Actual Chrome tab `1042919341`, window `1042919254`, new group `codex_ci_test`.
- Session `dfc2a28e-f2f4-47ff-9c11-1c30f166596b`; explicit created-chat rebind used
  the same physical tab, session and Workstream. No legacy registration was repointed.
- Chat URL `https://chatgpt.com/c/6ad6bfe6-1c80-83ee-b787-5beeec26e16e`.

## Actual failure reproduced

The seed requested a short CI-wait test response, with no code/tool/network actions,
then one short response if a future `계속 진행` arrives. The seed command
`9acfa23d-1d91-48a2-b1f2-b7b4842aed40` was sent once with attempt 1. ChatGPT
created one user turn, but the actual assistant UI displayed
**`이 응답을 불러오지 못했습니다`**. Reloading the same empty-composer tab
did not restore the answer. No regeneration or second message was attempted.

The extension's real observation incorrectly reported that placeholder as
verified UI_OBSERVED / assistantBusy=false / contentComplete=true / uiAmbiguous=false,
with a reply fingerprint. The current renderer had normal assistant-ID boundaries and
`data-talvt-turn-state=complete`, and no alert banner. This is a reproducible collector
defect: the error could become stable-answer evidence in an armed campaign.
The test had **not** armed automatic progression, so no unsafe continuation occurred.

Actual evidence: `2026-10-20-ci-seed-command.json`,
`2026-10-20-real-unavailable-response-observation.json`,
`2026-10-20-before-unavailable-guard.json`,
`2026-10-20-real-ci-response-unavailable.png`.
CDP network diagnostics were unavailable while Browser Use was resolving a paused
document response. No alternate access mechanism was used to bypass that restriction.

## Correction and acceptance boundary

Extension v0.4.37 / worker build r17 rejects exact response-load-error placeholders
before producing an answer fingerprint. Korean and English placeholders are covered;
quoted/code examples and narrative mentions are not mistaken for error UI. The server
preserves only the allowlisted negative reason ASSISTANT_RESPONSE_UNAVAILABLE.
An armed coordinator opens one recovery Inbox item and pauses only that axis.
It does not regenerate, queue a prompt or spend a send budget. Read-only preview and
queue/claim require the current worker build, so the old collector cannot be reused.

Local Windows `npm run check`: 476/476 passed. Collector and orchestration regressions
verify no stable answer, no send, one local Inbox, restart behavior and sibling isolation.
The actual load path `D:/cha/Development-Autopilot/extension` received v0.4.37 after
checking all changed destination files against the previous source baseline. The
development server runs the new guard on the existing DB. Actual Chrome extension
Reload and post-fix actual collector acceptance are still pending; unit tests are not
reported as that acceptance.

The new test's observation/execution permission was stopped through the normal API.
The original failure/send records remain. At this boundary the approved CI rerun and
automatic continuation are both **unused**. Actual CI wait -> pending -> success ->
automatic continuation -> next response is **NOT COMPLETED**.

Further provider response regeneration consumes additional model usage and is outside
the approved seed+continue scope. It requires separate approval. No PR was merged and
no repository policy or Watchtower Registry was changed.

## Follow-up: approved regeneration and confirmed-chat Reload defect

The user subsequently confirmed actual Windows Chrome Reload of v0.4.37 and
approved one regeneration. The authenticated production bridge advertised
`composer-2026-10-15-r17` on a fresh heartbeat, proving the upgraded worker was
running. Both retained links became `needs-rebind`, as expected for a new epoch.
However, `codex_ci_test` had zero discovery candidates despite the same physical
tab and URL still being open. This was a second code defect: discovery only
accepted a landing-to-created-chat transition, excluding Reload after that
created URL had already been explicitly confirmed.

Using the actual test tab's normal **응답 다시 생성 → 다시 시도 · 6 Thinking**
control, the approved single regeneration was performed. The UI showed
**ChatGPT가 응답 중입니다** with a stop button, then completion with the same
**이 응답을 불러오지 못했습니다** placeholder. No second regeneration or
new user message was attempted. Browser console error/warn capture returned no
entries; a screenshot attempt timed out. No unavailable network diagnostics
were bypassed. The post-regeneration accessibility state and independent server
snapshot are retained privately as `2026-10-20-approved-regeneration-result.txt`
and `2026-10-20-after-approved-regeneration.json`. The underlying ChatGPT response
load failure remains unresolved; its cause is not established by empty logs.

Extension v0.4.38 offers **explicit same-chat epoch recovery** when the URL is
identical and clean, the tab/group/window are unchanged, and the stale group has
only one registered member. The server additionally requires the latest completed
registration intent to prove that same URL and physical identity for the linked
Workstream. Pending/failed intents do not authorize recovery. Changing chats,
query/hash variants, ambiguous or paused registrations, mismatched epochs and
navigation races remain blocked. Existing session IDs/history are retained, and
the existing rebind hooks revoke old observation/execution consent. Recovery does
not authorize a message or silently revive a schedule.

Local Windows `npm run check`: **480/480**. Isolated Playwright regression now
clears the disposable extension's session storage a second time **after** its
created-chat confirmation, then uses localhost UI to restore that exact session
and proves send authority remains disabled, no commands are created and 20 stale
sibling registrations stay stale. This is isolated coverage, not actual Chrome
recovery acceptance. The actual load path received v0.4.38 after checking all
changed destination files against v0.4.37.

After the user confirmed v0.4.38 Reload, an actual extension heartbeat published
the same `codex_ci_test` physical tab as a candidate with identical current and
previous URL hashes and a fresh epoch hash. The actual Chrome localhost UI's
**이 탭의 기존 대화 확인·재연결** button created intent
`d03d29e4-538a-44a9-b7bc-9dd5b96cad46`. The extension independently checked and
acknowledged it, restoring the original Workstream/session to **connected** at
10:33:58 KST. The original `codex_test` remained paused/needs-rebind, its two sent
commands were preserved, and the new test still had only its one sent seed.

A fresh read-only preview traversed server challenge -> actual r17 Chrome
observer -> authenticated bridge -> persisted scope. The returned observation
was **verified=false / ASSISTANT_RESPONSE_UNAVAILABLE**, without a reply
fingerprint or trusted completed content. The preview's `observedAt` is challenge
issuance (10:34:07 KST), not receipt time. An actual runtime-configure request
was rejected with HTTP 400 **AUTOPILOT_FRESH_PREVIEW_REQUIRED**. The schedule
remained null, message configuration disabled and command count unchanged.
No automatic progression was armed. These real recovery/error-guard results are
recorded in `2026-10-20-real-reload-rebind.json`,
`2026-10-20-real-reload-error-guard.json`, and the actual localhost screenshot
`2026-10-20-real-reload-error-guard.png`.

PR #69 implementation commit `595137fd1fdb314bf6181fc5d2fef8164bc25d04`
passed [Windows and Ubuntu CI, including isolated extension E2E on both](https://github.com/gycha0109-beep/Development-Autopilot/actions/runs/39353906643).
That isolated CI result is separate from the real Chrome checks above.

The CI rerun and automatic continuation are still **unused**; regeneration is
**used once**. The test remains stopped, original `codex_test` and Watchtower
Registry remain intact, and the full actual CI-to-chat resume flow is incomplete.

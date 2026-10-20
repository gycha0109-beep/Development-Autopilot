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

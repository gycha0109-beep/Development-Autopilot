# ChatGPT DOM compatibility and Writing Block migration

Report date: 2026-10-22 (KST). Read-only actual Chrome survey: 2026-10-21.
Base: PR #78 `7ab11e4` → PR #77 `b8cb2eb` → PR #76 `31ab4f2`.
All remain unmerged; this work neither merges nor rewrites that stack.

## Evidence categories and privacy

| Category | Evidence | Boundary |
| --- | --- | --- |
| A — actual ChatGPT | Supported extension-backed browser tool, logged-in Windows Chrome; structural survey of an existing project chat | Read-only; zero messages, reloads, clipboard reads, renames or changes to existing user tabs |
| B — observed DOM simulator | Current turn/message identity boundaries and Writing Block card/editor boundary reproduced in the localhost simulator | Real MV3 extension and local engine, disposable profile/SQLite; synthetic content |
| C — synthetic scenarios | Length warning, authoring response, new-project editor, copy event, rename UI, errors, CI HTTP fixtures, restart/fault races | These behaviors were not freshly exercised against ChatGPT |
| D — unverified | Live authoring, copy behavior, same-tab project creation, transfer, first reply, N+1 rename and resumed live development | No active scoped message approval; no claim of actual migration success |

No private conversation text, URL identifiers, titles, cookies, tokens, clipboard
contents or authenticated profile files are included in this report or CI artifacts.
REA/CDP access to the existing authenticated profile was unavailable in the prior
survey. The supported read-only browser bridge was used; no profile restart/copy
or security-policy bypass was attempted. [REA research and prior evidence](CHATGPT-SIMULATOR.md).

## Fresh structural observations (A)

The sampled project conversation contained eight current message units and two
Writing Blocks. Each card had:

- `div[data-testid="chatgpt-writing-block"]`.
- A `.writing-block-editor` wrapper and exactly one descendant
  `[contenteditable="true"][role="textbox"][aria-label="작성을 시작하세요"]`.
- The two owned editors had 67 and 60 paragraph nodes, respectively. Their body
  text was not extracted or saved. They were outside the composer form.
- Copy (`복사`) and open-editor (`편집기 열기`) buttons in the bounded card;
  their click behavior was **not** exercised.
- An enclosing assistant search unit, `data-chatgpt-selection-message-id`,
  `data-dil-source-message-id` and `data-dil-message-id`. The search-unit message
  ID agreed with selection ID; the card was within both source/body boundaries.
- Enclosing `data-talvt-turn-state="complete"`.

The conversation also had one separate `form[data-chatgpt-composer]` containing
its own textbox; its editor had no ID in this sample. One project landing link
with route shape `/g/<project>/project` existed. Actual transition/creation,
rename-menu internals, N+1 behavior and session rebind were not exercised.
The October 22 accessibility snapshot also showed a named project URL alongside
sidebar links using the shorter project-ID route. These route aliases and the
current sidebar chat-action menu have not been exercised through live creation
and rename. Production guards still require exact project/session authority; this
PR does not claim that the simulator's simpler project routes close that gap.
Generated CSS class suffixes are not used as selectors. Only the observed stable
`writing-block-editor` token and card test-id are used for the new body boundary.

A second read-only sample on 2026-10-22 showed five current turns, one composer,
`data-talvt-turn-state="in_progress"`, and a Korean `중지` button inside that form
without a test-id. It contained no Writing Block. Stop execution against that
variant remains unverified. Its observed label is now additional negative evidence
in migration readers: a visible active Korean Stop button blocks capture/target
completion even if a contradictory turn claims complete. No new Stop-click path
or relaxed execution permission is introduced.
The earlier Writing Block observations above are not relabeled as October 22.
A separate temporary read-only investigation tab was opened for that existing
conversation; follow-up inspection was blocked by an unattached debugger after
the browser bridge reconnected. Its load outcome was not counted as DOM evidence.

## Implementation and remaining gaps

The prior reader relied on legacy role attributes or an operator recovery path
that paired markers by bounded proximity. Current capture now proves the latest
turn, unique user/assistant units, agreement of all three assistant message-ID
boundaries and complete turn state. A failed modern proof cannot fall through to
the legacy reader. The original authoring request must contain the exact marker,
repository, track and required instructions; unchanged baseline IDs are refused.

Only one Writing Block within that owned assistant body is accepted. The entire
owned editor text is captured, excluding toolbar text. Missing/duplicate cards,
multiple editors, hidden descendants, streaming, oversized/short content,
wrong repository/track and absent/duplicate markers fail closed. Two identical
full-body samples at least six seconds apart remain mandatory. Current target
verification independently binds the first normal reply to its assistant ID and
completion state, then existing resume proof requires fresh ordinary observations.
The generic observer deliberately continues to hold responses containing editable
Writing Blocks; this PR does not weaken normal completion/draft safety gates.

The modern identity checks are repeated inside three serialized page entry points
because `chrome.scripting` does not carry imported lexical helpers into the page.
Regression coverage executes the generated production functions in the MV3
isolated world, rather than a separately reimplemented classifier.

The simulator now renders the observed Writing Block boundary and explicit
project-new-chat renderer selection. `POST /simulator/api/projects/<project>`
with `{"renderer":"current"}` or `{"renderer":"legacy"}` controls this choice
and persists it. Project creation/rename/copy are still synthetic behavioral
contracts, not independently confirmed live UI replicas. Logical composer line
serialization preserves blank lines; plain `innerText` on native DIV/BR input
previously added an extra blank line. Exact transfer assertions caught that bug.

Migration failures now report a fixed, authenticated, session-scoped Inbox
request using the existing paused migration checkpoint. The request deduplicates,
pauses only that workstream, never resumes/spends approval, and sends no page text.
If delivery fails, later ticks retry only this idempotent report, never UI actions.
A failure before an associated durable checkpoint cannot be reported by this route.

## Independently checked migration steps (B/C; all live steps D)

| Step | Assertion in isolated MV3 suite |
| --- | --- |
| 1. Detect limit | Synthetic warning triggers existing enabled watcher |
| 2. Author once | Exactly one source message containing author marker |
| 3. Capture document | Current IDs + unique Writing Block, complete state, full text, stability |
| 4. Create same project/tab | Original physical tab ID/group retained; exact project route |
| 5. Transfer once | Exactly one target message equal to captured rendered document |
| 6. First reply | Target assistant completes and current ID fingerprint stabilizes |
| 7. Rename | Target title equals original numeric suffix N+1 |
| 8. Restore link | Original workstream/session key and sibling links retained |
| 9. Preserve authority | Original approval timestamp/expiry/max count/sent count retained |
| 10. Resume gate | Existing independent resume proof restores schedule; fresh observation required |

The mixed 20-axis suite also migrates an existing previously-generating axis,
then restarts server and browser/extension. Browser restart retains records but
requires explicit physical-tab rebind, with zero automatic replay. This safe hold
is expected, not an unattended reconnection claim. Different projects are covered
by existing route/identity negative tests; the full 20-axis browser run uses one
synthetic project with independent sessions.

## User-provided warning screenshots (2026-10-22)

These are supplied visual evidence, not independently inspected DOM:

- Length: `이 대화의 최대 길이에 도달했으나,새 채팅을 시작해 계속 이야기할 수 있습니다.`
  with `새 대화 시작`. Author the handoff in the source first; do not click that
  button as a shortcut before source capture/provenance verification.
- Disconnect: `연결이 해제되었습니다. 전체 답변을 기다리는 중입니다.`
  means the verified Stop → one fixed status-report request → completed report
  → conditional continuation path. It is not a length warning or automatic reload
  instruction. The existing report text remains `현재까지 진행한 작업과 남은 작업을 보고해줘.`.

The simulator and legacy fixture now use the exact supplied length sentence.
Regression tests keep the two warning branches distinct and reject screenshot
warning quotations inside modern user/assistant units. The latter closed a real
compatibility gap in the older length reader's legacy-only transcript exclusions.
Screenshots do not prove alert roles, button ownership or copy/Stop behavior;
those remain synthetic or unverified until independently observed. No screenshot
attachment, private conversation body or account identifiers are committed.

## Reproduction and result locations

```
npm ci
npm run check
npm run test:e2e
npm run test:simulator
npm run test:simulator:migration
npm run test:simulator:modern-migration
# Fast reproduction: an already enrolled axis must retain its live registration.
node e2e/simulator-browser.mjs --existing-migration
```

On Ubuntu install Playwright Chromium and use `xvfb-run -a` for headed MV3 suites.
Windows local runs use disposable Microsoft Edge MV3 profiles (not Google Chrome);
actual logged-in Google Chrome is category A only. Production domain restrictions
remain intact; generated test runtime permits exactly its loopback simulator.

Ignored artifacts under `.autopilot/e2e-artifacts/`: separate
`simulator-results.json`, `simulator-migration-results.json`,
`simulator-modern-migration-results.json` and their Playwright traces. JSON records
`actualChatGPT:false`. CI uploads only these synthetic profiles' evidence for seven
days. Results and CI run links are recorded in the PR; pending checks are not passes.

**Completion boundary:** DOM structural compatibility and isolated migration can
be verified here. Actual latest-Writing-Block automatic migration remains D until
a separate explicit live test allowance exists. Existing real registrations,
SQLite, approval history, installed extension and running production server were
not modified by these isolated tests.

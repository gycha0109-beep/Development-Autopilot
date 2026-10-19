# Current ChatGPT response DOM — 2026-10-19 Windows investigation

Parent: PR #60 `feat/localhost-created-chat-rebind`. Extension: 0.4.35.

The approved seed was sent exactly once by the registered extension worker on the real Windows Chrome test tab. ChatGPT produced a short completed reply. Inspection of that test response showed no `data-message-author-role` or `data-message-id`; the empty composer showed a voice control rather than a send control. The legacy observer therefore could not establish completion.

The new collector requires a last visible assistant unit within the last conversation turn, matching message IDs across the unit, selection boundary, source boundary and rendered response body. It also requires the explicit turn state `complete` and a unique thread composer. Existing selectors remain supported. Unknown layouts, unanswered user units, mixed renderer evidence, differing IDs, missing completion state, hidden content and drafts do not authorize continuation. Actual streaming state is never inferred from text alone.

The updated read-only collector was run via the supported ChatGPT tab CDP surface against the actual approved test response. It returned `verified=true`, `contentComplete=true`, `assistantBusy=false`, `composerHasDraft=false`, `uiAmbiguous=false`, with no CI/human/error cue. It returned only flags and fingerprints, with no body, URL or draft. This direct collector check is distinct from the extension-to-server observation pipeline and is not proof of a completed unattended loop.

Tests cover two fresh unchanged samples, message-ID conflicts, missing/streaming/unknown state, latest unanswered user turn, unowned/duplicate composers, drafts, mixed renderers, CI/human cues and quoted warnings. The isolated unpacked-MV3 E2E also reads a current-renderer fixture through the extension's actual observation request path. Fixture results are not real ChatGPT acceptance.

Real acceptance still needs the updated extension loaded, explicit same-tab created-URL confirmation from PR #60, fresh observation/send consent, then at most one approved `계속 진행` and confirmation of the next assistant response. The first seed has already consumed one of the user's two approved sends. The seed must never be replayed.

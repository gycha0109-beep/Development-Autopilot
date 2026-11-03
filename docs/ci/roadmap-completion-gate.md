# Roadmap completion and per-chat stop (Autopilot 0.8.10)

## Project instruction protocol

In ChatGPT project instructions, define the currently approved roadmap
and require ChatGPT to print an unquoted, standalone paragraph exactly
ROADMAP_COMPLETE only if it believes all required items are finished.

Autopilot treats that declaration as a request to audit, never direct
proof of completion. General prose, code blocks, user input and citations
containing ROADMAP_COMPLETE do not activate the audit.

Autopilot sends exactly one final audit prompt, which directs ChatGPT to
review the current project instructions and approved roadmap, code,
testing, documentation, handoff and recent CI. ChatGPT must report
evidence for each required item in the normal body and finish with these
three standalone, unquoted paragraphs (not inside a code block):

ROADMAP_AUDIT: COMPLETE

ROADMAP_AUDIT_SCOPE: [the actually reviewed, approved roadmap/version]

ROADMAP_AUDIT_CI_SHA: [the checked 40-char lowercase Git commit SHA]

For missing tasks, report ROADMAP_AUDIT: INCOMPLETE; for uncertainty,
required approvals or missing evidence report ROADMAP_AUDIT: BLOCKED.
A result is only interpreted for the new reply to the single queued
audit, not an earlier or quoted answer.

## Auto-completion gates

1. The exact assistant reply declaration and final audit result come from
   the last verifiably completed assistant DOM message within the
   registered ChatGPT tab. No transcript text is sent back to Autopilot.
2. The candidate and audit result each remain identical across two
   observations at least 30 seconds apart; a server restart invalidates
   earlier observation stability.
3. The configured GitHub repository and explicit CI branch are
   required for autonomous completion. CI Core and WatchTower are
   optional; the independent authenticated GitHub CLI is used.
4. The latest selected CI runs must be fully SUCCESS on one HEAD SHA.
5. A separate read-only GitHub API lookup of that branch's actual
   current commit must match the CI SHA. Missing, stale or inconsistent
   evidence prevents completion.
6. The audit report's CI SHA must equal the originally queued audit
   SHA and the current GitHub branch/CI SHA. Changes between audit
   preparation, browser dispatch and audit completion are rejected.
7. Unreadable or incomplete audit reports cannot authorize completion.
   The user-approved scope is reported by ChatGPT; Autopilot does not
   independently prove all domain-specific requirements solely from
   a language-model response.

After all gates pass, set only the associated macro session to
enabled=false, status=completed, reason=ROADMAP_COMPLETE_VERIFIED;
persist the audit reply fingerprint, CI SHA and run identities, and
optionally emit a one-shot completion notice if alerts were already
opted in. Other chats, global stop, CI settings and Workstreams are
untouched. The session will not issue more prompts after restart.

INCOMPLETE deletes the audit phase and resumes existing-scope work
only after the normal interval and fresh-response requirements.
BLOCKED, missing result, missing scope, CI HEAD drift or unknown
submission pauses only this chat with an operator-visible reason.

An explicit new operator opt-in can start a new roadmap cycle and clears
the prior completion record. Auto-migration does not silently restart
a completed session.

## Validation

- Browser parser rejects quoted/duplicate/incomplete markers and
  keeps project text private.
- State-machine regression verifies single audit, 10-minute cadence,
  incomplete/blocked handling, unrelated chat continuity, full STOP,
  red/queued/unavailable CI, GitHub branch-tip drift, claim-time
  changes and persistence through process reinitialization.
- This is an automatic operational stop criterion with corroborated
  GitHub CI evidence; it is not independent formal verification of
  every semantic roadmap requirement.

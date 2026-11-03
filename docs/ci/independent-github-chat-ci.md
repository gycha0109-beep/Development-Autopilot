# GitHub CI for registered chats, independent of CI Core

Autopilot server 0.8.9 and Chrome extension 0.4.54.

## System behavior

A registered and explicitly approved ChatGPT chat can select a GitHub repository
and an optional branch under its own ten-minute-or-other configured interval.
GitHub CI observation uses the current Windows user's existing GitHub CLI login
and read-only GitHub REST Actions endpoints. CI Core, WatchTower and a separate
Workstream are not required. The old CI Core decision gate remains unchanged.

- Poll only repositories with enabled, automatic macro sessions, at most once
  per 60 seconds. The chat interval is a separate minimum time between sends.
- For each selected branch, consider only workflow runs on the most recent HEAD.
  Superseded attempts and older failed commits cannot authorize new RED prompts.
- If more than one contemporary branch HEAD appears and no branch is configured,
  mark the repo ambiguous and do not issue RED or GREEN macros.
- RUNNING/QUEUED or uncertain CI => wait without a normal continuation.
- FAILURE => require the GitHub Actions workflow-run result AND an independent
  read of the most recent workflow jobs with matching run ID, SHA and failed
  conclusion; then send an investigation/fix/retry prompt once, only if the
  Chrome editor and exact chat identity are independently verified.
- SUCCESS => normal continuation is allowed only after the chat's configured
  minimum interval and a stable, completed response; never merge PRs or elevate
  permissions automatically.
- Offline GitHub CLI, unavailable run jobs, stale observations, missing data,
  global STOP, unsafe editor or ambiguous branch => fail closed.
- A failed GitHub read does not display an authentication token or raw stderr.
- Read-only Action API calls do not mutate GitHub state.
- Direct CI Core evidence still takes priority if installed and observed.
- The browser extension's branch field is optional, but recommended for
  multi-branch repositories like Saju.

## Evidence

The academy PC authenticated GitHub CLI read the real repository
gycha0109-beep/Saju with branch feat/saju/reading-coverage-seven-stage.
Its contemporaneous workflow runs were RUNNING, so no RED or regular
continuation should be sent.

Unit and integration tests cover success, running, verified RED, missing jobs,
branch ambiguity, earlier HEAD failure, ten-minute interval, no Workstream,
invalid branch and no authentication. Real ChatGPT chat registration was not
performed because its page is inaccessible to the current browser access tool.

## Operator safety

Do not bypass a browser security restriction through local OS, CDP, alternate
browser or inferred session IDs to enroll a ChatGPT page. Enrollment and
per-chat opt-in require an authorized browser extension user action.
Do not lift the existing global STOP without separately verifying the scoped
chat and impact on all other existing automations.

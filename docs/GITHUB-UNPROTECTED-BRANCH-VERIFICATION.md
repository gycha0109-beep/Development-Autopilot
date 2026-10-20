# Explicit unprotected-branch verification

2026-10-20, follow-up to PR #66. After the user completed official GitHub CLI
authentication, the real CI-Watchtower PR #65 still returned REQUIRED_CHECKS_UNVERIFIED.
Actual GitHub data: `branches/main` returned `protected=false`,
`protection/required_status_checks` returned **404 Branch not protected**, and
`rules/branches/main` returned `[]`. This is distinct from the earlier anonymous 401.

The CLI now retains only a sanitized REST 404 error category. Authentication errors,
network errors, response bodies and stderr are not surfaced. A missing protection
document remains unknown unless the verifier independently obtains:

1. A categorized 404 from required-status-check protection.
2. Exact branch name and `protected=false` before rechecking policy.
3. A second categorized 404 and a second empty Rules response.
4. Exact branch name and `protected=false` after that recheck.

Missing/changed metadata, nonempty/missing/changing Rules, 401/403 and second-read
errors remain UNKNOWN. Existing required-check coverage, exact PR/SHA/Run/Attempt,
merge state, conditional consent and bounded message limits are still required.
No repository protection or Rules configuration is changed.

The production authenticated GitHubCLI/GitHubVerifier path against actual
CI-Watchtower PR #65 / SHA `5ce649ca24e4825917d8eabb5a490e6c4cca0cff` /
Run `38357525075`, attempt 1 now returns MERGED_CONFIRMED, NO_REQUIRED_CHECKS,
requiredChecksVerified=true and safeToAdvance=false. The explicit policy source is
recorded as EXPLICITLY_UNPROTECTED_BRANCH_AND_EMPTY_RULES. This observation alone
does not authorize a prompt, merge or phase completion.

Local Windows `npm run check`: 473/473 passed. Regression tests cover both valid
unprotected proof and permission, metadata, policy-race and error cases. Actual
CI-to-ChatGPT acceptance is recorded separately after its approved execution.

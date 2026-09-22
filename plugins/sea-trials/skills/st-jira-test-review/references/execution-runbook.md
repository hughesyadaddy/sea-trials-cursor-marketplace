# Execution runbook for one card

Given to every test worker together with the card text and the exact
commands from the repo's conventions file.

## Classify each acceptance criterion

| AC looks like | Check type | Evidence to capture |
| --- | --- | --- |
| Names a command, "exits 0", "passes" | command | exit code, last 20 lines of output |
| "Given ..., when I tap/click/open ..., then ..." | UI step | screenshot after the "then", plus the platform |
| "file exists", "class has", "exported from" | code read | path and line range, quoted |
| Mentions a query, table, or API response | data | the query or request and its literal result |
| Cannot be checked with the above | unverifiable | mark as such; this is a card defect, not a test result |

## Run order

1. Test plan commands from the card, verbatim, in the worktree.
2. Command-type AC.
3. Code-read and data AC.
4. UI-step AC on the platform the card names. If the card names no
   platform, use the repo's default from the conventions file and
   say so in the comment.
5. Regression: the repo's smallest full check named in the
   conventions file (unit tests for the touched package, or lint plus
   typecheck). One run per branch, shared across cards on it.

## Environment rules

- Only the worktree path. Never `cd` into the user's checkout.
- Never run two E2E or simulator sessions at once; the parent caps
  workers at 3 and cards that need a device run one at a time.
- Time-box each command at 15 minutes. A timeout is
  `NEEDS DISCUSSION`, not a fail.
- Never modify code to make a check pass. If a one-line fix is
  obvious, describe it in the comment.

## Reading dev comments first

Before marking any AC failed, read the card's existing comments. A
developer note such as "moved the service to X because Y" is a
different approach, not a fail, when the behaviour matches. Quote the
note in the QA comment when it changed your verdict.

## Screenshots

`/tmp/qa/<KEY>/<n>-<short-label>.png`, one per UI-step AC, plus one
for each failure state. Name the platform in the comment. Attach via
REST when credentials exist; otherwise leave the paths in the return
block and the parent decides.

## Return block

```text
KEY: <KEY>  BRANCH: <branch>  WORKTREE: <path>
| # | AC (first 60 chars) | Check | Result | Evidence |
| --- | --- | --- | --- | --- |
| 1 | ... | command | pass | exit 0 |
| 2 | ... | UI | FAIL | /tmp/qa/<KEY>/2-share-sheet.png |
TEST PLAN: <command> exit <n>; ...
REGRESSION: <command> exit <n>
VERDICT: PASS | PASS (different approach) | FAIL | NEEDS DISCUSSION
REPRO (on FAIL): numbered steps, expected, actual
DEV NOTES CONSIDERED: <quoted or none>
```

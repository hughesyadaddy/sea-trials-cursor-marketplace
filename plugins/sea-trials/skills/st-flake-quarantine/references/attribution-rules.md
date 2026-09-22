# Attribution rules

How `flake-quarantine.mjs classify` decides whether a red CI job is
caused by the PR, and which tests may never be quarantined regardless.

## Inputs

| Input | Source |
| --- | --- |
| Failing checks | `gh pr checks <n> --json name,bucket,state,link,workflow`, filtered to the `PR Checks` workflow (`filterPrGateChecks`); buckets `fail` and `cancel` |
| Run and job id | Parsed from the check `link` (`/actions/runs/<run>/job/<job>`) |
| Job log | `gh run view <run> --log-failed [--job <job>]` |
| PR diff | `git diff --name-only origin/<baseRefName>...HEAD` (base from `gh pr view`) |

## Log parsing

1. Strip ANSI, the `job<TAB>step<TAB>` prefix `gh` adds, and ISO
   timestamps.
2. Test files: any token ending in `_test.dart` or `.test.mjs`. The
   GitHub runner workspace prefix (`/home/runner/work/<repo>/<repo>/`)
   is removed. Absolute paths that are not under the workspace are
   dropped.
3. Test names: Dart lines ending in `[E]` (`00:03 +12 -1:
   test/x_test.dart: group name test name [E]` → `group name test
   name`); `node:test` spec lines starting with `✖` (duration suffix
   removed; the `✖ failing tests:` header is ignored).
4. Excerpt: up to 40 lines starting 5 lines before the first
   `[E]` / `✖` / `Expected:` / `Actual:` / `Exception` / `Error:`
   marker. Used in the issue body only.

## Path resolution

`flutter test` runs from the package directory, so logs usually say
`test/foo_test.dart`, not `flutter/packages/x/test/foo_test.dart`.
Each parsed path is resolved:

1. Exists at `$ACTIVE_ROOT/<path>` → keep.
2. Else `git ls-files --full-name -- '*/<path>'` with exactly one hit →
   use that repo-relative path.
3. Else **unresolved**: excluded from attribution and listed in
   `unresolvedFiles[]`.

## Attribution decision (in order)

| # | Condition | `attributable` | `reason` prefix |
| --- | --- | --- | --- |
| 1 | No resolved test file | `true` | `no test files found…` / `no log test path could be resolved…` |
| 2 | A resolved test file is in the diff | `true` | `test file changed in this PR:` |
| 3 | A resolved test file's package root is the package root of any changed file | `true` | `package changed in this PR:` |
| 4 | Otherwise | `false` | `none of N failing test file(s) or their packages appear in the PR diff` |

Package root = nearest ancestor holding `pubspec.yaml` or
`package.json`; without a filesystem, the `flutter/{apps,packages}/<x>`
prefix; otherwise the file's directory.

Rule 1 is deliberate. The loop must not quarantine what it cannot
locate; an unparsable log is a real failure until a human reads it.

The decision is one-directional: `attributable: false` means "the diff
did not touch this test or its package", not "this test is flaky".
Flakiness still needs the Phase 3 retry to pass.

## Never quarantine (Phase 2 hard rules)

| Rule | Check | Why |
| --- | --- | --- |
| Attributable | `attributable: true` | The PR changed the code under test |
| Touched file | test file in `changedFiles` | Even a formatting change to a test makes it the PR's problem |
| Cap | `ledger` shows 2 active quarantines for this PR | Skips compound; a third needs a human |
| Protected | path or test name matches one of the patterns below | Correctness and revenue surfaces are fixed, never skipped |
| Not a test failure | compile / analyzer error, whole-job timeout, runner or network error | Re-run or fix; a skip would not change the outcome |
| Local failure | any red local gate lane | The code is wrong; this skill is for remote-only red |

Protected patterns (case-insensitive, matched against every
`testFiles[]` entry and every `testNames[]` entry; reported in
`protected[]`):

```text
integration_test/   scenario_   golden   security   \bauth   payment   billing
```

The `quarantine` subcommand refuses a protected `--file` / `--test`
outright. `--force` exists for a human operator only; the skill never
passes it.

## Cap accounting

`activeQuarantinesForPr(ledger, pr)` counts `quarantine` entries for
the PR minus later `unquarantine` entries with the same `file::test`
key. The ledger is per user (`~/.cache/sea-trials/quarantine/
ledger.jsonl`, `ST_STATE_DIR` override), so also grep the PR's commits
for `test: quarantine flaky` when the loop runs on another machine.

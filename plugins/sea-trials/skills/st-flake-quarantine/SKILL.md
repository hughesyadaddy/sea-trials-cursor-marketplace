---
name: st-flake-quarantine
description: >-
  Quarantine a genuinely flaky test that is blocking a Sea Trials PR
  review loop. Use when remote PR Checks are red on HEAD but the local
  push gate passed, the failure cannot be attributed to the PR diff,
  and a retry goes green. Classifies each failing check, enforces the
  never-quarantine rules, retries once (isolated then remote), opens a
  flaky-test tracking issue, applies a skip that cites the issue, and
  hands back to st-pr-review-loop-inplace / st-pr-review-loop-worktree.
  Returns "real failure" when the test is not flaky.
disable-model-invocation: true
user-invocable: true
---

<!-- CURSOR_VGV_PORT -->
> **Dual-host port:** use the host structured question
> tool — **AskQuestion** on Cursor, **AskUserQuestion**
> on Claude Code. Prefer whichever exists in the tool
> schema. Never ask option lists as plain chat text when
> a structured question tool is available.
> On Cursor: continue handoffs in this chat (Plan now /
> Build now). Never output `/clear` or `/new-chat`.
> On Claude Code: clear-context handoffs remain valid.


# Flake Quarantine

Turn "CI is red and I cannot explain it" into one of two verdicts:
**quarantined** (skip applied, issue open, loop continues) or **real
failure** (hand back to the review loop's fix fan-out). Nothing else.

Quarantine is a debt instrument. Every skip cites an issue, lands in
the per-user ledger, and is capped per PR. When in doubt, it is real.

**Read first:**

1. [`references/attribution-rules.md`](references/attribution-rules.md)
   — how a failure is tied to the diff and the never-quarantine list.
2. [`references/skip-syntax.md`](references/skip-syntax.md) — what the
   `quarantine` subcommand writes for Dart and Node, and its fallbacks.
3. The review-loop contract the caller is running
   (`st-pr-review-loop-*/references/shared/review-loop-contract.md`)
   for `$ST_PLUGIN_ROOT`, the single gate, and the push path.

## Script

```bash
ST_FLAKE="$ST_PLUGIN_ROOT/scripts/hooks/flake-quarantine.mjs"
node "$ST_FLAKE" classify --pr <n> [--json]
node "$ST_FLAKE" retry --pr <n> --check <name> [--isolated]
node "$ST_FLAKE" issue --pr <n> --check <name> --test-file <path> [--test "<name>"] [--dry-run]
node "$ST_FLAKE" quarantine --file <path> [--test "<name>"] --reason "<text>" --issue <url> --pr <n>
node "$ST_FLAKE" unquarantine --file <path> [--test "<name>"]
node "$ST_FLAKE" ledger [--json]
```

All `gh` / `git` / `flutter` calls run from `$ACTIVE_ROOT`. The script
never pushes and never commits.

## Phase 0 — Detect (entry conditions, all required)

| Condition | Evidence |
| --- | --- |
| Local single push gate passed on this tree | `pr-review-push --check-only` green, or the gate lanes of the current round all green |
| Remote PR Checks red on HEAD | `node "$ST_REVIEW_STATUS" -- --pr <n>` exit `3`, or the watcher exited `3` |
| The red check is a **test** job | `classify` lists at least one `testFiles[]` entry |

Never quarantine a **local** failure. A red gate lane means the code is
wrong; fix it. This skill only handles a remote failure the local gate
could not reproduce.

## Phase 1 — Classify

```bash
node "$ST_FLAKE" classify --pr <n> --json
```

One object per failing PR-Checks job: `check`, `runId`, `jobName`,
`testFiles[]`, `testNames[]`, `attributable`, `reason`, `protected[]`.
Attribution is conservative: no parsable test file, or a file the
script cannot resolve in the repo, reads as `attributable: true`.

Dispatch Phase 1–3 to **`st-flake-triager`** (one worker per failing
check, one parent turn) when more than one check is red; run inline
for a single check.

## Phase 2 — Hard rules (parent enforces; the triager only reports)

Never quarantine when any of these hold:

1. `attributable: true` — the diff touched the test's file or package.
2. The PR touched the failing test file at all (even a rename).
3. The PR already carries **2** active quarantines (`ledger` filtered
   by `pr`). A third needs a human: ask once via the host
   structured-question tool, default **Fix instead**.
4. `protected[]` is non-empty: paths or names matching
   `integration_test/`, `scenario_`, `golden`, `security`, `auth`,
   `payment`, `billing`. These are always fixed, never skipped.
5. The failure is a compile error, analyzer error, timeout of the
   whole job, or infrastructure error (runner lost, network). Those
   are re-run or fixed, not quarantined.

Any rule tripped → verdict **real failure** → Phase 5.

## Phase 3 — Retry once

```bash
node "$ST_FLAKE" retry --pr <n> --check <name> --isolated
```

`--isolated` first runs the failing test file once locally in its
package (`flutter test <file>` or `dart test <file>`; `node --test` for
`*.test.mjs`), then `gh run rerun <runId> --failed` and polls until
the run completes (default 30 s interval, 45 min cap; `--interval <s>`,
`--max-wait <min>`). Exit `0` and `passedOnRetry: true` means green.

Only one retry. A second red is a real failure.

## Phase 4 — Quarantine (green on retry)

Order matters: issue first, so the skip can cite it.

```bash
ISSUE=$(node "$ST_FLAKE" issue --pr <n> --check <name> \
  --test-file <path> --test "<name>")
node "$ST_FLAKE" quarantine --file <path> --test "<name>" \
  --reason "flaky: passes on retry, not attributable to PR #<n>" \
  --issue "$ISSUE" --pr <n>
```

Then rejoin the review loop exactly where it left off:

1. Re-run the single gate (`pr-review-push --list-tasks` fan-out) — a
   skip changes the tree, so the gate runs again in full.
2. Commit: `test: quarantine flaky <test or file> (#<issue-number>)`.
3. Push only through `node "$ST_REVIEW_PUSH" -- --pr <n>`. Never bare
   `git push`.
4. Restart the watcher; the loop continues.

Prefer `--test "<name>"` over a file-level skip. `blocTest` and
non-unique descriptions fall back to a file-level `@Skip` — the script
says so on stderr; mention it in the commit body.

## Phase 5 — Real failure

Return to the calling loop with the classify object and the retry
result. The loop's fix fan-out (`pr-review-fix-tasks`) owns the fix.
Do not retry again, do not skip, do not widen scope.

## Dual-host dispatch

| Unit | Cursor | Claude Code |
| --- | --- | --- |
| Triage one failing check | `Task({ subagent_type: "st-flake-triager", prompt })` | `Agent` `sea-trials:st-flake-triager` |
| Structured question (rule 3) | **AskQuestion** | **AskUserQuestion** |
| Invoke this skill from the loop | `/st-flake-quarantine` | `/sea-trials:st-flake-quarantine` |

Triager prompt must carry: `$ACTIVE_ROOT`, `$ST_PLUGIN_ROOT`, PR
number, the single `check` name, and "return only the verdict JSON".
Triagers never edit files, never open issues, never push.

## Verdict shape (what the loop receives)

```json
{
  "verdict": "quarantined | real",
  "check": "dart-test",
  "testFile": "flutter/packages/x/test/y_test.dart",
  "test": "name or null",
  "attributable": false,
  "passedOnRetry": true,
  "issue": "https://github.com/…/issues/N or null",
  "commit": "sha or null",
  "reason": "one sentence"
}
```

## Hard stops

- Entry conditions in Phase 0 not met — report, do nothing.
- Rule 3 question answered **Fix instead** or unanswered.
- `gh issue create` fails — do not skip without an issue.
- The quarantine commit fails the single gate — revert the skip, real
  failure.

## Final report

- Checks classified: attributable / not / protected
- Retry results (isolated pass/fail, remote conclusion)
- Issue URL(s), skip location (test-level or file-level fallback)
- Commit SHA and the loop step handed back to
- Ledger path (`ledger` output for this PR)

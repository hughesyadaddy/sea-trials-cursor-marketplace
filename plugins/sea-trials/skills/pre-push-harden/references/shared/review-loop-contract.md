# Review-loop contract (Sea Trials)

Shared by `pr-review-loop-inplace`, `pr-review-loop-worktree`, and
`pre-push-harden`. Read this before Phase 0 of either review loop, and
before every push.

## Project directory lock

Sea Trials is a monorepo. Validation (`pnpm`, `melos`, Flutter, Envied
secrets, workspace packages) only works inside this checkout.

1. Resolve once:

   ```bash
   REPO_ROOT=$(git rev-parse --show-toplevel)
   ```

1. **In-place:** every Shell `working_directory`, every Read/Edit/Write
   path, and every `pnpm` / `melos` / `dart` / `flutter` invocation MUST
   use absolute paths under `$REPO_ROOT`. Confirm before first edit:

   ```bash
   test "$(git rev-parse --show-toplevel)" = "$REPO_ROOT"
   ```

1. **Worktree:** create under the **project**, never a bare `/tmp` tree
   as the only checkout:

   ```bash
   WORKTREE_PARENT="$REPO_ROOT/.review-worktrees"
   mkdir -p "$WORKTREE_PARENT"
   WORKTREE_DIR="$WORKTREE_PARENT/${PR_BRANCH//\//-}-$(date -u +%Y%m%dT%H%M%SZ)"
   ```

   All edits/commits/pushes use absolute paths under `$WORKTREE_DIR`.
   `$WORKTREE_DIR` is still a full clone of this repo — `pnpm` /
   `melos` must be run from that worktree root.

4. Forbidden: editing files in a random temp dir that is not a git
   worktree of `$REPO_ROOT`; mixing edits between `$REPO_ROOT` and
   `$WORKTREE_DIR` in the same loop.

## 30-minute bot silence (mandatory)

Bot reviewers (Bugbot, Codex, Cursor Bugbot, etc.) often reply 5–15
minutes after a push, sometimes later, and often **on existing threads**
(thread `createdAt` stays old).

Hard completion rule — all must be true:

1. Zero unresolved review threads on the PR.
2. At least **30 continuous minutes** have elapsed since the **last**
   push produced by this loop.
3. Polls every **5 minutes** throughout that window (≈6 clean polls
   minimum after the last push).

Forbidden early exits:

- Stopping after 1–2 clean polls
- Stopping at 10 or 15 minutes because “bots usually respond by then”
- Filtering new work solely by thread `createdAt > last_push`
- Declaring done because CI is green while threads remain open
- Ending the turn and asking the user to “check back later” instead of
  continuing the poll loop

On any new unresolved work: fix → harden → push → **reset** the
30-minute timer from that push.

## One push per bot round

Batch every finding from a round into the fewest commits needed, then
**one** push. Do not push per-thread. Concurrent auto-fix agents on the
same branch are forbidden while this loop runs.

## In-place commit scope

**`pr-review-loop-inplace` only:** before each push, stage and commit the
**entire** pending working tree under `$REPO_ROOT` (`git add -A`), not
just review-fix paths. Parallel agents and local WIP in the same checkout
must land on the PR branch together. Never stage `.secrets/`, untracked
`.env`, or credential files.

**`pr-review-loop-worktree`:** keep **explicit-path** staging only.

## Pre-push harden (before every push)

Before `git push` (including merge-recovery pushes that carry code):

1. Run the **`pre-push-harden`** skill against the pending diff in the
   active root (`$REPO_ROOT` or `$WORKTREE_DIR`).
2. Do not push until that skill reports **READY**.
3. Never `--force`, never `--no-verify`.

Goal: catch analyze/lint/test/architecture regressions **before** bots
open a new review round (fix-one / break-many loops).

## Sync recovery

On non-fast-forward / remote ahead: fetch → ff-only if possible → else
`git merge --no-edit` → harden → push. Never rebase+force-push. Never
ask whether to merge. Up to 5 race retries.

## Ask tool name

- Cursor: **AskQuestion**
- Claude Code: **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code)

If neither is in the schema, ask as a plain numbered list and say nothing
about the missing tool or the model — see `vgv-ask-question.mdc`.

(Canonical source under `.cursor/skill-custom/` uses AskQuestion (Cursor; AskUserQuestion on Claude Code);
`--emit-sea-trials-plugin` rewrites Cursor copies into
`tools/sea-trials-cursor-plugin/`.)

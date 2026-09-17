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

## Sea Trials plugin CLI

PR review hooks ship on the **sea-trials** Cursor plugin, not monorepo
`scripts/hooks/`. Resolve the plugin root once per shell session:

```bash
_st_plugin_root() {
  if [[ -n "${ST_PLUGIN_ROOT:-}" ]]; then
    printf '%s\n' "$ST_PLUGIN_ROOT"
    return 0
  fi
  local hit base
  for base in \
    "${HOME}/.cursor/plugins/cache/hughesyadaddy-sea-trials-cursor-marketplace" \
    "${HOME}/.cursor/plugins/cache/sea-trials-cursor-marketplace"; do
    [[ -d "$base" ]] || continue
    hit="$(
      find "$base" -path '*/plugins/sea-trials/scripts/resolve-plugin-root.mjs' \
        2>/dev/null | head -1
    )"
    if [[ -n "$hit" ]]; then
      dirname "$(dirname "$hit")"
      return 0
    fi
  done
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$repo_root" && \
        -f "$repo_root/tools/sea-trials-cursor-plugin/scripts/resolve-plugin-root.mjs" ]]; then
    node "$repo_root/tools/sea-trials-cursor-plugin/scripts/resolve-plugin-root.mjs"
    return 0
  fi
  echo "ERROR: sea-trials Cursor plugin not found (enable Team Marketplace)" >&2
  return 1
}

ST_PLUGIN_ROOT="$(_st_plugin_root)"
ST_REVIEW="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-threads.mjs"
ST_REVIEW_STATUS="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-status.mjs"
ST_REVIEW_LOOP="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs"
ST_REVIEW_PUSH="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs"
```

All review-loop commands below use these paths. From `$REPO_ROOT` (or a
worktree), run `node "$ST_REVIEW…"` — never hand-roll monorepo
`scripts/hooks/pr-review-*.mjs` paths.

## 30-minute bot silence (mandatory)

Bot reviewers (Bugbot, Codex, Cursor Bugbot, etc.) often reply 5–15
minutes after a push, sometimes later, and often **on existing threads**
(thread `createdAt` stays old).

Hard completion rule — all must be true:

1. Zero unresolved review threads on the PR.
2. At least **30 continuous minutes** have elapsed since the **last**
   push produced by this loop.
3. Polls throughout the silence window. **Preferred:** run
   `node "$ST_REVIEW_LOOP" -- --pr <n> --interval 15 --silence 30` in a
   **background terminal** (15s interval). Spot-check with
   `node "$ST_REVIEW_STATUS" -- --pr <n>`. If hooks are unavailable,
   poll GraphQL threads every **5 minutes** minimum (≈6 clean polls
   after the last push).
1. **All PR CI checks green on HEAD** (not only review threads).

**Terminal automation (Cursor background):** use the repo hooks for
instant polls and CI awareness:

| Command | Purpose |
| --- | --- |
| `node "$ST_REVIEW_STATUS" -- --pr <n>` | One-shot: threads + CI (+ light jobs) |
| `node "$ST_REVIEW_LOOP" -- --pr <n> --interval 15 --silence 30` | Watch every 15s; abort on threads/CI fail |
| `node "$ST_REVIEW_PUSH" -- --pr <n>` | `agent-prepush` → `git push` (prepush hook) |

State artifacts: `docs/code-review/<scope>/pr-review-state.json`,
`pr-review-queue.json`, `pr-*-loop-log.txt`. Exit codes: `0` clean,
`2` threads, `3` CI fail, `4` local prepush fail, `8` CI pending.
Silence window still applies after the last push; new pushes reset the
timer. When `pr-review-queue.json` appears, parent agent must triage
and fix (background Node cannot spawn Cursor subagents).

## Background watcher → parent agent (autonomous wake)

When `node "$ST_REVIEW_LOOP"` runs in a **background terminal**, treat its
exit code as a work ticket — **never ask the user** whether to proceed:

| Exit | Meaning | Parent agent action |
| --- | --- | --- |
| `0` | Silence met; threads clear; CI green | Done (or final verify) |
| `2` | Unresolved review threads | Read `pr-review-queue.json`; fix **all**; reply+resolve; push; restart watcher |
| `3` | CI failure on HEAD | Fix or re-run flake; push; restart watcher |
| `8` | CI pending (watch mode) | Keep watcher running; do not stop early |

After every fix round: `node "$ST_REVIEW_PUSH" -- --pr <n>` → reply+resolve every thread
→ restart `node "$ST_REVIEW_LOOP" -- --pr <n> --interval 15 --silence 30`
in background. Do not end the turn with open threads or an incomplete
30-minute silence window unless the user explicitly stops the loop.

Forbidden when the background watcher is active:

- Asking "should I fix these Codex threads?"
- Stopping after the watcher exits `2` without fixing and re-pushing
- Telling the user to "check back later" instead of continuing the loop

Forbidden early exits:

- Stopping after 1–2 clean polls
- Stopping at 10 or 15 minutes because “bots usually respond by then”
- Filtering new work solely by thread `createdAt > last_push`
- Declaring done because CI is green while threads remain open
- Declaring done because threads are clear while CI is failing or pending
  on HEAD
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

## Bot reply format (Codex / Bugbot)

Every thread close reply MUST use an explicit adversarial verdict so bot
reviewers can distinguish **fixed** from **rejected** findings on the
next pass. Silent resolve or vague "won't fix" replies invite repeat
false positives.

Map Phase 2 classification → verdict:

| Triage | Verdict | When |
| --- | --- | --- |
| (a) valid fix | `valid` | Code changed; cite push SHA |
| (b) already fixed | `stale` | Finding true on old diff only |
| (c) intentional | `reject` | Design/contract is deliberate |
| (d) incorrect | `reject` | Evidence shows finding is wrong |

Build the body with the repo helper (never hand-roll the prefix):

```bash
node "$ST_REVIEW" format \
  --verdict valid --sha 197c8d91ef \
  --summary "Scheduled callback calls _runFileChannel inside the slot."

node "$ST_REVIEW" format \
  --verdict reject \
  --summary "Subscribe-before-login is intentional; promotion gated on userRowPresent."

node "$ST_REVIEW" format \
  --verdict stale \
  --summary "RLS migration already shipped in 20260827184106_…"
```

Then close in-thread:

```bash
node "$ST_REVIEW" close --pr <n> \
  --repo hughesyadaddy/sea_trials_universal \
  --thread <PRRT_kwDO...> --body "<formatted text>"
```

Required shape (first line):

- **VALID:** `**Adversarial vet: VALID — applied in \`<sha>\`.** …`
- **REJECT:** `**Adversarial vet: REJECT.** …` (name the flaw: wrong phase,
  stale diff, intentional contract, etc.)
- **STALE:** `**Adversarial vet: STALE — no code change.** …`
- **DEFER:** non-blocking follow-up only — never for incorrect findings

Include concrete evidence in the summary (file/symbol, production log fact,
existing test, contract doc). Rejections without evidence read as dismissals
and Codex will re-raise the same thread.

## Pre-push harden (before every push)

Before `git push` (including merge-recovery pushes that carry code):

1. Run the **`pre-push-harden`** skill against the pending diff in the
   active root (`$REPO_ROOT` or `$WORKTREE_DIR`).
2. Run **`node "$ST_REVIEW_PUSH" -- --pr <n>`** (or `pnpm agent-prepush` then
   `git push`) so local gates run before the hook.
3. Do not push until that skill reports **READY**.
4. Never `--force`, never `--no-verify`.

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
`tools/sea-trials-cursor-plugin/skills/`.)

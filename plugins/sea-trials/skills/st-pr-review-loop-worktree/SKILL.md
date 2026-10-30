---
name: st-pr-review-loop-worktree
description: >-
  Autonomous PR review loop that resolves every open review thread
  inside an isolated git worktree under this Sea Trials repo
  (.review-worktrees/). Use when the user asks for a PR review loop,
  "fix reviews in a worktree", wants isolation from the current
  checkout, or the working tree is dirty / on the wrong branch.
  Runs the PR monitor in a Cursor in-chat background terminal until the
  advisory AI review has settled on the last push. Project-local worktree
  (not bare /tmp), and pre-push-harden before every push. Leaves the
  user's original checkout untouched.
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


# PR Review Loop (Worktree)

Resolve every unresolved PR review thread inside an **isolated git
worktree under this project**. The user's current branch, uncommitted
files, and IDE state stay untouched.

**Read first, in order:**

1. [`references/shared/cursor-in-chat-monitor.md`](references/shared/cursor-in-chat-monitor.md)
   — **Cursor:** in-chat monitor with `ST_REPO_ROOT=$WORKTREE_DIR`.
2. [`references/shared/review-loop-contract.md`](references/shared/review-loop-contract.md)
3. [`references/shared/review-loop-monitor.md`](references/shared/review-loop-monitor.md)
4. [`references/shared/review-loop-body.md`](references/shared/review-loop-body.md)
   — the loop itself. **Follow it exactly.** This file only adds the
   worktree mode rules below; it never overrides the body.

## Run modes (pick one, state it in the report)

| Mode | When | Monitor |
| --- | --- | --- |
| **Interactive** | Local Cursor chat, user present | In-chat daemon + `Await` (below) |
| **Event round** | Cloud agent started by an Automation / API on a review, CI or push event | **No daemon.** Steps 0→6 once for the current HEAD, then exit `0` with state written. The next GitHub event starts the next round. |

Event-round rules: finish within the cloud-agent budget (target ≤45
min/round); never sleep waiting for the AI review — the "PR review submitted" /
"CI completed" / "AI Review (advisory)" workflow-run trigger wakes the next round; write
`docs/code-review/<scope>/pr-review-state.json` before exiting; a failed
or timed-out round is simply retried by the next trigger (idempotent,
Step 0).

## Tool paths

Resolve `$ST_*` with the block in
`references/shared/review-loop-contract.md` → "Sea Trials plugin CLI".
Use only plugin paths. Do not use `pnpm pr-review-*`, `.husky/st-plugin-run.sh`,
or `scripts/overlay-st-plugin-review-hooks.mjs` from the app repo even if
present. Never request Codex or post `@codex review`: the code review is the
advisory AI review (contract → "Code review"), and it is never a merge gate.

## Mode: worktree

| Setting | Value |
| --- | --- |
| `$ACTIVE_ROOT` | `$WORKTREE_DIR` under `$REPO_ROOT/.review-worktrees/` |
| Staging | **Explicit paths only** (`git add <path>…`) |
| Branch policy | Throwaway local branch `review-loop/<PR_BRANCH>`; push `HEAD:$PR_BRANCH` |
| Cleanup | Remove the worktree; verify the user checkout is unchanged |

### When to use which skill

| Situation | Skill |
| --- | --- |
| Dirty tree, wrong branch, or isolation required | **This skill** (default safe) |
| Clean tree, already on PR branch, fix here | `st-pr-review-loop-inplace` |
| About to push any branch (proactive) | `st-pre-push-harden` |

### Setup (before Step 1 of the body)

Do **not** modify the user's current branch or working tree.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
USER_BRANCH=$(git -C "$REPO_ROOT" branch --show-current)
USER_STATUS=$(git -C "$REPO_ROOT" status --porcelain)
PR_NUMBER=<number>
PR_BRANCH=$(gh pr view "$PR_NUMBER" --json headRefName -q .headRefName)

git fetch origin "$PR_BRANCH"

# Project-local worktree — monorepo tools need the tree layout here.
WORKTREE_PARENT="$REPO_ROOT/.review-worktrees"
mkdir -p "$WORKTREE_PARENT"
WORKTREE_DIR="$WORKTREE_PARENT/pr-${PR_NUMBER}-${PR_BRANCH//\//-}"   # stable per PR → resumable

# Git allows a branch in one worktree only; pushes use HEAD:$PR_BRANCH.
WORKTREE_BRANCH="review-loop/${PR_BRANCH}"
if [ -d "$WORKTREE_DIR/.git" ] || [ -f "$WORKTREE_DIR/.git" ]; then
  # Resume an interrupted run: keep unpushed work, then sync.
  git -C "$WORKTREE_DIR" merge --ff-only "origin/$PR_BRANCH" 2>/dev/null || true
else
  git worktree add -B "$WORKTREE_BRANCH" "$WORKTREE_DIR" "origin/$PR_BRANCH"
fi
cd "$WORKTREE_DIR"
# Project bootstrap (project build logic, not PR tooling):
if [ -f package.json ] && node -e 'process.exit(require("./package.json").scripts?.bootstrap?0:1)'; then
  CI=true pnpm bootstrap   # l10n, node_modules, linter — gate needs them
fi
```

Confirm before the first edit:

1. `pwd` is `$WORKTREE_DIR`, under `$REPO_ROOT/.review-worktrees/`.
2. `git branch --show-current` equals `$WORKTREE_BRANCH`.
3. `git status --porcelain` empty. (Git hooks are optional: the
   plugin push guard + `pr-review-push` enforce the gate either way.)
4. User `$REPO_ROOT` status unchanged vs `$USER_STATUS`.

Creation failure → stop and report. Never `-B` over an existing
worktree that holds unpushed commits (resume it instead). Never fall back to in-place
silently. When `origin/$PR_BRANCH` moves ahead during the loop → Sync
recovery **inside `$WORKTREE_DIR`**.

### Autonomy policy

**Default: do not ask. Just finish.**

- Infer PR number/URL from the message or `gh pr view`.
- Create the worktree, sync, merge, gate, fix, commit, push, and watch
  **without** asking.
- Structured question only for irreversible blockers (force-removing
  a dirty worktree unless already authorized).
- Never ask about non-fast-forward / origin ahead — Sync recovery.
- Never ask permission to push review-fix commits.

## In-chat monitor (before Step 1)

Follow **`cursor-in-chat-monitor.md`** with
`ACTIVE_ROOT=$WORKTREE_DIR` and `ST_REPO_ROOT=$WORKTREE_DIR` — same chat
Shell + `Await` loop; stop any detached daemon first.

## Run the body

Execute `references/shared/review-loop-body.md` Steps 0–6 (+4b) from
`$WORKTREE_DIR` until a hard stop condition holds. All file ops use
absolute paths under `$WORKTREE_DIR`; `pnpm`/`melos` run from that
worktree root. Never edit, commit, or push from `$REPO_ROOT`; never
merge into the user's local branch.

## Teardown & original-checkout verification

1. Remove the worktree:

   ```bash
   cd "$REPO_ROOT"
   git worktree remove "$WORKTREE_DIR"
   git worktree prune
   ```

   If remove fails (dirty leftover): finish commit/push recovery in the
   worktree first. Still blocked → ask once via the host
   structured-question tool: Force remove (Recommended) / Leave it.

2. Verify the user checkout is undisturbed: still on `$USER_BRANCH`;
   `git status --porcelain` matches `$USER_STATUS`; no
   stash/reset/clean/switch happened in `$REPO_ROOT`.

## Merge

Only when the user asked to merge (or the merge automation runs this):
`node "$ST_MERGE" --pr <n> --wait 30` — see `st-pr-merge`. Never
`gh pr merge` by hand, never `--admin`.

## Final report

- Worktree path; cleanup status; original checkout intact (evidence)
- Sync/merge recoveries (count, SHAs)
- Threads fixed / replied / resolved; remaining unresolved (must be 0)
- Gate lanes per round: pass/fail summary
- Push gate exit codes and pushed SHA(s) on `$PR_BRANCH`
- Watcher: settled states reached, CI pass/fail/pending, final quiet
  window duration

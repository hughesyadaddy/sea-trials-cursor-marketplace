<!-- GENERATED from skills/_sources/review-loop-contract.md — do not edit; run node scripts/sync-skill-sources.mjs -->
# Review-loop contract (Sea Trials)

Shared by `st-pr-review-loop-inplace`, `st-pr-review-loop-worktree`,
`st-pr-ship`, and `st-pre-push-harden`. Read this before the review
loop's preflight and before every push. The loop steps themselves live
in `shared/review-loop-body.md`; this file holds the rules that body
relies on.

## Maximum parallel fan-out (`st-*` default)

Sea Trials **`st-*`** skills default to **as many parallel workers as
the host allows** — never serialize work the parent can fan out.

| Workflow | Emitter | Parent action |
| --- | --- | --- |
| Push gate lanes | `pnpm pr-review-push -- --pr <n> --list-tasks` | One worker per JSON line |
| PR adversarial vet | `pnpm pr-review-adversarial-tasks -- --pr <n>` | 3 × thread count |
| PR code fixes | `pnpm pr-review-fix-tasks -- --pr <n>` | 1 × path (path-scoped) |
| Build shards | `pnpm st-build-shard-tasks -- --manifest shards.json` | 1 × ready shard |
| Pre-push review | Harden Phase 3 agents (4 types) | One worker each, same turn |

**Rules:**

1. Collect JSON lines first; launch **all workers in one parent turn**
   when count ≤ **16** (Cursor concurrency cap). Above 16: batch rounds
   of 16 — still never one-at-a-time unless only one task exists.
2. Subagents run gates/fixes/reviews only — **never `git push`**, never
   commit, never reply to threads.
3. Parent synthesizes, integrates conflicts, then **one gate + one
   push** per round.
4. Gate workers run `node "$ST_PLUGIN_ROOT/scripts/hooks/run-gate-task.mjs"
   '<json-line>'` and honour the line's `subagent_type`, `model`
   (Cursor: `composer-2.5`) and `claudeModel` (Claude: `haiku`) hints.

```bash
pnpm pr-review-push -- --pr <n> --list-tasks
pnpm pr-review-fix-tasks -- --pr <n>
pnpm pr-review-adversarial-tasks -- --pr <n>
pnpm st-build-shard-tasks -- --manifest shards.json --root "$ACTIVE_ROOT"
```

`pnpm st-parallel-tasks -- --pr <n>` still exists as a convenience that
merges the review emitters with the gate lanes into one list.

`/st-build-with-subagents`, `/st-pre-push-harden`, `/st-pr-review-loop-*`,
`/st-vgv-chain`, and `/st-pr-ship` all inherit this section.

## Dual-host dispatch

Emitters above print one JSON task line per unit of work. Dispatch one
worker per line on either host — same parallelism rules as above.

| Host | One JSON line → |
| --- | --- |
| **Cursor** | `Task({ subagent_type, … })` |
| **Claude Code** | **Agent** tool or `context: fork` |

Launch all workers in **one parent turn** per wave (batch by 16 on
Cursor when needed). Subagents never push; parent merges then one
harden + one push.

Full host-specific walkthrough (shards, gate lanes, prepush order):

`plugins/sea-trials/skills/st-build-with-subagents/references/
dual-host-dispatch.md`

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

PR review hooks ship on the **sea-trials** Cursor plugin. **Prefer
`pnpm` shortcuts** from any monorepo checkout (or worktree) — no plugin
root hunt required:

```bash
pnpm pr-review-threads -- list --pr <n>
pnpm pr-review-adversarial-tasks -- --pr <n>
pnpm pr-review-fix-tasks -- --pr <n>
pnpm st-build-shard-tasks -- --manifest shards.json
pnpm pr-review-status -- --pr <n>
pnpm pr-review-loop -- --pr <n> [--webhook] [--json]
pnpm pr-review-push -- --pr <n> --list-tasks
pnpm pr-review-push -- --pr <n> --check-only
pnpm pr-review-push -- --pr <n>
```

Every hook resolves `owner/name` from the checkout's `origin` remote
(`resolveGithubOwnerRepo`); `--repo` and the `GH_REPO` env var override
it. Never hardcode an owner/repo in prompts or commands.

`ST_PLUGIN_ROOT` is **optional** when working from a monorepo checkout
(use `pnpm` shortcuts instead). Set it when debugging outside a repo, or
let `_st_plugin_root` discover the cached Team Marketplace plugin.

Fallback when `pnpm` is unavailable (marketplace-only agent, no repo):

```bash
_st_plugin_root() {
  if [[ -n "${ST_PLUGIN_ROOT:-}" ]]; then
    printf '%s\n' "$ST_PLUGIN_ROOT"
    return 0
  fi
  local hit base
  for base in \
    "${HOME}/.cursor/plugins/cache/__DEFAULT__/sea-trials" \
    "${HOME}/.cursor/plugins/cache/hughesyadaddy-sea-trials-cursor-marketplace" \
    "${HOME}/.cursor/plugins/cache/sea-trials-cursor-marketplace"; do
    [[ -d "$base" ]] || continue
    hit="$(
      find "$base" \( \
        -path '*/sea-trials/*/scripts/resolve-plugin-root.mjs' \
        -o -path '*/plugins/sea-trials/scripts/resolve-plugin-root.mjs' \
        \) 2>/dev/null | head -1
    )"
    if [[ -n "$hit" ]]; then
      dirname "$(dirname "$hit")"
      return 0
    fi
  done
  echo "ERROR: sea-trials Cursor plugin not found (enable Team Marketplace)" >&2
  return 1
}

ST_PLUGIN_ROOT="$(_st_plugin_root)"
ST_REVIEW="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-threads.mjs"
ST_REVIEW_STATUS="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-status.mjs"
ST_REVIEW_LOOP="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-loop.mjs"
ST_REVIEW_PUSH="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs"
ST_PARALLEL="$ST_PLUGIN_ROOT/scripts/hooks/st-parallel-tasks.mjs"
ST_BUILD_SHARD="$ST_PLUGIN_ROOT/scripts/hooks/st-build-shard-tasks.mjs"
ST_ADVERSARIAL="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-adversarial-tasks.mjs"
ST_FIX="$ST_PLUGIN_ROOT/scripts/hooks/pr-review-fix-tasks.mjs"
```

All review-loop commands below use these paths when `pnpm` shortcuts are
unavailable. Never hand-roll `gh api` for reply/resolve.

## Adversarial vet (3 agents × every unresolved thread)

**Before** `format` + `close` on any bot thread (Codex, Bugbot, Cursor
Bugbot), launch **three** Task subagents **per thread**, all in **one
parent turn** (20 threads → 60 Tasks). Never skip because the thread
count is small.

```bash
pnpm pr-review-adversarial-tasks -- --pr <n>
```

Each JSON line has `subagent_type`, `threadId`, `path`, `line`, and a
self-contained `prompt`. Default agents (fixed order):

| Agent | Role |
| --- | --- |
| `code-simplicity-review-agent` | Minimal fix; reject scope creep |
| `vgv-review-agent` | Architecture + AGENTS.md contracts |
| `test-quality-review-agent` | Regression + test evidence bar |

**Synthesis (parent only):**

- All three **REJECT** with evidence → `reject` verdict; do not change
  code unless you find a real bug anyway.
- Any **VALID** with evidence + code fix landed → `valid` + push SHA.
- Finding true on old diff only → `stale`.
- Split verdict → parent re-reads diff; conservative tie-break: fix real
  bugs, `reject` with evidence for intentional contracts.

Then build the reply with `pnpm pr-review-threads -- format` and close
with `pnpm pr-review-threads -- close`. Silent resolve is forbidden.

## Single gate, then push (before every push)

The local push gate runs **once per round**, fanned out, and the push
command re-uses that result. Never run the same lanes three times
(`st-parallel-tasks` + `pnpm prepush` + `pr-review-push`).

1. Emit lanes: `pnpm pr-review-push -- --pr <n> --list-tasks`.
2. Dispatch one worker per JSON line (Cursor: `Task`; Claude: `Agent`),
   all in one parent turn (batch by 16). Each worker runs
   `node "$ST_PLUGIN_ROOT/scripts/hooks/run-gate-task.mjs" '<json>'`.
   A single line → the parent may run it inline.
3. Red lane → root-cause fix → re-run that lane until green.
4. **Commit only after every lane is green.**
5. Push **only** through `pnpm pr-review-push -- --pr <n>`. It replays
   the gate plan (the gate-pass token in
   `scripts/hooks/lib/gate-pass-token.mjs` lets the husky pre-push skip
   lanes already proven on an unchanged tree) and then runs `git push`
   with hooks. `--check-only` runs the gate without pushing (used by
   `st-pre-push-harden` to reach READY).

**The gate is never skipped after a push.** Each new round of bot
findings goes through steps 1–5 again in full. Bare `git push`,
`--force`, and `--no-verify` are forbidden on branches with an open PR.

## Bot review settled machine (replaces the flat 30-minute wait)

Bot reviewers (Codex, Cursor Bugbot, CodeRabbit, Copilot) answer
anywhere from seconds to ~15 minutes after a push, often **on existing
threads** (thread `createdAt` stays old). The watcher no longer waits a
flat 30 minutes; it drives a state machine anchored to the current
HEAD sha `H` and push time `t0` — signals from an older head never
count:

| State | Waits for | Poll |
| --- | --- | --- |
| `PUSHED` | 20 s grace | — |
| `AWAITING_ACK` | Codex 👀 newer than `t0` · Bugbot/CodeRabbit check run queued or in progress · Copilot in `requested_reviewers`. ≤3 min; on timeout post `@codex review` once (if Codex enabled) | 15 s |
| `REVIEWING` | New bot review comments. ETag-conditional REST (`pulls/{n}/comments`, `reviews`, issue comments, check runs); GraphQL threads only on a 200. Backs off to 60 s while CI is pending. Cap 25 min | 30 s |
| `SETTLED_CHECK` | Two consecutive polls with no new bot comment, then a 3-min quiet window (two 60 s polls) | 60 s |
| `SETTLED` | — | — |
| `ACTING` | Unresolved bot threads > 0 → exit `2`, queue written | — |
| `DONE` | Zero unresolved bot threads and CI green → exit `0` | — |

Bot completion signals the machine understands:

| Bot | Ack | Complete | Re-trigger |
| --- | --- | --- | --- |
| Codex `chatgpt-codex-connector` | 👀 reaction on PR body | `Codex Review:` review, 👍 on PR body, or issue comment with `**Reviewed commit:** H` | comment `@codex review` |
| Cursor Bugbot | check run `Cursor Bugbot` queued/in_progress | check run `success` / `neutral` / `failure` | comment `bugbot run` |
| CodeRabbit | check run queued/in_progress | check run completed | comment `@coderabbitai review` |
| Copilot `copilot-pull-request-reviewer` | in `requested_reviewers` | dropped from `requested_reviewers` | `gh pr edit <n> --add-reviewer @copilot` |

GraphQL logins have no `[bot]` suffix; REST logins do — the machine
normalizes both. GraphQL throttling (`errors[].type == RATE_LIMITED` or
`rateLimit.remaining < 500`) triggers a back-off, never a crash.

**Hard caps.** `--silence <min>` (default **30**) is the absolute
max-silence cap: the watcher exits by then regardless of state (`8` if
CI is still pending). `--interval <s>` overrides the `REVIEWING` poll.
`--bots codex,bugbot,coderabbit,copilot` limits which acks are awaited.
`--webhook` adds the `gh webhook forward` fast path (local receiver on
`127.0.0.1`; any review/comment/check event polls immediately; polling
stays as the fallback; degrades silently when the extension is absent).

Hard completion rule — all must be true:

1. Zero unresolved review threads on the PR.
2. The settled machine reached `DONE` after the **last** push (quiet
   window observed, not just a clean poll).
3. **All PR CI checks green on HEAD** (not only review threads).

Watcher commands:

| Command | Purpose |
| --- | --- |
| `node "$ST_REVIEW_STATUS" -- --pr <n>` | One-shot: threads + CI + `settled.state` |
| `node "$ST_REVIEW_LOOP" -- --pr <n> [--webhook] [--json]` | Background watch until `ACTING`/`DONE` |
| `node "$ST_REVIEW_PUSH" -- --pr <n>` | Single gate → `git push` (hooks on) |

State artifacts: `docs/vgv-code-review/<scope>/pr-review-state.json`
(includes the `settled` snapshot: `state`, `head`,
`unresolvedBotThreads`, `signals`, `nextPollMs`),
`pr-review-queue.json`, `pr-*-loop-log.txt`. Exit codes: `0` done,
`2` threads, `3` CI fail, `4` local gate fail, `8` CI pending at the
cap. New pushes reset the machine. When `pr-review-queue.json`
appears, the parent agent must triage and fix (background Node cannot
spawn host subagents).

## Background watcher → parent agent (autonomous wake)

When `node "$ST_REVIEW_LOOP"` runs in a **background terminal**, treat
its exit code as a work ticket — **never ask the user** whether to
proceed:

| Exit | Meaning | Parent agent action |
| --- | --- | --- |
| `0` | `DONE`: settled, threads clear, CI green | Final verify |
| `2` | `ACTING`: unresolved bot threads | Read `pr-review-queue.json`; fix **all**; single gate; push; reply+resolve; restart watcher |
| `3` | CI failure on HEAD | Attributable to the diff → fix; else `/st-flake-quarantine` (Cursor) / `/sea-trials:st-flake-quarantine` (Claude Code) — it quarantines (skip + issue committed; loop continues) or returns `real` (loop fixes); single gate; push; restart watcher |
| `8` | CI pending at the silence cap | Restart watcher; report CI as the blocker if it persists |

The flake skill never runs on a red **local** gate lane, never
quarantines a test in a file the PR touched, refuses protected tests
(`integration_test/`, `scenario_`, `golden`, `security`, `auth`,
`payment`, `billing`), and caps at two quarantines per PR without a
human. Its commit rejoins this contract: single gate, then
`pr-review-push`, never bare `git push`.

After every fix round: gate → `node "$ST_REVIEW_PUSH" -- --pr <n>` →
reply+resolve every addressed thread citing the pushed SHA → restart
`node "$ST_REVIEW_LOOP" -- --pr <n>` in the background. Do not end the
turn with open threads or before the machine reaches `DONE` unless the
user explicitly stops the loop.

Forbidden when the background watcher is active:

- Asking "should I fix these Codex threads?"
- Stopping after the watcher exits `2` without fixing and re-pushing
- Telling the user to "check back later" instead of continuing the loop

Forbidden early exits:

- Stopping after 1–2 clean polls (the machine needs the quiet window)
- Stopping because "bots usually respond by now"
- Filtering new work solely by thread `createdAt > last_push`
- Declaring done because CI is green while threads remain open
- Declaring done because threads are clear while CI is failing or
  pending on HEAD
- Stopping on a red CI job without first deciding attributable
  (fix) vs not attributable (`/st-flake-quarantine`)
- Ending the turn and asking the user to "check back later" instead of
  continuing the loop

On any new unresolved work: fix → single gate → push → the machine
restarts from `PUSHED` for the new head.

## One push per bot round

Batch every finding from a round into the fewest commits needed, then
**one** push. Do not push per-thread.

Parallel **path-scoped** fix workers (`pr-review-fix-tasks`) are allowed
in one parent turn; parent merges conflicts, then one gate + one push.
Unscoped concurrent editors on the same branch (no path lock) are
forbidden.

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

Then close in-thread, always citing the pushed fix SHA (`close` refuses
a body with no SHA; `--sha` appends it when the text omits it):

```bash
node "$ST_REVIEW" close --pr <n> \
  --thread <PRRT_kwDO...> --body "<formatted text>" \
  --sha "$(git rev-parse --short HEAD)"
```

Top-level review bodies that have no inline thread cannot be resolved.
Answer them with an issue comment and optionally minimize the review:

```bash
node "$ST_REVIEW" comment --pr <n> --sha "$(git rev-parse --short HEAD)" \
  --body "<formatted text>" [--minimize <PRR_… review node id>]
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

Before any push that carries code (including merge-recovery pushes):

1. Run the **single gate** above (fan-out `--list-tasks` → fix → green)
   in the active root (`$REPO_ROOT` or `$WORKTREE_DIR`). The
   `st-pre-push-harden` skill wraps this with a regression sweep and
   review fan-out and ends with `pr-review-push --check-only` → READY.
2. Push with **`pnpm pr-review-push -- --pr <n>`** — never bare
   `git push`.
3. Do not push until the gate is green / harden reports **READY**.
4. Never `--force`, never `--no-verify`.

Goal: catch analyze/lint/test/architecture regressions **before** bots
open a new review round (fix-one / break-many loops). Tests must never
fail after a push.

## Sync recovery

On non-fast-forward / remote ahead: fetch → ff-only if possible → else
`git merge --no-edit` → single gate → push. Never rebase+force-push.
Never ask whether to merge. Up to 5 race retries.

## Structured questions (dual-host)

Priority — first tool present in the session schema wins:

| # | Tool | Host |
| --- | --- | --- |
| 1 | **AskQuestion** | Cursor |
| 2 | **AskUserQuestion** | Claude Code |
| 3 | **ask_user_question** | MCP `vgv-ask-question` |
| 4 | Numbered chat list | Last resort only |

Full protocol:
`plugins/vgv-wingspan/references/structured-questions-protocol.md`.
Always-on rule: `vgv-ask-question.mdc`. Degrade silently — no tool-name
lecture when falling back.

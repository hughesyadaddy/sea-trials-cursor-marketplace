---
name: st-build-with-subagents
description: >-
  After /plan, implement with parallel build shards on one branch:
  plan→shards.json, rolling-window worker fan-out (cheap execution
  models), integrator merge, parallel review, then ONE harden via
  /st-pre-push-harden + pr-review-push. Use when the user wants build +
  subagents + push-ready gates in one run.
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


# Build with subagents

Parallel-first plan implementation. Workers build **shards** on the
**same branch**; the parent plans, integrates, reviews and hardens.

**Read first:**

- [`references/build-shard-contract.md`](references/build-shard-contract.md)
  — manifest, validator rules, worker result JSON, model tiering
- [`references/dual-host-dispatch.md`](references/dual-host-dispatch.md)
  — how a task line becomes a Cursor `Task` or Claude Code `Agent`

## When to use

| Situation | Skill |
| --- | --- |
| Single package, small plan | `/build` |
| Multi-package / multi-surface plan | **This skill** |
| Push-ready gates only | `/st-pre-push-harden` |
| PR thread resolution | `/st-pr-review-loop-worktree` or `-inplace` |

## Roles and models

| Role | Who | Model |
| --- | --- | --- |
| Planner / parent | this chat | high (whatever the user picked; `inherit`) |
| Shard worker | `st-shard-worker` agent, one per shard | **cheap execution tier** — `composer-2.5` / `sonnet` for code, `composer-2.5-fast` / `haiku` for mechanical shards |
| Integrator | parent, or `st-shard-integrator` agent | `inherit` |
| Reviewers | VGV review agents | as pinned in their agent files |

The emitter stamps `model` (Cursor) and `claudeModel` (Claude Code)
on every task line from the shard's `tier`. The user can override per
shard (`tier`, `model`, `claudeModel` in `shards.json`) or per tier
(`ST_SHARD_MODEL_<TIER>`, `ST_SHARD_MODEL_<TIER>_CLAUDE`).

## Autonomy

- Default: finish without asking.
- Ask (structured question tool) only for irreversible product/API
  decisions, or when the plan gives no way to derive shard boundaries.
- A worker that hits such a decision returns `status: "blocked"`; the
  parent asks once and re-emits.

Set once, used everywhere below:

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
EMIT="node $ST_PLUGIN_ROOT/scripts/hooks/st-build-shard-tasks.mjs \
  --manifest shards.json --root $ACTIVE_ROOT --state-file .st/shards.json"
```

Use a worktree first (via `/st-pr-review-loop-worktree` Phase 0) when
the primary checkout is dirty with unrelated work or on the wrong
branch; then point `ACTIVE_ROOT` at it. Everything, including all
workers, edits that one tree.

---

## Phase 0 — Plan → shards

```bash
node "$ST_PLUGIN_ROOT/skills/st-build-with-subagents/scripts/suggest-shards-from-plan.mjs" docs/plan/<plan>.md > shards.json
node "$ST_PLUGIN_ROOT/skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs" shards.json
```

- A plan with a ```` ```shards ```` block or a `## Parallel execution
  map` table is used as-is. Otherwise the output is a heuristic —
  fix `paths`, add `dependsOn`, set `tier`, declare `sharedFiles`.
- Validator failures are contract errors, not noise: overlapping
  paths or an undeclared barrel in a split package will collide on the
  shared branch. Fix the manifest until it prints `✅`.
- `maxParallel`: default 6, cap 12.

---

## Phase 1 — Rolling-window fan-out

```bash
$EMIT --plan docs/plan/<plan>.md
```

Launch **every** JSON line in **one turn**, in the background, using
the fields on the line:

| Line field | Cursor | Claude Code |
| --- | --- | --- |
| `subagent_type` / `claudeAgent` | `Task({ subagent_type: "st-shard-worker", … })` (fallback `generalPurpose`) | `Agent` named `sea-trials:st-shard-worker` |
| `model` / `claudeModel` | `model: "composer-2.5"` | `model: "sonnet"` |
| `prompt`, `description` | as given | as given |
| `run_in_background` | `run_in_background: true` | run in background |

**Rolling window, not batch-and-wait:** when **any** worker returns,
immediately record it and launch every newly-ready shard:

```bash
$EMIT --result '<the worker's final JSON line>'   # or: --done <id>
```

Repeat until the stderr summary says `COMPLETE`. `$EMIT --status`
shows `ready` / `inFlight` / `pending` / `done` / `blocked` and the
collected `needsIntegration` items. A crashed worker: `$EMIT --reemit`.
A `blocked` worker: resolve the blocker (ask once if it is a product
decision), then `--reemit`.

Workers: same branch, commit per shard, no push, no `sharedFiles`
edits, no gate scripts, one result JSON line. Full contract in
`references/build-shard-contract.md`.

---

## Phase 2 — Integrate

Parent (or one `st-shard-integrator` subagent on `inherit`):

1. `$EMIT --status` → apply every `needsIntegration` item to the
   integrator-owned `sharedFiles` (barrel exports, `pubspec.yaml`,
   `.arb` keys, route/DI registration).
2. Dedupe helpers introduced twice by parallel workers.
3. Regenerate l10n / codegen if shared inputs changed.
4. Validate the whole changed set — fix at the boundary only:

   ```bash
   pnpm agent-validate
   # or: node "$ST_PLUGIN_ROOT/scripts/hooks/agent-validate-changed.mjs"
   ```

5. Commit (`integrate: …`). Still no push.

---

## Phase 3 — Review fan-out (parallel)

Launch the VGV reviewers **in one turn**, each with the repo path and
the changed scope: `vgv-review-agent`, `architecture-review-agent`,
`test-quality-review-agent`, `code-simplicity-review-agent`, plus
`flutter-reviewer` for Dart diffs. On Claude Code use the same agent
names through the `Agent` tool (namespaced by their plugin). Fix
findings in place (parent or a fresh cheap-tier worker per finding
cluster), re-run `agent-validate`, commit.

---

## Phase 4 — ONE harden and push

**Stop and invoke `/st-pre-push-harden`.** Run it through READY; it
fans out `st-parallel-tasks` gate lanes itself. Then push exactly once:

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/pr-review-push.mjs" --pr <n>
```

Never bare `git push`, never `--no-verify`, never
`/create-pr skip-checks`. No PR yet → `/create-pr` first (user choice),
then the same command. Open PR threads → `/st-pr-review-loop-worktree`
or `-inplace`.

---

## Subagent registry

| Role | Cursor `subagent_type` | Claude Code agent | Model |
| --- | --- | --- | --- |
| Shard worker | `st-shard-worker` (fallback `generalPurpose`) | `sea-trials:st-shard-worker` | from task line (cheap tier) |
| Integrator | `st-shard-integrator` | `sea-trials:st-shard-integrator` | `inherit` |
| Gate / CI lanes | `generalPurpose` | general subagent | as emitted |
| Reviewers | VGV review agents | same names | pinned in agent files |

Do **not** use the shell subagent type — unvalidated in this repo.

## Compatibility

- **Cloud Agents:** stdio MCP may be limited; run gates locally when
  cloud lacks the toolchain.
- **Claude Code:** scripts live under `${CLAUDE_PLUGIN_ROOT}`; set
  `ST_PLUGIN_ROOT` to it when the shell snippets above need a path.

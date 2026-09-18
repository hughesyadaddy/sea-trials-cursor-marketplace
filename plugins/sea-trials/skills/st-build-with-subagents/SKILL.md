---
name: st-build-with-subagents
description: >-
  After /plan, implement with parallel package shards (cap 4), parent
  integration, agent-validate, then delegate to /st-pre-push-harden and
  optional /st-pr-review-loop-worktree. Use when the user wants build +
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

Parallel plan implementation with **build shards only** in subagents.
Push gates and PR review loops delegate to existing Sea Trials skills.

**Read first:**

- [`references/build-shard-contract.md`](references/build-shard-contract.md)
- [`references/dual-host-dispatch.md`](references/dual-host-dispatch.md)

## When to use

| Situation | Skill |
| --- | --- |
| Single package, small plan | `/build` |
| Multi-package plan, parallel waves | **This skill** |
| Push-ready gates only | `/st-pre-push-harden` |
| PR thread resolution | `/st-pr-review-loop-worktree` or `-inplace` |

## Autonomy

- Default: finish without asking.
- Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) only for irreversible product/API decisions or
  when shard boundaries cannot be inferred from the plan.

---

## Phase 0 — Lock root (worktree when unsafe)

```bash
ACTIVE_ROOT=$(git rev-parse --show-toplevel)
cd "$ACTIVE_ROOT"
```

**Default to a worktree** when any of these is true:

- Dirty primary checkout unrelated to this plan
- Wrong branch vs plan target
- Parallel build would collide with WIP on the primary tree

When unsafe, run **`/st-pr-review-loop-worktree`** Phase 0 worktree setup
first, then set `ACTIVE_ROOT` to that worktree path.

All paths below are under `$ACTIVE_ROOT`.

---

## Phase 1 — Shard manifest

Parent writes `shards.json` from the plan (package/surface waves).

```bash
node "$ST_PLUGIN_ROOT/skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs" shards.json
```

Example:

```json
{
  "shards": [
    {
      "id": "hybrid-gap-u",
      "paths": ["flutter/packages/api_client/hybrid_api_client/"],
      "dependsOn": []
    },
    {
      "id": "hybrid-tests",
      "paths": [
        "flutter/packages/api_client/hybrid_api_client/test/"
      ],
      "dependsOn": ["hybrid-gap-u"]
    }
  ],
  "maxParallel": 4
}
```

Respect `dependsOn`: run independent shards in parallel; wait for deps
before dependent shards.

---

## Phase 2 — Build shard fan-out

```bash
pnpm st-build-shard-tasks -- --manifest shards.json --root "$ACTIVE_ROOT"
```

Launch **one Task per JSON line** in **one parent turn** per wave
(`generalPurpose`). Re-emit after integration for dependent shards.
Batch by 16 if the wave exceeds Cursor's concurrency cap.

See [`references/dual-host-dispatch.md`](references/dual-host-dispatch.md).

**Shard prompt template** (fill per shard):

```markdown
You are build shard {id} for Sea Trials.

Repo root (ONLY edit here): {ACTIVE_ROOT}
Allowed paths: {path_globs}
Forbidden: git push, worktree creation, edits outside allowed paths

Plan excerpt:
{plan_excerpt}

Acceptance:
- Implement only this shard
- Mirror test/ structure for lib/ changes
- Run: pnpm agent-validate -- {shard_paths}
- Return: files changed, validate exit code, blockers
```

**Forbidden in shard workers:** `git push`, creating worktrees, gate
scripts (`pnpm prepush`, `pr-local-ci`), or edits outside allowed paths.

---

## Phase 3 — Parent integration

After all shards return:

1. Resolve merge conflicts at package boundaries
2. Remove duplicate helpers introduced by parallel shards
3. Confirm no shard left `agent-validate` failing

---

## Phase 4 — Scoped validate

```bash
pnpm agent-validate
```

Fix failures before harden. Do not push.

---

## Phase 5 — Pre-push harden (delegate)

**Stop and invoke `/st-pre-push-harden` now.** Load that skill and run
every phase through READY.

Do not inline gate logic here — `pre-push-harden` fans out
`pnpm st-parallel-tasks` by default.

Sea Trials: never use `/create-pr skip-checks`; use
`pnpm pr-review-push` or `/st-pre-push-harden`.

---

## Phase 6 — PR review loop (conditional)

| State | Action |
| --- | --- |
| PR exists | Invoke `/st-pr-review-loop-worktree` (default) or `-inplace` |
| No PR yet | `/create-pr` or stop after harden (user choice) |

---

## Subagent registry (build shards)

| Role | Cursor `subagent_type` | Notes |
| --- | --- | --- |
| Build shard worker | `generalPurpose` | `st-build-shard-tasks` emitter |
| Gate / CI lanes | `generalPurpose` | `st-parallel-tasks` — one Task per line |
| Pre-push review | 4 review agents | Phase 4 of `pre-push-harden` |
| PR thread fix/vet | Review-loop skill | `pr-review-fix-tasks` + adversarial |

Do **not** use the shell subagent type — unvalidated in this repo.

---

## Compatibility

- **Cloud Agents:** stdio MCP may be limited; run gates locally when
  cloud lacks toolchain.
- **Claude:** scripts via `${CLAUDE_SKILL_DIR}/scripts/` when allowed.

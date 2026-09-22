# Dual-host subagent dispatch

Every emitter in this plugin prints one JSON object per line. The
parent launches **one subagent per line, all in one turn**, on either
host. Field names below are the ones the emitters produce.

## Field → host mapping

| Task-line field | Cursor (`Task` tool) | Claude Code (`Agent` tool) |
| --- | --- | --- |
| `subagent_type` | `subagent_type` (`st-shard-worker`; use `fallbackSubagentType` = `generalPurpose` if the plugin agent is not installed) | — |
| `claudeAgent` | — | agent name; plugin agents are namespaced `sea-trials:st-shard-worker` |
| `model` | `model` (slug from the probe list; see `modelVerified`) | — |
| `claudeModel` | — | `model` alias (`haiku` / `sonnet` / `opus` / `inherit`) |
| `modelVerified` / `modelSource` | if `false`, the slug came from a static fallback — retry with `inherit` when the Task tool rejects it | same |
| `prompt` | `prompt` | `prompt` |
| `description` | `description` | `description` |
| `run_in_background` | `run_in_background: true` | run in background / do not block on it (host phrasing varies) |

Cursor call shape:

```text
Task({ subagent_type, model, description, prompt, run_in_background: true })
```

Claude Code call shape: invoke the **Agent** tool with the namespaced
agent name, the `prompt`, and `claudeModel` as `model`. Claude agent
**files** (`agents/*.md`) additionally honour frontmatter `tools`,
`maxTurns`, `isolation: worktree`, and `background: true`; Cursor reads
`name`, `description`, `model` from the same file and ignores the rest.
Our shard agents deliberately do **not** set `isolation: worktree` —
the same-branch contract needs one working tree.

Model slugs are never asserted by hand: run
`node "$ST_PLUGIN_ROOT/scripts/hooks/st-model-probe.mjs" --quiet` at
phase 0 and let `resolveModel()` pick from the probed list (see
[model-probe.md](model-probe.md)). Still unverified against host docs:
exact Claude frontmatter key names beyond `model`/`tools`, and whether
Cursor exposes `run_in_background` on every model.

## Rolling window (build shards)

```bash
EMIT="node $ST_PLUGIN_ROOT/scripts/hooks/st-build-shard-tasks.mjs \
  --manifest shards.json --root $ACTIVE_ROOT --state-file .st/shards.json"

$EMIT                      # launch every line
$EMIT --result '<json>'    # when ANY worker returns; launch every new line
$EMIT --status             # who is pending / in flight / done / blocked
```

Do **not** wait for a whole wave. The moment one worker returns,
record its result and launch whatever became ready. The stderr summary
(`ready= emitted-now= in-flight= slots=`) tells you when the window
has room; `COMPLETE` ends the loop.

## Gate lanes (prepush + CI)

```bash
node "$ST_PLUGIN_ROOT/scripts/hooks/st-parallel-tasks.mjs" --pr <n> --phases prepush,ci
```

One subagent per line (`run-gate-task`). Fields from `pr-review-push
--list-tasks` are forwarded untouched. After all dirty-tree lanes pass
the parent runs the serial committed-diff gate through
`pr-review-push` — never bare `git push`.

## Concurrency

| Host | Practical limit | Why |
| --- | --- | --- |
| Cursor | `maxParallel` ≤ 12 (default 6) | no hard cap, but ~40 concurrent subagents stall the extension host |
| Claude Code | same manifest value | parallel subagents are fine; keep the number for predictable integration |

The emitter enforces the window; you never need to batch by hand.

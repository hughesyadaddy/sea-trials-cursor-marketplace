# Dual-host subagent dispatch

## Cursor (Task tool)

Launch build shards in **one parent turn** (parallel):

```text
Task({
  subagent_type: "generalPurpose",
  description: "Build shard hybrid-gap-u",
  prompt: "<self-contained brief with ACTIVE_ROOT, paths, plan excerpt>"
})
```

Gate checks: run `pnpm agent-prepush`, `pnpm prepush`, and
`pnpm pr-local-ci` **in the parent shell** — these scripts parallelize
internally. Do **not** fan out gate tasks to subagents unless the user
explicitly requests isolated lanes via `--list-tasks`.

## Claude Code

Use the **Agent** tool or `context: fork` for isolated build shards.
Preload reference skills via subagent `skills:` when needed.

Gate checks: same `pnpm` commands from the active repo root.

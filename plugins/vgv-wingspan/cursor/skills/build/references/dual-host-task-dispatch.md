# Dual-host review agent dispatch

## Cursor (Task tool)

Launch all review agents in **one parent turn**:

```text
Task({
  subagent_type: "vgv-review-agent",
  description: "VGV review",
  prompt: "<scope + review-agent-instructions with RAW_DIR>"
})
```

Repeat for `architecture-review-agent`, `test-quality-review-agent`,
`code-simplicity-review-agent`, and `pr-readiness-review-agent` when the
calling skill includes them.

## Claude Code

Use the **Agent** tool or `context: fork` with the same prompt body.

## Shard workers (parallel build)

Shard workers are generic executors, not review agents. Launch every
ready shard in one turn and refill the window as workers return (see the
`## Parallel build` section of the build skill and
[parallel-execution-map.md](parallel-execution-map.md)).

| Host | Call |
| --- | --- |
| Cursor | `Task({ subagent_type: "generalPurpose", description: "Shard <id>", model: "composer-2.5", run_in_background: true, prompt })` — omit `model` for `reasoning` shards |
| Claude Code | `Agent` subagent per shard in one message; `model: haiku` (mechanical), `sonnet` (code), `inherit` (reasoning); `background: true`, `maxTurns` cap; `isolation: worktree` when isolation is wanted |

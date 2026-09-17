# Dual-host subagent dispatch

## Cursor (Task tool) — maximum parallel default

Sea Trials **`st-*`** skills fan out by default. Serialize only when
there is literally one task line.

### Build shards

```bash
pnpm st-build-shard-tasks -- --manifest shards.json --root "$ACTIVE_ROOT"
```

Launch **one Task per JSON line** in a **single parent turn** per wave
(`subagent_type: generalPurpose`). Re-run the emitter after parent
integration for dependent shards.

### Gate lanes (prepush + CI)

```bash
pnpm st-parallel-tasks -- --pr <n> --phases prepush,ci
```

Launch **one Task per JSON line** — parent shell runs `pnpm prepush`
(serial, committed diff) after all dirty-tree tasks pass.

Do **not** run `agent-prepush` / `pr-local-ci` lanes serially in the
parent when `--list-tasks` emits multiple lines.

### Concurrency cap

Cursor allows ~**16** concurrent subagents. When task count > 16, batch
into rounds of 16 in separate parent turns — never one-at-a-time.

## Claude Code

Use the **Agent** tool or `context: fork` for isolated build shards and
gate lanes the same way (one Agent per JSON line).

Gate checks: `pnpm st-parallel-tasks` output drives fan-out; parent runs
`pnpm prepush` after dirty-tree workers finish.

# Build shard contract

Parent authors `shards.json` before fan-out. Validate with:

```bash
node scripts/validate-shard-manifest.mjs shards.json
```

## Rules

- One shard = one package or surface (lib + matching test/)
- `paths[]` must not overlap across shards (prefix-safe)
- `dependsOn[]` forms a DAG (no cycles)
- `maxParallel` default 4, hard cap 8

## Shard worker constraints

- Edit only under listed paths in `$ACTIVE_ROOT`
- No `git push`, no new worktrees, no cross-shard edits
- End with `pnpm agent-validate -- {shard paths}`

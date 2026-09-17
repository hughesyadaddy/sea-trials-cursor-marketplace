---
name: st-powersync-triage
description: >-
  Triage PowerSync boot, upload queue, and sync lag logs into a
  connectivity vs upload vs schema checklist with runbook links. Use
  when the user pastes BootDiag, ps_crud, replication slot, or WAL
  budget errors. Spawns powersync-migration-operator for schema work.
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


# PowerSync triage

Classify failures before editing code. Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) when
bucket is ambiguous after log review. Read
`docs/runbooks/BOOT_SYNC_CONTRACT.md` for vocabulary.

## Phase 1 — Classify (connectivity first)

| Evidence | Bucket | Next |
| --- | --- | --- |
| Offline / socket / handshake | Connectivity | Network path; not schema |
| Connected + upload retry | Upload queue | `ps_crud` runbooks; never delete quarantined ops |
| Migration / sync-rules / column | Schema | Task `powersync-migration-operator` |
| Slow initial sync | Replication / rules | Sync config + slot lag runbooks |

**Never** branch on exception type alone — use connectivity state.

## Phase 2 — Checklist output

Return:

1. Bucket (connectivity | upload | schema | perf)
2. Top 3 cited log lines
3. Runbook links under `docs/runbooks/`
4. Whether a migration operator subagent is required

## Phase 3 — Subagent dispatch

When schema or sync-rules:

```text
Task({
  subagent_type: "powersync-migration-operator",
  description: "PowerSync schema triage",
  prompt: "<logs, env, table names, self-contained>"
})
```

## Forbidden

- Hand-editing `supabase/migrations/*.sql` without db diff workflow
- `skipDataLoss` / deleting unuploadable ops
- `databaseDidReconnect` as a network signal

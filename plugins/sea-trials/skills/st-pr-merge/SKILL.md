---
name: st-pr-merge
description: >-
  Merge a Sea Trials PR safely and only when every standing rule holds:
  every CI check on the head commit complete and green (all workflows,
  check runs and commit statuses), zero unresolved Codex review threads,
  new migrations ordered above the base and not colliding with other open
  PRs, merge pinned to the gated head SHA, never --admin. Use when the
  user says merge / land / ship-and-merge a PR, or when a merge
  automation fires on CI completed / review thread resolved.
user-invocable: true
---

# PR Merge (gated)

The **only** sanctioned merge path. Self-contained: needs `node` ≥ 20 and
an authenticated `gh`; no app-repo scripts, no checkout.

```bash
ST_MERGE="$ST_PLUGIN_ROOT/skills/st-pr-merge/scripts/merge-gate.mjs"
# ST_PLUGIN_ROOT = two directories above this SKILL.md (…/sea-trials),
# or resolve with the block in st-pr-review-loop-*/references/shared/
# review-loop-contract.md → "Sea Trials plugin CLI".

node "$ST_MERGE" --pr <n> --dry-run      # verdict only
node "$ST_MERGE" --pr <n> --wait 30      # gate, wait ≤30m for pending CI, merge
```

## What the gate enforces

| Rule | How |
| --- | --- |
| Every check on HEAD complete + green | GraphQL `statusCheckRollup` on the head commit — **all** workflows, check runs and commit statuses, paginated. Green = `SUCCESS`/`SKIPPED`/`NEUTRAL`. Zero checks = pending, never green. `CANCELLED`, `TIMED_OUT`, `ACTION_REQUIRED`, `STALE` = fail. |
| Late-registering suites | After a green read, waits `--settle-sec` (default 60) and re-reads; head and check set must be identical. |
| Zero unresolved Codex threads | Paginated `reviewThreads`; Codex = `chatgpt-codex-connector`. Outdated-but-unresolved still blocks. By default **any** unresolved thread blocks (`--allow-human-threads` relaxes non-Codex only). |
| Migration numbers | Added `supabase/migrations/<ver>_*.sql` must be unique, `> max(base)`, and not claimed by another open PR into the same base. `--no-migration-check` only for repos without migrations. |
| Renamed / deleted migrations | Blocked **iff the old version is applied** — present in `supabase_migrations.schema_migrations` on the base's environment: `feat/rich-content`, `dev` → Dev (`jchyjnxcnukbsmlsolha`); `stg` → Staging (`lbypalsqrvpwfxofqciz`); `main` → Prod (`oulpgrsifasfsvkrjnrn`). Read-only lookup via the Management API `database/query/read-only` endpoint using `SUPABASE_ACCESS_TOKEN` (env, else `.env.<flavor>` / `.env.base` in the repo — same order as `supabase_deploy.sh`; needs `database_read`). Never-applied renames are allowed and printed as `rename allowed:`; the new name must not collide with base or another open PR. Unmapped base, missing token or unreachable DB → blocked (fail closed, exit 4). |
| Mergeability | `BEHIND`, `DIRTY`/conflict, `BLOCKED`, draft, closed → no merge (exit 5). `UNKNOWN` → treated as pending. |
| No races | `gh pr merge --match-head-commit <gated sha>` — a push that lands mid-gate makes GitHub refuse (exit 6). |
| Never `--admin` | Rejected by the CLI parser, never built into argv, and the plugin hook denies any agent-typed `gh pr merge` / REST / GraphQL merge. |

## Exit codes → next action

| Exit | Meaning | Do |
| --- | --- | --- |
| 0 | Merged (or ready, with `--dry-run`) | Report merged SHA |
| 2 | Unresolved threads | Run `st-pr-review-loop-worktree` (Steps 2–6), then re-run |
| 3 | A check failed | Fix (or `st-flake-quarantine` if not attributable), push, re-run |
| 4 | Migration order / collision | Body Step 4b: renumber the new file, gate, push |
| 5 | Behind / conflict / blocked / draft | Merge base into the branch, gate, push; for `BLOCKED` report the protection rule — never `--admin` |
| 6 | Head moved | Re-run the loop for the new head |
| 8 | Still pending after `--wait` | Re-run later / on the next CI-completed event |
| 1 | Usage or API error | Retry; rate limit → wait for reset |

## Stacked PRs

Merge bottom-up. After a parent merges, every child whose base was the
parent must merge the new base tip in, re-gate, push, and pass this gate
again (its migration check now compares against the updated base).

## Retries

Failed or interrupted merge runs are retried until they succeed (standing
rule). The gate is idempotent: re-running after a merge reports
`PR is MERGED` (exit 5) and does nothing.

## Report

PR, head SHA gated, checks (green/total), unresolved threads (Codex),
migrations verdict, merge result / blocker, exit code.

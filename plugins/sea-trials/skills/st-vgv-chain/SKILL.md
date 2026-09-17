---
name: st-vgv-chain
description: >-
  Advance vgv_next YAML through brainstorm → plan → build → harden →
  pr-ship with AskQuestion (Cursor; AskUserQuestion on Claude Code) at each gate. Use when the user wants
  the full feature pipeline without repeating handoff picks.
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


# VGV chain

Read `vgv_next` from the attached artifact frontmatter:

```yaml
vgv_next:
  skill: plan
  artifact: docs/vgv-brainstorm/....md
```

## Chain

| Step | Skill | Handoff |
| --- | --- | --- |
| 1 | `/vgv-brainstorm` or skip if doc exists | Plan now |
| 2 | `/vgv-plan` on brainstorm doc | Build now |
| 3 | `/st-build-with-subagents` or `/vgv-build` | Continue |
| 4 | `/st-pre-push-harden` | READY |
| 5 | `/vgv-create-pr` if needed | — |
| 6 | `/st-pr-ship` | Done |

## Cursor execution

Same-chat only — no context reset commands. After each phase,
use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) with the skill's standard handoff options.

**Parallel default:** each chained `st-*` step uses maximum Task fan-out
(`st-parallel-tasks`, `st-build-shard-tasks`, adversarial + fix
emitters). Parent integrates between waves — do not serialize gate lanes
or build shards when JSON task lines exist.

## Phase pick: build vs build-with-subagents

| Plan scope | Skill |
| --- | --- |
| Multi-package / parallel waves | `/st-build-with-subagents` |
| Single package | `/vgv-build` |

## Stop conditions

- User picks Done / Stop here
- `pre-push-harden` BLOCKED — fix gates before continuing
- Review loop hands off to 30-minute CI poll (review-loop skill owns)

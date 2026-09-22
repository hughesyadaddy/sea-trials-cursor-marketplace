---
name: plan-technical-review
user-invocable: true
description: Reviews an externally-authored implementation plan for quality, VGV conventions, and scope. Plans created by /plan are already reviewed during creation.
when_to_use: Use to review a plan you did not create with /plan — a hand-written plan or one from another tool. Triggers on "review the plan", "is this plan ready", "validate my plan", or "check the plan".
argument-hint: path to plan file
effort: high
compatibility: Designed for Claude Code (or similar products with agent support)
---

# Plan technical review

Review a plan that was not created by `/plan`. `/plan` runs this same review inline during
creation, so use this skill for externally-authored plans — hand-written, from another tool,
or from a teammate.

**Plan file:** `$ARGUMENTS` (if empty, ask the user for the plan path or pick the most recent file under `docs/plan/`).

## Review

Follow the [plan review procedure](references/plan-review.md) with `<PLAN_PATH>` set to the
plan file. It runs the simplicity, VGV, and scope-splitting agents in parallel, applies their
findings to the plan inline, and resolves any scope-splitting recommendation.

### Parallel execution map check

Every Standard or Extensive plan must carry a `## Parallel execution map`
with a `shards` JSON block (spec:
[parallel-execution-map.md](../plan/references/parallel-execution-map.md)).
Validate it as part of this review and fix it inline: shard `paths` are
disjoint by prefix and do not nest; every `dependsOn` id exists and the
graph is acyclic; no `sharedFiles` entry lies under a shard's `paths`;
each shard compiles and tests on its own given its dependencies; 4 to 12
shards; `maxParallel` is 1 to 12; tiers are sane (`mechanical` only for
boilerplate, `reasoning` only for cross-cutting design). If the plan has
no map, add one from its tasks and files before handing off. Parallel
shards on one branch stay the default; do not convert them into separate
PRs unless the user asks.

## Handoff

After the review completes, use **AskUserQuestion** to present next steps:

**Question**: "Technical review complete! What would you like to do next?"

**Options:**

1. **Clear context and build (Recommended)**: clear context for a fresh start, then build
2. **Start building**: execute the plan with `/build`
3. **Refine the plan**: improve the plan based on review findings
4. **Done for now**: review complete

**If the user selects "Clear context and build"** → Follow the [clear context handoff](references/clear-context-handoff.md) for `/build` with the actual plan file path. Then stop.

**When invoked by another skill**, return control to the caller after the review completes — do not present handoff options.

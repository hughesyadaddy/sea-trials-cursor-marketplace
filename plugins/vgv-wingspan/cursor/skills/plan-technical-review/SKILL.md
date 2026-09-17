---
name: plan-technical-review
user-invocable: true
description: Reviews an externally-authored implementation plan for quality, VGV conventions, and scope. Plans created by /plan are already reviewed during creation.
when_to_use: Use to review a plan you did not create with /plan — a hand-written plan or one from another tool. Triggers on "review the plan", "is this plan ready", "validate my plan", or "check the plan".
argument-hint: path to plan file
effort: high
compatibility: Designed for Claude Code (or similar products with agent support)
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


# Plan technical review

Review a plan that was not created by `/plan`. `/plan` runs this same review inline during
creation, so use this skill for externally-authored plans — hand-written, from another tool,
or from a teammate.

**Plan file:** `$ARGUMENTS` (if empty, ask the user for the plan path or pick the most recent file under `docs/plan/`).

## Review

Follow the [plan review procedure](references/plan-review.md) with `<PLAN_PATH>` set to the
plan file. It runs the simplicity, VGV, and scope-splitting agents in parallel, applies their
findings to the plan inline, and resolves any scope-splitting recommendation.

## Handoff

After the review completes, use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) to present next steps:

**Question**: "Technical review complete! What would you like to do next?"

**Options:**

1. **Build now (Recommended)**: continue in this chat and build
2. **Refine the plan**: improve the plan based on review findings
3. **Done for now**: review complete

**If the user selects "Build now"** → Follow the [same-chat handoff](references/cursor-same-chat-handoff.md) for `/build` with the actual plan file path. Then stop.

**When invoked by another skill**, return control to the caller after the review completes — do not present handoff options.

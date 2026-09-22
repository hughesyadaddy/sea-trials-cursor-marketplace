---
name: st-sprint-plan
description: >-
  From a goal and a repo, produce a Jira-ready sprint folder
  (00-epic.md, NN-usN-slug.md stories with subtasks, sprint.json) that
  passes the dev-ready card lint. Parallel reconnaissance, parallel
  story authors, adversarial critics, then handoff to /st-jira-upload.
  Use when the user asks to plan a sprint, write user stories, or
  break an epic into cards.
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


# Sprint plan

Turn a goal into a sprint folder of dev-ready cards. Nothing here
touches Jira; `/st-jira-upload` does that afterwards.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
- [`references/intake-and-recon.md`](references/intake-and-recon.md)
- [`references/fanout-prompts.md`](references/fanout-prompts.md)

## When to use

| Situation | Skill |
| --- | --- |
| New goal, no cards yet | **This skill** |
| Folder or epic exists, cards need work | `/st-sprint-refine` |
| Folder is ready, push to Jira | `/st-jira-upload` |
| Mid-sprint QA or hygiene | `/st-jira-test-review`, `/st-jira-board-vet` |

## Autonomy

Ask only the intake questions in Phase 1. After that, finish without
asking. Make product calls from the recon and record them in the
card's Context section; the critic pass catches bad calls.

---

## Phase 0 — Locate

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SPRINT="$(_st_plugin_root)/scripts/sprint"   # contract section 11
```

Find the sprint folder root: `sprint_planning/` at the repo root by
default; otherwise the folder the user named. Do not create it yet.

---

## Phase 1 — Intake (structured questions only)

Ask at most these, in one call, skipping any the user already
answered. See `references/intake-and-recon.md` for the option lists.

1. Sprint folder name (offer a slug derived from the goal).
2. Jira project key, and whether an epic already exists (key).
3. Persona(s) and surfaces in scope (multi-select from recon of the
   repo's apps).
4. Hard constraints: must-reuse patterns, must-not-touch areas,
   deadline.
5. Anything already decided that the cards must respect.

Then state the goal back in 5-8 bullets (outcome, who benefits,
constraints, open decisions you will make yourself). Do not write
files yet.

---

## Phase 2 — Reconnaissance fan-out

Split the goal into 3-6 areas (data, service, UI, tests, ops). Launch
one read-only explorer per area in one turn on the cheap model:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: explore`, `model: composer-2.5` |
| Claude Code | `Agent` `Explore`, `model: haiku` |

Prompt template in `references/fanout-prompts.md` (Recon). Each
explorer returns a table: `Area | Exists today | Path | We will`.
Merge into one recon table. Do not invent paths; if an explorer says
a thing does not exist, the card creates it and says `new`.

Also read `repoConventionsPath` (or the repo's `AGENTS.md`,
`CONTRIBUTING.md`, `package.json` scripts) for the exact test, lint,
and E2E commands. Cards cite these verbatim.

---

## Phase 3 — Story split (parent, no files yet)

Draft the story list as a product owner would review it:

| # | Story title | Persona | SP | Subtasks (titles) | Merge order note |
| --- | --- | --- | --- | --- | --- |

Rules (contract section 8): split by merge dependency, 3-6 subtasks,
1-3 SP each, story at most 8 SP, destructive work last. Cut anything
that does not serve the goal. Present the table in chat and continue;
do not wait unless the user asked to approve the split.

Write now:

- `<folder>/sprint.json` from Phase 1 answers (contract section 2).
- `<folder>/00-epic.md` from the epic template, including the
  Stories table and Recommended merge order.

---

## Phase 4 — Author stories in parallel

One `st-sprint-author` per story, all in one turn (batch by 16 on
Cursor):

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-sprint-author` (model inherit) |
| Claude Code | `Agent` `st-sprint-author` |

Each prompt carries: repo path, folder, file name, story brief, that
story's slice of the recon table, the epic goal, sibling titles, the
exact test commands, and the full contract text. Template in
`references/fanout-prompts.md` (Author).

Collect return blocks. Any `SELF-CHECK: fail` or `GAPS` that names a
missing decision: decide it yourself and re-run that author with the
decision added.

---

## Phase 5 — Adversarial critic pass

One `st-sprint-critic` per story, `MODE: fix`, all in one turn:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-sprint-critic` (model inherit) |
| Claude Code | `Agent` `st-sprint-critic` |

Template in `references/fanout-prompts.md` (Critic). Outcomes:

| Verdict | Parent action |
| --- | --- |
| `READY` / `FIXED` | Accept |
| `NEEDS RE-PLAN` | Re-split that story in Phase 3, re-author, re-critique |

Two stories may not both claim the same file change with different
behaviour; if the critics disagree, the parent resolves it and edits
the epic Scope lines.

---

## Phase 6 — Lint gate

```bash
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --lint
```

Must exit 0 with zero errors. Fix warnings when cheap (missing subtask
SP, long task items). Then print the manifest:

```bash
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --diff
```

Everything should be in `create` for a new folder.

Finally, emit shards for the build so `/st-build-with-subagents` can
skip its Phase 0 heuristics:

```bash
node "$SPRINT/sprint-to-shards.mjs" "<folder>" --repo-root "$ACTIVE_ROOT" --dry-run
```

`--dry-run` prints the manifest to stdout without writing files; drop
it and add `--out shards.json` when the build is about to start. It
exits 1 when the story cards would not form a valid shard manifest
(overlapping paths, an undeclared shared file, a dependency cycle) and
warns `needs paths` for any card whose "Files to touch" is empty. Treat
both as lint: fix the card, not the manifest.

---

## Phase 7 — Handoff

Summarise: folder path, story count, total SP, per-story SP table,
decisions you made alone. Then offer, via the structured question
tool:

1. Upload to Jira now (Recommended) — run `/st-jira-upload <folder>`
2. Refine first — run `/st-sprint-refine <folder>`
3. Stop here

On Cursor, run the chosen skill in this chat.

---

## Forbidden

- Writing story files before Phase 2 recon finishes.
- Hardcoding a project key, site, board, or account id in a card.
- "Research", "consider", "TBD", or any contract section 5 word in a
  card. Decide, then write the decision.
- Links to `.md` files, plan docs, or transcripts as card content.
- Prerequisites, Depends on, Blocks, gate, checkpoint, or rollback
  sections inside stories or subtasks. Sequencing lives in the epic.
- Any Jira write from this skill.
- Helper scripts written into the target repo.

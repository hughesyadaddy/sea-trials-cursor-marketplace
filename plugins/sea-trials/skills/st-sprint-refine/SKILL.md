---
name: st-sprint-refine
description: >-
  Bring an existing sprint folder or an existing Jira epic up to the
  dev-ready card contract: pull cards from Jira into the folder when
  needed, run parallel critics in fix mode, verify paths against the
  repo, pass lint, then hand off to /st-jira-upload for the changed
  cards only. Use when cards exist but are vague, stale, or fail
  review.
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


# Sprint refine

Same contract as `/st-sprint-plan`, applied to cards that already
exist. The rubric is not repeated here; read the contract.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
- [`references/shared/sprint-dev-voice.md`](references/shared/sprint-dev-voice.md)
- [`references/jira-pull.md`](references/jira-pull.md)
- [`references/refine-checklist.md`](references/refine-checklist.md)

## When to use

| Input | Path |
| --- | --- |
| Sprint folder exists, Jira empty or partial | Phases 0, 2-5 |
| Jira epic exists, no folder | Phases 0, 1, 2-5 |
| Both exist | Phase 1 reconciles, then 2-5 |
| No cards anywhere | Use `/st-sprint-plan` |

## Autonomy

Ask one structured question only when the source of truth is unclear
(folder vs Jira). Otherwise finish without asking; the critics make
the calls and record them in Context sections.

---

## Phase 0 — Locate and lint baseline

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
export ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "${ST_PLUGIN_ROOT:-}" ]]; then
  _ST_RUN="$(find "${HOME}/.cursor/plugins" "${HOME}/.claude/plugins" -path '*/sea-trials/scripts/st-run.mjs' 2>/dev/null | head -1)"
  [[ -n "${_ST_RUN}" ]] || { echo "Enable sea-trials in Team Marketplace" >&2; exit 1; }
  ST_PLUGIN_ROOT="$(node "${_ST_RUN}" print-plugin-root)"
fi
SPRINT="$ST_PLUGIN_ROOT/scripts/sprint"
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --lint || true
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --diff
```

Record the error count. It is the baseline the summary compares to.
If the folder does not exist but the user gave an epic key, create the
folder and `sprint.json` with `projectKey` and `epicKey`, then go to
Phase 1.

---

## Phase 1 — Pull from Jira (when Jira is the source)

Follow `references/jira-pull.md`:

1. `getAccessibleAtlassianResources` for `cloudId`; write it to
   `sprint.json`.
2. `searchJiraIssuesUsingJql` with
   `parent = <epicKey> ORDER BY rank` for stories, then
   `parent = <STORY-KEY>` per story for subtasks. Request
   `responseContentFormat: "markdown"` for reading; this direction is
   safe.
3. Write each story to `NN-usN-<slug>.md` in the contract shape.
   Put the Jira key on the metadata line (`**Jira:** <KEY>`) and record
   keys and hashes in `jira_state.json` so the upload later edits
   rather than creates.
4. Anything in a Jira card that the template has no section for goes
   under `## Context`; nothing is dropped.

When both exist and differ, the structured question offers:
`Folder wins`, `Jira wins (Recommended when others edited in Jira)`.

---

## Phase 2 — Reconnaissance for cited paths

Collect every path cited across the folder:

```bash
rg -o '`[^`]+\.[a-z]{1,5}`' "<folder>" | sort -u
```

Launch one read-only explorer per 20 paths (cheap model; dispatch
table in the contract, section 12) to confirm each exists or is
marked `new`, and to read the repo's conventions file for exact test
commands. Merge into a `Path | Exists | Note` table for the critics.

---

## Phase 2b — Cull non-work (before critics)

Walk every story with `sprint-dev-voice.md`:

- Remove subtasks or whole stories that are not user-visible defects,
  product-declined behaviour, audit/capture homework, or token-only
  polish without product sign-off.
- Record removals in `<folder>/_internal/pm/REMOVED-CARDS.md` (create
  `pm/` if needed). Do not replace removed cards with softer wording.
- Renumber subtasks contiguously in markdown. Update epic Stories SP
  table if totals change.

Jira keys for removed cards are deleted during `/st-jira-upload`, not
renamed `[Cancelled]`.

---

## Phase 3 — Critics in fix mode, in parallel

One `st-sprint-critic` per story, `MODE: fix`, one turn, batch by 16
on Cursor. Prompt: repo path, folder, file, the path table, the exact
test commands, the epic goal, sibling titles, and the full contract
text. Use `references/refine-checklist.md` as the extra lens list
(strip-list for legacy sections, kind-specific expectations).

| Verdict | Parent action |
| --- | --- |
| `READY` / `FIXED` | Accept |
| `NEEDS RE-PLAN` | Re-split with `/st-sprint-plan` Phase 3 rules, re-author with `st-sprint-author`, re-critique |

Epic file: the parent refines it directly (Stories table, merge
order, no per-story detail that belongs on the cards).

---

## Phase 4 — Lint gate and diff

```bash
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --lint
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --diff
```

Lint must exit 0. The diff shows which cards changed; only those will
be edited in Jira. Print before/after error counts.

---

## Phase 5 — Handoff

Summary: cards touched, verdict per story, decisions made alone,
before/after lint counts. Then offer via the structured question tool:

1. Upload changed cards now (Recommended) — `/st-jira-upload <folder>`
2. Stop here

---

## Forbidden

- Any Jira write from this skill. Reads only (deletes happen in upload).
- Rewording a non-defect into a weaker AC instead of deleting the card.
- Deleting content from a card because it lacks a template slot;
  move it to Context instead.
- Leaving `[Cancelled]` summaries in Jira when the work is withdrawn.
- Repeating the contract rubric in this skill or its references.
- Patching a wrong split with wording. Return `NEEDS RE-PLAN`.

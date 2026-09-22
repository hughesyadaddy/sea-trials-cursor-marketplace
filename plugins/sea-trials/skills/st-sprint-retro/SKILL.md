---
name: st-sprint-retro
description: >-
  End-of-sprint retro: run Wingspan's debrief on every PR in the sprint
  (parallel), condense each into a short human comment on its Jira
  story, build metrics from the shared telemetry ledger plus git, and
  publish a "Sprint <n> retro" Confluence page and a local retro.md.
  Use when a sprint closes or the user asks for a retro or debrief.
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


# Sprint retro

Facts first, prose second. The numbers come from the telemetry ledger
and git; the words come from the debriefs; everything that reaches Jira
or Confluence reads as if the signed-in person typed it.

**Read first:**

- [`references/retro-template.md`](references/retro-template.md)
  (page layout, comment shape, forbidden-language families F1-F7)
- [`references/confluence-upload.md`](references/confluence-upload.md)
  (MCP call shapes for comments and pages)
- `skills/_sources/sprint-contract.md` sections 5, 7, 11

## Autonomy

Run debriefs and metrics without asking. Ask one structured question
before posting: show the drafted comments and the page, offer
"post all", "post comments only", "page only", "stop". Never post on
the first pass without that confirmation.

---

## Phase 0 — Scope

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SPRINT="$(_st_plugin_root)/scripts/sprint"   # contract section 11
FOLDER=sprint_planning/<sprint>              # given, else newest
```

Read `sprint.json` (`projectKey`, `cloudId`, `site`, `repo`,
`startDate`, `endDate`, `confluenceSpaceKey`, `confluenceParentId`)
and `jira_state.json` (story keys). PRs for the sprint:

```bash
gh pr list --state merged --search "merged:>=<startDate> <KEY-1> OR <KEY-2> ..." \
  --json number,title,url,headRefName,mergedAt --limit 100
```

Attribute each PR to a story key found in its title, branch, or body.
PRs with no key go under "Unattributed" in the page and get no comment.

---

## Phase 1 — Debrief per PR (parallel)

One worker per PR, all in one turn, cheap model, read-only:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: generalPurpose`, `model: composer-2.5`; prompt says "run `/debrief` on PR <n>" |
| Claude Code | `Agent` general-purpose, `model: sonnet`; prompt says "run `/vgv-wingspan:debrief` on PR <n>" |

Worker prompt (self-contained): repo root, PR number and URL, story
key and title, the debrief skill name for its host, and the return
format: `PR | Story | What changed | Decisions | Surprises | Left open`
as one row plus up to five lines of notes. Workers never write to Jira,
Confluence, or the repo. Save each return to `/tmp/retro/<KEY>-<n>.md`.

---

## Phase 2 — Story comments

Facts per story:

```bash
node "$SPRINT/retro-metrics.mjs" --sprint "$FOLDER" --repo-root "$REPO_ROOT" \
  --story-comment <KEY> > /tmp/retro/<KEY>.comment.md
```

Dispatch one `st-retro-writer` per story (see contract section 12 for
the dispatch table shape):

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-retro-writer`, `model: inherit` |
| Claude Code | `Agent` `sea-trials:st-retro-writer`, `model: inherit` |

Give it the facts paragraph, the debrief rows for that story, and the
template. It returns the final comment (at most six lines, plain
prose). Then, for every comment:

```bash
node "$SPRINT/retro-metrics.mjs" --check-voice /tmp/retro/<KEY>.comment.md
node "$SPRINT/md-to-adf.mjs" /tmp/retro/<KEY>.comment.md \
  --out /tmp/retro/<KEY>.comment.adf.json
```

`--check-voice` must exit 0 (F1-F7 in the template). Post with
`addCommentToJiraIssue`, `contentFormat: "adf"`, per
`references/confluence-upload.md`. Space posts 2-8 s apart, at most 4
in flight.

---

## Phase 3 — Metrics page

```bash
node "$SPRINT/retro-metrics.mjs" --sprint "$FOLDER" --repo-root "$REPO_ROOT" \
  --md > /tmp/retro/page.md
node "$SPRINT/retro-metrics.mjs" --check-voice /tmp/retro/page.md
```

Hand `/tmp/retro/page.md` plus the debrief rows to one `st-retro-writer`
with `MODE: page`. It returns the full page body: the five metric
sections unchanged, then `## What went well`, `## What slowed us`,
`## Decisions for next sprint` (three tables, from the debriefs). Run
`--check-voice` on the result, then create or update "Sprint <n> retro"
under the configured parent (`createConfluencePage` /
`updateConfluencePage`; read the live schema first, shapes in
`references/confluence-upload.md`). Search by exact title before
creating so a re-run updates instead of duplicating.

---

## Phase 4 — Local record

Write `sprint_planning/<sprint>/retro.md`: the page body, then a
`## Posted` table `Key | Comment posted | Page version`. Commit nothing;
the user decides.

---

## Phase 5 — Summary

```text
| Story | Key | PRs | Comment | Page section |
| --- | --- | --- | --- | --- |
```

Plus the page URL and anything left manual. Offer via the structured
question tool: open the page, run `/st-sprint-plan` for the next sprint
(Recommended when the board is empty), or stop.

---

## Forbidden

- Posting a comment or page whose `--check-voice` run exits 1.
- Any word from contract section 5 or the F1-F7 table, emojis, headers
  or bullets in Jira comments, sign-offs, "Summary:" labels.
- Naming who or what wrote the text, or how it was made.
- Inventing numbers: every figure traces to the ledger or `git log`.
- Posting before the Phase 2/3 confirmation.
- `contentFormat: "markdown"` for comment bodies.
- Editing card descriptions or transitioning issues; that is other skills.

---
name: st-jira-upload
description: >-
  Upload a lint-clean sprint folder to Jira idempotently: epic, stories,
  subtasks, story points, labels, Blocks links, sprint assignment and
  rank, all as the signed-in user with ADF checkboxes. Parallel
  uploader workers, parallel verifiers, jira_state.json written at the
  end. Use when a sprint folder is ready or has changed cards.
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


# Jira upload

Folder to Jira. Markdown is the source; Jira is the copy. Every card
renders real checkboxes, nothing is duplicated, only changed cards are
touched on re-runs.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
  (sections 2, 10, 11, 12)
- [`references/mcp-call-shapes.md`](references/mcp-call-shapes.md)
- [`references/rest-and-browser-fallbacks.md`](references/rest-and-browser-fallbacks.md)

## Autonomy

No questions once the folder lints clean, except one structured
confirmation before any delete. Missing config values are discovered
and written back to `sprint.json`, not asked for.

---

## Phase 0 — Preflight

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SPRINT="$(_st_plugin_root)/scripts/sprint"     # contract section 11
FOLDER="<folder>"; SCRATCH=$(mktemp -d /tmp/sprint.XXXX)
node "$SPRINT/parse-sprint-folder.mjs" "$FOLDER" --lint
node "$SPRINT/parse-sprint-folder.mjs" "$FOLDER" --out "$SCRATCH/payload.json"
node "$SPRINT/parse-sprint-folder.mjs" "$FOLDER" --diff
```

Lint must exit 0. If it fails, stop and run `/st-sprint-refine`.

Resolve config (write anything discovered back to `sprint.json`):

| Value | Source, in order |
| --- | --- |
| `cloudId` | `sprint.json`, else `getAccessibleAtlassianResources` (match `site`) |
| `projectKey` | `sprint.json` (required) |
| `storyIssueType`, `subtaskIssueType` | `sprint.json`, else `getJiraProjectIssueTypesMetadata` |
| `storyPointsFieldId` | `sprint.json`, else `node "$SPRINT/jira-rest.mjs" fields --name "Story point"`, else create one story and read `*all` fields back to find the numeric SP field |
| `assigneeAccountId` | `sprint.json`, else `lookupJiraAccountId` by the name the user gave, else unassigned |
| `sprintId` | `sprint.json`, else `jira-rest.mjs sprints <boardId> --state active,future` |

Print the manifest from `--diff` (create / update / unchanged counts).
If everything is `unchanged`, report that and stop.

---

## Phase 1 — Epic

| State | Action |
| --- | --- |
| `epicKey` in `sprint.json` or state file | `getJiraIssue` to confirm it exists; edit description only if the epic is in `update` |
| No epic key | `createJiraIssue` `issueTypeName: "Epic"`, ADF body from `00-epic.md` via `md-to-adf.mjs --strip-h1`; write `epicKey` to `sprint.json` |

Read back and run the parity check (contract 10.3).

---

## Phase 2 — Stories in parallel (max 4 writers)

One `st-jira-uploader` per story in `create` or `update` (or whose
subtasks are), at most 4 concurrent per site; queue the rest in
waves. Cheap model:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-jira-uploader`, `model: composer-2.5` |
| Claude Code | `Agent` `st-jira-uploader`, `model: haiku` |

Each prompt carries: `SPRINT`, `SCRATCH/<id>/`, payload path, the
resolved config, `epicKey`, the story's buckets from `--diff`, and the
current key map for `Blocked by` resolution. Prompt template in
`references/mcp-call-shapes.md`.

Worker order inside a story: story card, subtasks in document order,
story points, labels, then `Blocks` links. Workers pace themselves
(2-8 s jitter) and honour `Retry-After`.

Collect return blocks. Any `PARITY: FAIL` or `ERRORS` line: fix the
markdown or ADF, re-run that one worker with only the failed cards.

---

## Phase 3 — Verification fan-out

One `st-jira-verifier` per 10 keys, all in one turn, cheap model.
Input: keys, `storyPointsFieldId`, and the source markdown per key
from the payload. Verifier checks parity (P1-P3), content (C1-C6), and
fields (F1-F5). Any error: fix and re-edit via the uploader, then
re-verify those keys. Do not finish with a known error.

---

## Phase 4 — Sprint, rank, attachments

Not in MCP v1. Use REST when `JIRA_SITE`, `JIRA_EMAIL`, and
`JIRA_API_TOKEN` are set:

```bash
node "$SPRINT/jira-rest.mjs" move-to-sprint "<sprintId>" <STORY-KEYS...>
node "$SPRINT/jira-rest.mjs" rank <KEY2> --after <KEY1>   # epic order
```

Rank stories in the epic's Recommended merge order. Subtasks follow
their parent; do not move them separately. If your MCP is v2
(`manageJiraSprint` present), use it instead of REST. Without either,
dispatch `st-jira-browser-operator` per
`references/rest-and-browser-fallbacks.md`, or report the step as
manual.

---

## Phase 5 — State file

Write `<folder>/jira_state.json` in the contract 10.4 shape from the
worker return blocks and the payload hashes. Then:

```bash
node "$SPRINT/parse-sprint-folder.mjs" "$FOLDER" --diff
```

Everything must now be `unchanged`. If not, a hash was recorded wrong;
fix it from the payload before finishing. Never commit or push; the
user decides whether the folder is versioned.

---

## Phase 6 — Summary

```text
| Card | Key | Action | Tasks | Sprint |
| --- | --- | --- | --- | --- |
| Epic | <KEY> | reused | - | - |
| US1 | <KEY> | created | 5/5 | <sprint name> |
| US1.1 | <KEY> | created | 2/2 | (parent) |
```

Plus: `cloudId`, `storyPointsFieldId`, and `epicKey` values written to
`sprint.json`; any step left manual. Offer via the structured
question tool:

1. Run `/st-jira-board-vet` on the sprint (Recommended)
2. Stop here

---

## Forbidden

- `contentFormat: "markdown"` for any description or comment body.
- `customfield_10014` for the epic parent; use `parent.key`.
- Creating a card that has a key in `jira_state.json`.
- Uploading a folder that fails lint.
- Adding, dropping, or rewording card content during upload. Fix the
  markdown, re-lint, re-run.
- More than 4 concurrent writers per site; no jitter between writes.
- `historyMetadata`, emojis, or any word from contract section 5 in
  summaries, bodies, or link comments.
- Writing helper scripts into the target repo.
- Deleting anything without the one structured confirmation.

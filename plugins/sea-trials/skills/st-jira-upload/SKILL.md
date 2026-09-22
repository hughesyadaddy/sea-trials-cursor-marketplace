---
name: st-jira-upload
description: >-
  Upload a lint-clean sprint folder to Jira idempotently: epic, stories,
  subtasks, story points, labels, Blocks links, sprint assignment and
  rank, all as the signed-in user with ADF checkboxes, on a human
  cadence (one epic at a time, spaced writes, working hours). One
  uploader per story in sequence, parallel verifiers, jira_state.json
  written at the end. Use when a sprint folder is ready or has changed
  cards.
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
touched on re-runs, and the activity stream reads like one person's
afternoon, not a burst.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
  (sections 2, 5, 7, 10, 11, 12, and "Cadence and voice in Jira")
- [`references/human-cadence.md`](references/human-cadence.md)
- [`references/mcp-call-shapes.md`](references/mcp-call-shapes.md)
- [`references/rest-and-browser-fallbacks.md`](references/rest-and-browser-fallbacks.md)

## Autonomy

No questions once the folder lints clean, except one structured
confirmation before any delete. Missing config values are discovered
and written back to `sprint.json`, not asked for.

Flags: `--dry-run` runs Phases 0 and 1 and stops (manifest and
schedule printed, nothing written). `--fast` collapses the schedule
gaps and is allowed **only** with `--dry-run` or when `projectKey` is
listed in `sprint.json.testProjectKeys`; anywhere else, ignore it and
say so. `--ignore-hours` writes outside the activity window; use it
only when the person says they are at the keyboard now.

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

## Phase 1 — Cadence schedule

Every write in this run happens at a planned offset. Plan once, from
the payload, before the first write:

```bash
node "$SPRINT/human-cadence.mjs" plan "$SCRATCH/payload.json" \
  --edit-field labels --json > "$SCRATCH/schedule.json"
node "$SPRINT/human-cadence.mjs" plan "$SCRATCH/payload.json" --edit-field labels
node "$SPRINT/human-cadence.mjs" window        # exit 3 = closed, prints wait
```

Print the table (id, offset, batch) and the `total:` line so the person
knows how long the run takes. Add `--fast` only under the rule in
Autonomy; add `--seed N` to reproduce a previous plan.

What the schedule means for you:

- Entries are executed **in schedule order**, each no earlier than
  `T0 + startOffsetMs`. `T0` is the wall-clock ISO time of the first
  write; record it in `SCRATCH/T0` and pass it to every worker.
- A create with `deferField: "labels"` goes out **without** labels; its
  `<id>#edit` entry sets them later with `editJiraIssue`.
- Sleeping between calls is done with the script, not by guessing:
  `node "$SPRINT/human-cadence.mjs" wait --start "$T0" --offset <ms>`
  before each write (a plain `sleep N` is acceptable when the script
  is unavailable; keep the same offsets). `wait` also blocks while the
  activity window is closed; the run **waits** for 08:00 local, it does
  not skip cards and it does not write at night.
- Reads (`getJiraIssue`, JQL) carry no cadence and may happen any time.

If the window is closed and the person has not said `--ignore-hours`,
tell them when the run will start and keep waiting; do not ask.

`--dry-run` stops here.

---

## Phase 2 — Epic

| State | Action |
| --- | --- |
| `epicKey` in `sprint.json` or state file | `getJiraIssue` to confirm it exists; edit description only if the epic is in `update` |
| No epic key | at the epic's schedule entry (offset 0, this is `T0`): `createJiraIssue` `issueTypeName: "Epic"`, ADF body from `00-epic.md` via `md-to-adf.mjs --strip-h1`; write `epicKey` to `sprint.json` |

Read back and run the parity check (contract 10.3). When the epic is
reused, `T0` is the moment the first story write fires in Phase 3.

---

## Phase 3 — Stories, one uploader at a time

**One `st-jira-uploader` per story, run in sequence, never two into the
same board at once.** Parallel uploaders into one project interleave
stories and break the schedule. Parallelism is allowed only across
different projects or sites, each with its own payload, schedule, and
`T0`. Cheap model:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-jira-uploader`, `model: composer-2.5` |
| Claude Code | `Agent` `st-jira-uploader`, `model: haiku` |

Slice `schedule.json` **by time, not by story**: the uploader for story
N gets every entry from N's story card up to the entry before story
N+1's story card. That slice can include an `<id>#edit` entry from an
earlier story whose 20-90 s delay lands here; pass it the key from the
earlier return block. Entries after the last story card go to the
last uploader.

Each prompt carries: `SPRINT`, `SCRATCH/<id>/`, payload path, `T0`,
the schedule slice (id, action, offset, deferField, field), the
resolved config, `epicKey`, the story's buckets from `--diff`, the
current key map for `Blocked by` resolution, and, for `update` cards,
one line from `human-cadence.mjs vary comment-opener` per card. Prompt
template in `references/mcp-call-shapes.md`.

Worker order inside a story follows the slice: story card, subtasks in
document order, any `#edit` that lands in the slice, then `Blocks`
links 3-10 s apart after the last entry. Story points and labels ride
on the create unless the entry defers labels. Workers call `wait`
before every write and honour `Retry-After`.

Collect return blocks. Any `PARITY: FAIL` or `ERRORS` line: fix the
markdown or ADF, re-run that one worker with only the failed cards,
still on the schedule (a repair edit is a write; give it a fresh
offset at least 20 s after the previous write).

---

## Phase 4 — Verification fan-out

One `st-jira-verifier` per 10 keys, all in one turn, cheap model.
Input: keys, `storyPointsFieldId`, and the source markdown per key
from the payload. Verifiers only read, so they run in parallel with
no cadence. Verifier checks parity (P1-P3), content (C1-C6), and
fields (F1-F5). Any error: fix and re-edit via the uploader on the
schedule, then re-verify those keys. Do not finish with a known error.

Verifiers are read-only by default. If the person asked for a
verification remark on the cards, give each verifier its remark
entries: key, `T0`, an offset (extend the schedule: 20-45 s apart,
after the last uploader write), and one verbatim line per card from
`human-cadence.mjs vary verifier-remark`. Those comments are the only
writes a verifier makes and they follow the schedule like any other.

---

## Phase 5 — Sprint, rank, attachments

Not in MCP v1. Use REST when `JIRA_SITE`, `JIRA_EMAIL`, and
`JIRA_API_TOKEN` are set:

```bash
node "$SPRINT/jira-rest.mjs" move-to-sprint "<sprintId>" <STORY-KEYS...>
node "$SPRINT/jira-rest.mjs" rank <KEY2> --after <KEY1>   # epic order
```

Rank stories in the epic's Recommended merge order. Subtasks follow
their parent; do not move them separately. These are bulk calls a
person also makes in one go (drag-select in the backlog), so one
`move-to-sprint` and one rank pass are fine; leave 20-45 s between the
last card write and the sprint move. If your MCP is v2
(`manageJiraSprint` present), use it instead of REST. Without either,
dispatch `st-jira-browser-operator` per
`references/rest-and-browser-fallbacks.md`, or report the step as
manual. A card leaving the sprint gets one `vary moved-to-backlog`
comment.

---

## Phase 6 — State file

Write `<folder>/jira_state.json` in the contract 10.4 shape from the
worker return blocks and the payload hashes. Then:

```bash
node "$SPRINT/parse-sprint-folder.mjs" "$FOLDER" --diff
```

Everything must now be `unchanged`. If not, a hash was recorded wrong;
fix it from the payload before finishing. Never commit or push; the
user decides whether the folder is versioned.

---

## Phase 7 — Summary

```text
| Card | Key | Action | Tasks | Sprint |
| --- | --- | --- | --- | --- |
| Epic | <KEY> | reused | - | - |
| US1 | <KEY> | created | 5/5 | <sprint name> |
| US1.1 | <KEY> | created | 2/2 | (parent) |
```

Plus: `cloudId`, `storyPointsFieldId`, and `epicKey` values written to
`sprint.json`; the seed and total duration from the schedule; any step
left manual. Offer via the structured question tool:

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
- Two uploaders into the same project or board at once; any write
  ahead of its schedule offset; two writes in the same second.
- `--fast` outside `--dry-run` or a `testProjectKeys` project.
- Writing outside the activity window without `--ignore-hours` from
  the person.
- `historyMetadata`, emojis, exclamation marks, em dashes, or any word
  from contract section 5 in summaries, bodies, comments, or link
  comments. Free text comes from `human-cadence.mjs vary` or passes
  `human-cadence.mjs check`.
- Mentioning tooling, automation, or who or what wrote the card in
  anything that goes to Jira.
- Writing helper scripts into the target repo.
- Deleting anything without the one structured confirmation.

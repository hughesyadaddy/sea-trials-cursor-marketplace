<!-- GENERATED from skills/_sources/sprint-contract.md — do not edit; run node scripts/sync-skill-sources.mjs -->
# Sprint card contract

Shared by `st-sprint-plan`, `st-sprint-refine`, `st-jira-upload`,
`st-jira-test-review`, and `st-jira-board-vet`. Read it before the first
phase of any of those skills. It defines what a dev-ready card looks
like, how the sprint folder is laid out, and how cards reach Jira.

Opening principle: every card is the only document the developer will
read for that piece of work. If they need another card, a markdown
file, a plan doc, or a chat transcript to start, the card failed.

## 1. Folder convention

Default folder: `sprint_planning/<sprint-name>/` at the repo root. The
folder name is configurable; the layout is not.

| File | Purpose |
| --- | --- |
| `00-epic.md` | Epic. Any file starting `00` and containing `epic` |
| `NN-usN-<slug>.md` | One story per file, e.g. `03-us3-invoice-pdf.md` |
| `sprint.json` | Project settings (section 2) |
| `jira_state.json` | Written by the uploader; never hand-edit keys |

Story id is the `usN` part (`03-us3-...` is story `3`; `03-us3a-...` is
`3a`). Story files sort by the `NN` prefix. Nothing else in the folder
is uploaded.

## 2. `sprint.json`

Every project-specific value lives here. Skill bodies never hardcode a
project key, site, board, or account id.

```json
{
  "site": "https://<site>.atlassian.net",
  "cloudId": "<uuid, optional; discovered when absent>",
  "projectKey": "<PROJECT_KEY>",
  "boardId": 12,
  "sprintId": 345,
  "epicKey": "<PROJECT_KEY>-100",
  "storyIssueType": "Story",
  "subtaskIssueType": "Subtask",
  "storyPointsFieldId": "customfield_10016",
  "labels": ["sprint-12"],
  "assigneeAccountId": "<accountId>",
  "testerAccountId": "<accountId>",
  "repoConventionsPath": "AGENTS.md",
  "reviewStatuses": ["In Review", "Ready for QA"],
  "doneStatus": "Done",
  "reopenStatus": "In Progress",
  "testProjectKeys": ["SANDBOX"],
  "activityHours": "08:00-19:30",
  "timezone": "America/New_York"
}
```

Only `projectKey` is required. `testProjectKeys` lists projects where
the uploader may run with `--fast` (no human cadence); `activityHours`
and `timezone` feed the activity window in section 5.1. `epicKey` absent means the uploader
creates the epic. `subtaskIssueType` is `Subtask` on team-managed
projects and `Sub-task` on most company-managed ones; check with
`getJiraProjectIssueTypesMetadata` when unsure. `repoConventionsPath`
points at the file that documents how to run tests, lint, and E2E in
that repo; the test-review skill reads it instead of guessing commands.

## 3. Card anatomy

The parser is `scripts/sprint/parse-sprint-folder.mjs`. The templates
below are the exact shapes it expects. Rules the parser enforces:

- The first `# H1` is the summary. Epic H1 may start `Epic:`; the
  prefix is stripped.
- Metadata is a bold key/value line placed as the first non-blank line
  after the H1 (or after a subtask header). Known keys: `Jira`, `SP`,
  `Blocked by`, `Labels`, `Assignee`. Join several with ` | `. Any
  other bold label is body text.
- Story body runs until `## Subtasks`. Text between `## Subtasks` and
  the first subtask header is discarded.
- Subtask headers are `### Subtask N.M: Title`. A subtask body ends at
  the next heading of level 3 or higher, so subtask sections use bold
  labels, not headings. `####` inside a subtask parses but warns.
- Task items are `- [ ] text` on one line, at most 200 characters.
- The story must contain `## Acceptance criteria` (or `## AC`) with at
  least one open `- [ ]`. Every subtask must contain at least one.

### 3.1 Epic (`00-epic.md`)

```markdown
# Epic: <outcome in plain words>

## Goal

Two or three sentences. Who benefits, what changes for them.

## Success measures

- <metric or observable outcome>
- <metric or observable outcome>

## Stories

| Story | Title | SP |
| --- | --- | --- |
| US1 | <title> | 5 |

## Recommended merge order

US1.1 then US1.2 then US2.1. One sentence on why.
```

The epic is the only place sequencing lives. Never copy merge order,
gates, or "after USx" language into stories or subtasks.

### 3.2 Story (`NN-usN-<slug>.md`)

```markdown
# User Story N: <outcome a product owner would demo>

**SP:** 5 | **Labels:** <label>

## Description

As a <role>, I want to <action> so that <benefit>.

## Context

Two to four sentences: what exists today, what changes, why now.

## Scope

| In this story | Not this story |
| --- | --- |
| <slice> | <slice that belongs elsewhere> |

## Files to touch

- `path/to/file.ext` - <concrete change>
- `path/to/new_file.ext` - new; <what it holds>

## Acceptance criteria

- [ ] Given <state>, when <action>, then <observable result>.
- [ ] Given `<command>` runs, when it finishes, then it exits 0.

## Test plan

- `<exact test command>`
- Manual: <device or browser>, <steps>, <what to look for>

## Out of scope

- <thing a reader might assume is included>

## Subtasks

### Subtask N.1: <imperative title>

**SP:** 2

**Done when:** one sentence a reviewer can check.

**Files to change**

- `path/to/file.ext` - <concrete change>

**Acceptance criteria**

- [ ] Given <state>, when <action>, then <observable result>.
- [ ] `<exact command>` exits 0.

### Subtask N.2: <imperative title>

**SP:** 2 | **Blocked by:** N.1

**Done when:** ...

**Files to change**

- ...

**Acceptance criteria**

- [ ] ...
```

Add `**Blocked by:** US2` to a story metadata line when a whole story
depends on another. The uploader turns it into a `Blocks` link. It is
the only allowed cross-card reference.

Story kinds may swap the middle sections while keeping the mandatory
ones (Description, Scope, Files to touch, Acceptance criteria, Test
plan, Out of scope, Subtasks):

| Kind | Extra sections |
| --- | --- |
| UI | `## What the user sees` (2-4 sentences) |
| Ops / migration | `## Commands` (numbered, copy-paste), `## Expected results` |
| Verification / QA | `## What to test`, `## Platforms` |

## 4. Acceptance criteria quality bar

Each AC line is one behaviour, observable, and verifiable by either a
command that exits 0 or a UI step a tester can perform without asking.

| Bad | Good |
| --- | --- |
| Works correctly | Given 3 items in cart, when I tap Pay, then total reads $42.00 |
| Handles errors | Given the API returns 500, when I tap Save, then a snackbar reads "Could not save" and the form keeps my input |
| Tests pass | `pnpm test -- billing` exits 0 |
| Looks good on mobile | Given a 375px viewport, when the page loads, then no horizontal scrollbar appears |

Limits: story AC 3-10 lines, subtask AC 2-6 lines (verification
subtasks up to 10). One build/test AC per story is enough; do not
repeat it on every subtask unless that subtask owns tests. Never write
an AC that references another card's completion.

## 5. Banned phrasing

Lint (`parse-sprint-folder.mjs --lint`) fails on the first group. The
authoring and critic passes must also remove the second group.

Lint errors: `maybe`, `consider`, `might want to`, `explore whether`,
`investigate if`, `TBD`, `TODO:`, `look into`, a task item beginning
`Research`, any link or path ending `.md`, and the tells `Claude`,
`Cursor`, `ChatGPT`, `Copilot`, `As an AI`, `LLM`, `subagent`,
`Task(`.

Contract bans: `research`, `spike`, `explore`, `investigate`,
`evaluate options`, `as needed`, `if possible`, `where appropriate`,
`etc.`, `and so on`, `works correctly`, `looks good`, `user-friendly`,
`handle edge cases`, `see subtask`, `see story`, `per the overview`,
`once USx is merged`, `Phase 0`, `gate`, `checkpoint`, `rollback plan`,
`AI`, `agent`, `generated`, `assistant`, `prompt`, `model output`, any
`{{placeholder}}` or `<angle-bracket>` left from a template, and
emojis.

A card that needs research is not ready. Do the research while
authoring, then write the decision into the card.

### 5.1 Cadence and voice in Jira

Applies to every write `st-jira-upload`, its uploaders, and its
verifiers make. For those writes it replaces the 2-8 s spacing and
4-writer cap in section 7; the tool is `scripts/sprint/human-cadence.mjs`
(detail in `st-jira-upload/references/human-cadence.md`).

- Plan before the first write (`human-cadence.mjs plan payload.json`)
  and execute in that order: one epic at a time, epic card first,
  stories in folder order, each story's subtasks right after it.
- Gaps between cards follow the plan: median 12 s, never under 3 s or
  over 45 s, plus a 60-180 s pause after every 6-10 cards. A 30-card
  sprint takes 8-15 minutes. Never two writes in the same second.
- One uploader per project or board at a time. Parallelism only
  across different projects or sites, each with its own plan.
- Roughly one create in ten deliberately leaves `labels` off and sets
  them with a one-field edit 20-90 s later. Content never changes.
- Writes happen 08:00-19:30 local, Monday to Friday; the run waits for
  the window instead of skipping. `--ignore-hours` only when the
  person says they are at the keyboard. `--fast` only for `--dry-run`
  or a project listed in `sprint.json.testProjectKeys`.
- Free text (comments, backlog notes, verifier remarks) comes from
  `human-cadence.mjs vary <kind>`; anything else passes
  `human-cadence.mjs check` first. No exclamation marks, no em dashes,
  no emojis, no sign-offs, never a word about tooling, automation, or
  how the card was produced.

## 6. No-links rule

All information lives in the card. Never link to or name a markdown
file, plan document, wiki page, or transcript as a substitute for
content. Code paths written as text (`lib/billing/invoice_page.dart`)
are required, not banned. URLs to the product under test, a design
file, or an external API reference are allowed when the card would be
incomplete without them.

## 7. Human voice

Every write happens as the authenticated person. Cards, comments, and
transitions must read as if that person typed them.

- Plain English, short sentences, active voice. Written for readers
  who are not native English speakers.
- Vary sentence openers and comment phrasing across cards; no two
  comments in one run start the same way.
- Comments in first person, terse, specific: what I did, what I saw,
  which AC passed or failed, repro steps on a fail.
- No sign-offs, no "Summary:" headers in comments, no bullet walls
  when two sentences do the job.
- Never pass `historyMetadata` on a transition.
- Space bulk writes per section 5.1: one writer per board, gaps from
  `human-cadence plan`, writes only inside the activity window.
  Parallel writers are allowed only across different boards.

## 8. Sizing

| SP | Meaning |
| --- | --- |
| 1 | Under half a day, one file, no unknowns |
| 2 | One day, a few files, pattern exists in the repo |
| 3 | Two days, new component or endpoint following a known pattern |
| 5 | Three to four days, touches two layers, one integration point |
| 8 | A full week; only allowed with 4+ subtasks |

Split any story over 8 SP. Subtasks are 1-3 SP and one reviewable PR
each. Three to six subtasks per story is normal. Split by merge
dependency (schema, then service, then UI, then cleanup), not by role.
Destructive work (deleting routes, renaming tables) is its own subtask
after the replacement ships. Story SP is the sum of subtask SP.

## 9. Definition of Done

A card is done when all of these hold:

- Every AC checkbox on the story and its subtasks is verifiable now.
- The test plan commands were run by the tester and exit 0.
- Manual steps were performed on the listed platform.
- No new lint errors in the touched files.
- The QA comment on the card records what was run and the result.
- Status is the project's done status; nothing left in review.

Write the DoD once in the epic if the project needs extra items (docs,
release notes, telemetry). Do not repeat it on every card.

## 10. Upload and verify contract

### 10.1 Format

Convert markdown with `scripts/sprint/md-to-adf.mjs` and pass the ADF
object as `description` with `contentFormat: "adf"`. Never send
`contentFormat: "markdown"` for card bodies: `- [ ]` becomes literal
`[ ]` text inside a bullet. The converter validates with `validateAdf`
and exits 1 on an invalid document; do not upload if it fails.

### 10.2 Field mapping

| Card element | Jira field |
| --- | --- |
| H1 | `summary` (story: keep the `User Story N:` prefix) |
| Body (parser `description`) | `description` as ADF |
| `**SP:**` | `additional_fields: {"<storyPointsFieldId>": N}` |
| `**Labels:**` plus `sprint.json` labels | `additional_fields: {"labels": [...]}` |
| Epic parent | `additional_fields: {"parent": {"key": "<epicKey>"}}` |
| Subtask parent | `parent: "<STORY-KEY>"` with `issueTypeName` subtask |
| `**Blocked by:** US2` | `createIssueLink` type `Blocks`, inward = blocker |
| Assignee | `assignee_account_id` from `sprint.json` |

Never use `customfield_10014` for the epic parent. Discover the story
points field id with `jira-rest.mjs fields --name "Story point"` when
`sprint.json` lacks it, and write it back to `sprint.json`.

### 10.3 Parity check

After each create or edit, read the issue back with `getJiraIssue`
(`responseContentFormat: "adf"`) and confirm:

- `taskItem` count equals the `- [ ]` count in the source markdown.
- `heading` count equals the heading count in the source body.
- No text node contains `.md`, a banned tell, or `{{`.
- `summary` equals the H1 text.

On mismatch, fix the source or the ADF and edit again. Never leave a
card whose checkboxes rendered as text.

### 10.4 State file (`jira_state.json`)

```json
{
  "epic": { "key": "<PROJECT_KEY>-100", "hash": "<sha256>" },
  "stories": {
    "3": {
      "key": "<PROJECT_KEY>-131",
      "hash": "<sha256>",
      "subtasks": {
        "3.1": { "key": "<PROJECT_KEY>-132", "hash": "<sha256>" }
      }
    }
  }
}
```

Hashes come from the parser payload. `parse-sprint-folder.mjs --diff`
buckets every card into create, update, or unchanged. Uploads are
idempotent: create only cards without a key, edit only cards whose
hash changed, never touch unchanged ones, never create a duplicate. If
a key in the state file no longer exists in Jira, search
`parent = <STORY-KEY>` (or `parent = <epicKey>`) by JQL and repair the
state file before continuing.

### 10.5 Rate limits and fallbacks

- Honour `Retry-After` on 429; retry 5xx up to three times.
- MCP v1 cannot attach files, delete, move to a sprint, or rank. Use
  `scripts/sprint/jira-rest.mjs` with `JIRA_SITE`, `JIRA_EMAIL`,
  `JIRA_API_TOKEN`. Destructive subcommands require `--yes`.
- If your MCP is v2 (`uploadAttachmentToJiraIssue`, `manageJiraSprint`
  present), prefer those over REST.
- Without REST credentials, the browser operator agent performs the
  same actions through the Chrome DevTools MCP as a last resort.

## 11. Script location

```bash
_st_plugin_root() {
  if [[ -n "${ST_PLUGIN_ROOT:-}" ]]; then
    printf '%s\n' "$ST_PLUGIN_ROOT"; return 0
  fi
  if [[ -n "${CLAUDE_PLUGIN_ROOT:-}" ]]; then
    printf '%s\n' "$CLAUDE_PLUGIN_ROOT"; return 0
  fi
  local hit
  hit="$(find "${HOME}/.cursor/plugins" \
    -path '*sea-trials*/scripts/resolve-plugin-root.mjs' 2>/dev/null \
    | head -1)"
  [[ -n "$hit" ]] && dirname "$(dirname "$hit")" && return 0
  echo "sea-trials plugin not found" >&2; return 1
}
SPRINT="$(_st_plugin_root)/scripts/sprint"
```

Then `node "$SPRINT/parse-sprint-folder.mjs"`, `node "$SPRINT/md-to-adf.mjs"`,
`node "$SPRINT/jira-rest.mjs"`. Never write new helper scripts into the
target repo; these three are the whole toolkit.

## 12. Dispatch conventions

| Role | Cursor | Claude Code | Model |
| --- | --- | --- | --- |
| Story author | `Task` `subagent_type: st-sprint-author` | `Agent` `st-sprint-author` | inherit |
| Story critic | `Task` `subagent_type: st-sprint-critic` | `Agent` `st-sprint-critic` | inherit |
| Recon explorer | `Task` `subagent_type: explore` | `Agent` `Explore` | `composer-2.5` / `haiku` |
| Jira uploader | `Task` `subagent_type: st-jira-uploader` | `Agent` `st-jira-uploader` | `composer-2.5` / `haiku` |
| Jira verifier | `Task` `subagent_type: st-jira-verifier` | `Agent` `st-jira-verifier` | `composer-2.5` / `haiku` |
| Browser operator | `Task` `subagent_type: st-jira-browser-operator` | `Agent` `st-jira-browser-operator` | `composer-2.5` / `sonnet` |

Launch every worker in a wave in one parent turn. Cap Jira writers at
4 concurrent per site. Subagent prompts are self-contained: repo path,
sprint folder, `sprint.json` contents, the card text, and the exact
return format. Subagents never ask the user questions; they return
findings and the parent decides.

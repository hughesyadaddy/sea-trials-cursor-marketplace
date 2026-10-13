<!-- GENERATED from skills/_sources/sprint-contract.md — do not edit; run node scripts/sync-skill-sources.mjs -->
# Sprint card contract

Shared by `st-sprint-plan`, `st-sprint-refine`, `st-jira-upload`,
`st-jira-test-review`, and `st-jira-board-vet`. Read it before the first
phase of any of those skills. It defines what a dev-ready card looks
like, how the sprint folder is laid out, and how cards reach Jira.

**Sea Trials defaults (override only in `sprint.json`):** Jira site
`https://seatrials.atlassian.net`, reached only through the Atlassian
connector whose name is `atlassian-seatrials` (plugin MCP) or ends in
`--seatrials` (Cursor dashboard connector). Never use an `allinpmprep`
connector without the `--seatrials` suffix for Sea Trials work.

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

Optional dev entry: `00-START-HERE.md` (index + how to pick up work).
Optional PM-only tree: `<folder>/_internal/` (screenshots, annotations,
`pm/REMOVED-CARDS.md`, deferred stories). The parser and uploader
ignore paths under `_internal/`; never link to them from cards.

Human titles, real-defect bar, and delete-not-cancel rules live in
`references/shared/sprint-dev-voice.md` — authors and critics must
apply that file on every story.

## 2. `sprint.json`

Every project-specific value lives here. Skill bodies never hardcode a
project key, board, or account id; the only built-in values are the
Sea Trials default site and connector at the top of this file.

```json
{
  "site": "https://seatrials.atlassian.net",
  "connector": "atlassian-seatrials",
  "cloudId": "<uuid, optional; discovered when absent>",
  "projectKey": "<PROJECT_KEY>",
  "boardId": 12,
  "sprintId": 345,
  "epicKey": "<PROJECT_KEY>-100",
  "storyIssueType": "Story",
  "subtaskIssueType": "Subtask",
  "storyPointsFieldId": "customfield_10016",
  "labels": ["sprint-12"],
  "assigneeAccountId": "<fallback accountId, optional>",
  "assigneesPath": "sprint_planning/assignees.json",
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

Only `projectKey` is required. `site` defaults to
`https://seatrials.atlassian.net` and `connector` to the `--seatrials`
Atlassian connector (see the top of this file). `assigneesPath` points at
the user-editable people map used by section 4.4. `testProjectKeys` lists projects where
the uploader may run with `--fast` (no human cadence); `activityHours`
and `timezone` feed the activity window in section 5.1. `epicKey` absent means the uploader
creates the epic. `subtaskIssueType` is `Subtask` on team-managed
projects and `Sub-task` on most company-managed ones; check with
`getJiraProjectIssueTypesMetadata` when unsure. `repoConventionsPath`
points at the file that documents how to run tests, lint, and E2E in
that repo; the test-review skill reads it instead of guessing commands.

## 3. Card anatomy

The parser is `$ST_PLUGIN_ROOT/scripts/sprint/parse-sprint-folder.mjs`. The templates
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
- [ ] Given <other state>, when <action>, then <observable result>.

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
ones (Description, Scope, Files to touch, Acceptance criteria, Out of
scope, Subtasks). There is no Test plan section and no testing story
kind (section 4):

| Kind | Extra sections |
| --- | --- |
| UI | `## What the user sees` (2-4 sentences) |
| Ops / migration | `## Commands` (numbered, copy-paste), `## Expected results` |
| Config | `## Publish` (which config, which environment, published as a new revision via S3; section 4.3) |

## 4. Acceptance criteria quality bar

Each AC line is one behaviour, observable, written as **Given <state>,
when <action>, then <observable result>.** on one line. AC describe
what the product does, never how it is tested.

**No testing work on cards.** No testing tasks or subtasks, no test
plans, no "run the tests" or "command exits 0" AC, no checks, gates,
QA passes, sign-offs, or soak periods. Testing happens in the normal
PR flow and in `/st-jira-test-review`, not on the card. Lint rejects
`## Test plan` sections and command-style AC.

| Bad | Good |
| --- | --- |
| Works correctly | Given 3 items in cart, when I tap Pay, then total reads $42.00 |
| Handles errors | Given the API returns 500, when I tap Save, then a snackbar reads "Could not save" and the form keeps my input |
| Tests pass | Given an unpaid invoice, when I tap Download PDF, then a PDF named after the invoice number opens |
| Looks good on mobile | Given a 375px viewport, when the page loads, then no horizontal scrollbar appears |

Limits: story AC 3-10 lines, subtask AC 2-6 lines. Never write an AC
that references another card's completion, a command, a test run, or
a waiting period.

### 4.1 UI and polish stories

UI cards describe **user-visible problems** (unreadable text, clipped
labels, broken tap targets, inconsistent control on the same flow).
They are not token-alignment homework unless product explicitly asked
for it in intake.

- Titles and **Done when** lines use plain English (see sprint-dev-voice).
- Do not use prop names (`iconLeft`, `theme="primary"`) in titles.
- Prefer manual AC (“placeholder shows full text”) over DevTools RGB
  unless contrast or an signed-off brand mismatch is the defect.
- Dark mode: do not recolor surfaces the product already accepted; say
  so in Out of scope.
- Screenshot *proof* and audit captures are PM workflow (`_internal/`),
  not dev subtasks. Mockups are different: see 4.2.

### 4.2 Mockups

UI subtasks that change what a user sees carry one mockup set.

- Source: PROD screenshots of the affected screen from
  `https://app.seatrials.net`, `https://admin.seatrials.net`, or
  `https://seatrials.net/study`, at mobile (390 px), tablet (820 px)
  and desktop (1440 px) widths.
- Build: as code (HTML/CSS or a Flutter widget) or vector (SVG), then
  export. Never generate raster images with OpenAI or any image model,
  and never paint over a raster. This saves image-model tokens and keeps
  the mockup editable.
- Store: `<folder>/_internal/mockups/<story>.<subtask>/` with files
  named `<subtask>-<mobile|tablet|desktop>.<svg|png>`.
- Attach: to **that subtask only, exactly once**. Before attaching, list
  the issue's existing attachments; skip any file whose name or sha256
  is already there. Record attachment ids in `jira_state.json`
  (`stories.<id>.subtasks.<subId>.attachments`). Never attach the same
  set to the story or to sibling subtasks.
- Card text stays self-contained: the subtask describes the change in
  words; it does not say "see attachment".
- Subtasks whose purpose is to attach or update mockup images are real
  work and are **never culled** by refine or critics.

### 4.3 Config delivery (S3 publish, Neon revisions)

Config reaches apps by **publishing a new revision via the S3 publish
path**. A published Neon config revision is immutable: never edit it in
place, never `UPDATE` a published row. Cards that change config say
"publish a new revision" and name the environment; critics rewrite or
reject any card that edits a published revision in place.

### 4.4 Assignment routing

Assignment follows these rules, applied per story (subtasks inherit):

| Work | Assignee | Label |
| --- | --- | --- |
| `st_white_label`, Neon config, Vercel for the white-label tool, Go Ham | Matej | `whitelabel` |
| Flutter app code | Sachintha | (none extra) |
| Admin app work and DB cleanup | best fit by files touched and current load | `admin` |
| Anything else | best fit | (none extra) |

After routing, even out story points so each person's sprint total is
within about 10% of the mean; move only "best fit" stories to balance,
never the fixed routes above.

Account ids are never hardcoded in skills or cards. They live in the
user-editable `assignees.json` (default `sprint_planning/assignees.json`,
override with `sprint.json.assigneesPath`):

```json
{
  "people": {
    "matej": { "displayName": "Matej", "accountId": "<pick once>" },
    "sachintha": { "displayName": "Sachintha", "accountId": "<pick once>" }
  }
}
```

When an id is missing, resolve it with `lookupJiraAccountId`. If more
than one account matches (for example two Matej accounts), prefer the
one with recent Jira activity in the project (assignee or reporter on
an issue updated in the last 30 days, via JQL). If that does not leave
exactly one, stop and ask the person with the structured question tool.
Write the chosen id back to `assignees.json`.
## 5. Banned phrasing

Lint (`st-run sprint-lint` / `parse-sprint-folder.mjs --lint`) fails on
both groups below. Critics still enforce title hygiene and real-work
bar when lint passes on edge wording.

Lint errors (see `parse-sprint-folder.mjs`): vague words (`maybe`,
`consider`, …), task items starting `Research`, markdown links and
relative `[text](path)` links, markdown images, paths under
`_internal/`, `docs/reviews/`, `docs/plan/`, or `sprint_planning/` in
prose (not inside inline code spans), screenshot/attachment/upload
meta, PM sign-off gates, `see subtask N.M` / `see USn` pointers, and
AI/tool tells (`Claude`, `Cursor`, `MCP`, `subagent`, `adversarial`,
`auto-generated`, …). HTTPS product/Figma links and `src/...` paths in
backticks are allowed.

Contract bans: `research`, `spike`, `explore`, `investigate`,
`evaluate options`, `as needed`, `if possible`, `where appropriate`,
`etc.`, `and so on`, `works correctly`, `looks good`, `user-friendly`,
`handle edge cases`, `see subtask`, `see story`, `per the overview`,
`once USx is merged`, `Phase 0`, `gate`, `checkpoint`, `rollback plan`,
`soak`, `smoke test`, `QA pass`, `test plan`, `exits 0`,
`AI`, `agent`, `generated`, `assistant`, `prompt`, `model output`, any
`{{placeholder}}` or `<angle-bracket>` left from a template, and
emojis.

Also ban in titles and user-facing sections (Context, Description,
What the user sees, Done when): `audit`, `matrix`, `capture`,
`screenshot`, `annotate`, `upload attachment`, `verify in Jira`,
`adversarial`, `token swap`, `design token` (Files to touch may name
the prop change once). Do not prefix summaries with `[Cancelled]`; delete
the Jira issue instead (sprint-dev-voice).

A card that needs research is not ready. Do the research while
authoring, then write the decision into the card.

### 5.1 Cadence and voice in Jira

Applies to every write `st-jira-upload`, its uploaders, and its
verifiers make. For those writes it replaces the 2-8 s spacing and
spacing in section 7; the tool is `$ST_PLUGIN_ROOT/scripts/sprint/human-cadence.mjs`
(detail in `st-jira-upload/references/human-cadence.md`).

- Plan before the first write (`human-cadence.mjs plan payload.json`)
  and execute in that order: one epic at a time, epic card first,
  stories in folder order, each story's subtasks right after it.
- Gaps between cards follow the plan: median 12 s, never under 3 s or
  over 45 s, plus a 60-180 s pause after every 6-10 cards. A 30-card
  sprint takes 8-15 minutes. Never two writes in the same second.
- One Jira writer per site at a time (section 10.6). No parallel
  writers, not even across boards.
- Labels and story points ride on the same create or edit as the body.
  No deliberate follow-up edits.
- Writes happen 08:00-19:30 local, Monday to Friday; the run waits for
  the window instead of skipping. `--ignore-hours` only when the
  person says they are at the keyboard. `--fast` only for `--dry-run`
  or a project listed in `sprint.json.testProjectKeys`.
- Free text (comments, backlog notes, verifier remarks) comes from
  `human-cadence.mjs vary <kind>`; anything else passes
  `human-cadence.mjs check` first. No exclamation marks, no em dashes,
  no emojis, no sign-offs, never a word about tooling, automation, or
  how the card was produced.

## 6. No-links rule (Jira-uploaded bodies only)

**Uploaded:** `00-epic.md` and every `NN-usN-*.md` story file. **Not
uploaded:** `00-START-HERE.md`, `SUBTASK-INDEX.md`, `sprint.json`,
`_internal/**` — those are repo conveniences for humans browsing git;
they must not be linked from uploaded bodies.

All information the developer needs lives **on the card**. Never link
to or name a markdown file, index, folder, screenshot, attachment,
plan document, wiki page, or transcript as a substitute for content.

| Allowed in prose | Banned in prose |
| --- | --- |
| Source code paths in backticks (`src/...`) | `[label](./file.md)` or any relative `[text](path)` link |
| Product URL the tester opens | Paths under `_internal/`, `docs/reviews/`, `docs/plan/` |
| Figma / external API URL when essential | “See SUBTASK-INDEX”, “see REMOVED-CARDS”, “attached PNG” |
| | Markdown images `![](...)` |

Lint enforces this (`parse-sprint-folder.mjs --lint`). Fix the card,
not the linter.

Index files at the sprint root may link to each other for git browsing;
**epic and story bodies must not link to them** — Jira copies epic and
story text only.

## 7. Human voice

Every write happens as the authenticated person. Cards, comments, and
transitions must read as if that person typed them.

- Plain English, short sentences, active voice. Written for readers
  who are not native English speakers.
- No sign the card was machine-assisted: no tooling names, no “generated”,
  no workflow narration (see section 5 AI tells and sprint-dev-voice).
- Vary sentence openers and comment phrasing across cards; no two
  comments in one run start the same way.
- Comments in first person, terse, specific: what I did, what I saw,
  which AC passed or failed, repro steps on a fail.
- No sign-offs, no "Summary:" headers in comments, no bullet walls
  when two sentences do the job.
- Never pass `historyMetadata` on a transition.
- Space bulk writes per section 5.1, one writer per site (section
  10.6), writes only inside the activity window.

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

- Every AC on the story and its subtasks is true in the product.
- The code is merged through the repo's normal PR flow.
- Status is the project's done status; nothing left in review.

Write the DoD once in the epic if the project needs extra items (docs,
release notes, telemetry). Do not repeat it on every card.

## 10. Upload and verify contract

### 10.1 Format

Convert markdown with `$ST_PLUGIN_ROOT/scripts/sprint/md-to-adf.mjs` and pass the ADF
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
| Assignee | `assignee_account_id` from section 4.4 routing (`assignees.json`), else `sprint.json.assigneeAccountId` |
| Routing label | `whitelabel` / `admin` per section 4.4, merged into `labels` |

Never use `customfield_10014` for the epic parent. Discover the story
points field id with `jira-rest.mjs fields --name "Story point"` when
`sprint.json` lacks it, and write it back to `sprint.json`.

### 10.3 Parity check

After each create or edit, read the issue back with `getJiraIssue`
(`responseContentFormat: "adf"`) and confirm:

- The returned `key` equals the key you asked for (or the key the create
  returned), the key's project equals `projectKey`, and the connector's
  site is `sprint.json.site`. A mismatch is a hard stop: the connector
  returned the wrong issue; write nothing more and report.
- `parent.key` equals the expected epic or story.
- `codeBlock` count equals the fenced code blocks in the source
  (normally 0); no text node contains a literal `[ ]`, `[x]`, `\[` or a
  leading `- ` (escaped or flattened checkboxes).
- `labels` and story points equal what was sent.
- `taskItem` count equals the `- [ ]` count in the source markdown.
- `heading` count equals the heading count in the source body.
- No text node contains `.md`, a banned tell, or `{{`.
- `summary` equals the H1 text.

On mismatch, fix the source or the ADF and edit again. Never leave a
card whose checkboxes rendered as text.

### 10.4 State file (`jira_state.json`)

```json
{
  "epic": { "key": "<PROJECT_KEY>-100", "hash": "<sha256>", "updated": "<Jira updated>" },
  "stories": {
    "3": {
      "key": "<PROJECT_KEY>-131",
      "hash": "<sha256>",
      "updated": "<Jira updated>",
      "subtasks": {
        "3.1": { "key": "<PROJECT_KEY>-132", "hash": "<sha256>", "updated": "<Jira updated>", "attachments": ["<attachment id>"] }
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
  `$ST_PLUGIN_ROOT/scripts/sprint/jira-rest.mjs` with `JIRA_SITE`,
  `JIRA_EMAIL`, `JIRA_API_TOKEN`. Destructive subcommands require `--yes`
  and one structured confirmation listing the keys.
- If your MCP is v2 (`uploadAttachmentToJiraIssue`, `manageJiraSprint`
  present), prefer those over REST.
- Without REST credentials, the browser operator agent may attach
  files, move to a sprint, or rank through the Chrome DevTools MCP only
  after the person approves that exact action list in a structured
  question. It never deletes; deletes without the MCP or REST are
  reported as manual steps.

### 10.6 Single writer, stale check, read-back

Every skill that writes to Jira (upload, board-vet fixes, test-review
comments and transitions, verifier remarks) follows this protocol.

1. **One writer per site.** Exactly one session writes at a time: the
   parent, or the single worker it delegated writes to (one
   `st-jira-uploader`, or one verifier holding remark entries) while
   the parent waits. Read-only workers return proposed writes. Before the first write, create the lock file
   `${TMPDIR:-/tmp}/st-jira-writer-<site host>.lock` holding pid, skill,
   and start time. If it exists and its pid is alive, stop and report;
   remove the lock when the run ends.
2. **One write at a time.** Never issue a write while another is in
   flight. Never two writes in the same second.
3. **Read before write (stale check).** Before every edit, comment, or
   transition, `getJiraIssue` the target and compare `fields.updated`
   with the value recorded when the content was pulled or last written
   (`jira_state.json` `updated`). If Jira is newer, stop for that card
   and report it; never overwrite someone else's change. Save the
   pre-edit ADF to `<scratch>/<KEY>.before.json`. If no `updated` was
   recorded (legacy state file), list those cards and ask once with the
   structured question tool before overwriting them.
4. **Write**, sending only fields that changed. Body, labels, and story
   points go in the same edit.
5. **Read back** (10.3) and record the new `updated` in
   `jira_state.json`. Only then move to the next write.
6. **Never round-trip a body through markdown.** A description written
   to Jira is always built by `md-to-adf.mjs` from the sprint folder
   markdown, never from a markdown export of the live card
   (`responseContentFormat: "markdown"` or `adf-to-md.mjs`). Markdown
   reads are for humans and critics only.

## 11. Script location

The plugin lives in Cursor/Claude caches after Team Marketplace install.
**Do not copy** `plugins/sea-trials` into app repos. Consumer repos only
need `sprint_planning/` (and optional one-line npm shims that call
`st-run`).

Resolve **`ST_PLUGIN_ROOT`** in this order:

1. Explicit `ST_PLUGIN_ROOT`
2. `CURSOR_PLUGIN_ROOT` (Cursor plugin context)
3. `CLAUDE_PLUGIN_ROOT` (Claude hooks/MCP)
4. Node `$ST_PLUGIN_ROOT/scripts/lib/resolve-st-plugin-root.mjs` (newest cache wins)

Bootstrap once per agent turn (any checkout directory):

```bash
export ST_PLUGIN_ROOT="${ST_PLUGIN_ROOT:-${CURSOR_PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT:-}}}"
if [[ -z "${ST_PLUGIN_ROOT:-}" ]]; then
  _ST_RUN="$(
    find "${HOME}/.cursor/plugins" "${HOME}/.claude/plugins" \
      -path '*/sea-trials/scripts/st-run.mjs' 2>/dev/null | head -1
  )"
  [[ -n "${_ST_RUN}" ]] || { echo "Enable sea-trials in Team Marketplace" >&2; exit 1; }
  ST_PLUGIN_ROOT="$(node "${_ST_RUN}" print-plugin-root)"
  export ST_PLUGIN_ROOT
fi
```

`st-run print-plugin-root` calls `resolveStPluginRoot()` (newest cache wins).
Do not use bash `find … | head -1` on plugin **roots** — only to locate `st-run.mjs`.

From an app repo checkout:

```bash
node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" sprint-lint -- sprint_planning/<folder>
node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" sprint-lint -- --changed
```

Sprint toolkit under `$ST_PLUGIN_ROOT/scripts/sprint/`:

| Script | Role |
| --- | --- |
| `sprint-lint.mjs` | Dev-ready card lint (preferred entry) |
| `parse-sprint-folder.mjs` | Payload JSON, `--lint`, `--diff` |
| `md-to-adf.mjs` | Markdown → Jira ADF |
| `jira-rest.mjs` | REST upload, attach, delete |

Never add, run, or depend on upload, lint, capture, or Jira scripts in
the app repo (for example `scripts/jira/` or `scripts/sprint/` in a
consumer repo); everything these skills need lives under
`$ST_PLUGIN_ROOT`. Use `/st-jira-upload` and `st-run sprint-lint`.

**Sprint docs skip review loops.** Commits that touch only
`sprint_planning/**` never go through PR review loops, adversarial
vets, or `/st-pr-*` skills, and need no PR. The plugin's push guard
allows a plain `git push` when every commit being pushed touches only
`sprint_planning/**` (never with force or `--no-verify`).

## 12. Dispatch conventions

| Role | Cursor | Claude Code | Model |
| --- | --- | --- | --- |
| Story author | `Task` `subagent_type: st-sprint-author` | `Agent` `st-sprint-author` | inherit |
| Story critic | `Task` `subagent_type: st-sprint-critic` | `Agent` `st-sprint-critic` | `composer-2.5` / `haiku`; escalate to inherit only for a disputed verdict |
| Recon explorer | `Task` `subagent_type: explore` | `Agent` `Explore` | `composer-2.5` / `haiku` |
| Jira uploader | `Task` `subagent_type: st-jira-uploader` | `Agent` `st-jira-uploader` | `composer-2.5` / `haiku` |
| Jira verifier | `Task` `subagent_type: st-jira-verifier` | `Agent` `st-jira-verifier` | `composer-2.5` / `haiku` |
| Browser operator | `Task` `subagent_type: st-jira-browser-operator` | `Agent` `st-jira-browser-operator` | `composer-2.5` / `sonnet` |

Reviewers (critics, verifiers, explorers) default to the cheap model.
Escalate one card to the parent's model only when two cheap verdicts
disagree or the parent disputes a verdict. Launch every read-only worker
in a wave in one parent turn. Jira writes follow 10.6: one writer per
site, one write at a time. Subagent prompts are self-contained: repo path,
sprint folder, `sprint.json` contents, the card text, and the exact
return format. Subagents never ask the user questions; they return
findings and the parent decides.

---
name: st-sprint-plan
description: >-
  From a goal and a repo, write a sprint folder of cards in the card
  format (epic, stories numbered 1..n, subtasks with What and why,
  Where, How with code, Done when) under sprint_planning/, check it
  with the card lint, and open it in the local viewer. Finds the Jira
  site, project and sprint at run time and saves them in the folder.
  Never writes to Jira; st-jira-upload does that. Use when the user
  asks to plan a sprint, write user stories, or break an epic into
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

# Sprint plan

Turn a goal into a sprint folder of cards a developer can build from.
Nothing here writes to Jira.

**Read first:**

- [`references/shared/sprint-card-format.md`](references/shared/sprint-card-format.md) (the contract for every card)
- [`references/shared/sprint-folder-format.md`](references/shared/sprint-folder-format.md)
- [`references/shared/sprint-cards-cli.md`](references/shared/sprint-cards-cli.md)
- [`references/shared/jira-connection.md`](references/shared/jira-connection.md) (Phase 1 only)

| Situation | Skill |
| --- | --- |
| New goal, no cards yet | **This skill** |
| Folder or Jira epic exists, cards need work | `/st-sprint-refine` |
| Folder is ready, send it to Jira | `/st-jira-upload` |
| Check the board against the cards | `/st-jira-board-vet` |

## Autonomy

Ask only the Phase 1 questions. After that, finish without asking.
Make product calls from the code and write them as facts in the cards;
anything truly open goes to `OPEN-QUESTIONS.md`.

---

## Phase 0: Locate

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# 1. Claude Code writes the plugin path into the next line when it loads this skill.
CLI="${CLAUDE_PLUGIN_ROOT}/scripts/sprint-cards/cli.mjs"
# 2. Cursor and other hosts: plugin root env vars.
for root in "${CURSOR_PLUGIN_ROOT:-}" "${ST_PLUGIN_ROOT:-}"; do
  [[ -f "$CLI" ]] || CLI="$root/scripts/sprint-cards/cli.mjs"
done
# 3. Else the newest installed copy.
if [[ ! -f "$CLI" ]]; then
  CLI=""
  while IFS= read -r f; do [[ -z "$CLI" || "$f" -nt "$CLI" ]] && CLI="$f"; done \
    < <(find "$HOME/.claude/plugins" "$HOME/.cursor/plugins" -path '*/scripts/sprint-cards/cli.mjs' 2>/dev/null)
fi
[[ -f "$CLI" ]] || { echo "sprint-cards CLI not found: it is scripts/sprint-cards/cli.mjs two folders above this SKILL.md's folder" >&2; }
node "$CLI" --help >/dev/null && echo "CLI: $CLI"
```

Sprint folders live in `$REPO_ROOT/sprint_planning/`. Create it when
it is missing.

---

## Phase 1: Intake and Jira data

One structured question call, skipping anything the user already said:

1. Sprint folder name (offer a slug from the goal).
2. Who the users are and which parts of the app are in scope.
3. Hard limits: must reuse, must not touch.
4. Decisions already made.

Then find the Jira data as in `jira-connection.md` (site, cloud id,
project key, sprint id and name; the board is optional). Check
`node "$CLI" auth status` first: with the user key use `discover`,
else the MCP tools. Ask only for what you cannot find (for example
the project, when several are visible). A new folder may start with
no Jira data at all; the upload skill asks later.

```bash
node "$CLI" init "$REPO_ROOT/sprint_planning/<slug>" \
  --project-key <PROJECT_KEY> --site <JIRA_SITE> --cloud-id <id> \
  --sprint-id <n> --sprint-name "<SPRINT_NAME>"
DIR="$REPO_ROOT/sprint_planning/<slug>"
```

State the goal back in 5 to 8 bullets. Do not write cards yet.

---

## Phase 2: Read the code (parallel)

Split the goal into 3 to 6 areas (data, server, UI, jobs, tests).
Start one read-only explorer per area in one message (see Subagents).
Each returns a table `Area | Exists today | Path:line | We will`.
Merge them. Never invent a path: when a thing does not exist, the card
creates it and says so. Read the repo's `AGENTS.md`, `CONTRIBUTING.md`
or `package.json` scripts for the exact test and lint commands; cards
quote them as written.

---

## Phase 3: Split into stories

Draft the list a product owner would review:

| # | Story title | User | Points | Subtasks |
| --- | --- | --- | --- | --- |

Split by what merges first. 3 to 6 subtasks per story, story 1 to 8
points, risky or destructive work last, no test-only or research
cards. Show the table and go on, unless the user asked to approve it.

Make the cards (template text is filled in Phase 4):

```bash
node "$CLI" new "$DIR" epic --title "<epic title>"
node "$CLI" new "$DIR" story --parent <epic local_id> --title "<title>" --points <n>
node "$CLI" new "$DIR" subtask --parent <story local_id> --title "<title>"
```

Titles have no "User Story N:" prefix; `new` and `number` add it.
New cards hold `[[FILL: ...]]` template text on purpose: lint fails on
them until Phase 4 replaces it.
For an epic that is already in Jira, run `/st-sprint-refine` instead.

---

## Phase 4: Write the cards (parallel)

One `st-sprint-author` per story, all in one message (batches of 8 or
fewer). Each prompt: repo path, `$DIR`, the story card path and its
subtask card paths, the brief, that story's code notes, the sibling
story titles, the path of `$DIR/CARD-FORMAT.md` and `$CLI`.

Then write the epic card yourself: Goal, Scope, and the Stories list
from the story cards.

---

## Phase 5: Adversarial review (parallel)

One `st-sprint-critic` per story, `MODE: fix`, all in one message.

| Verdict | Action |
| --- | --- |
| `READY` or `FIXED` | Accept |
| `NEEDS RE-PLAN` | Split again (Phase 3), write again, review again |

When two critics claim the same change, decide which story owns it and
edit the other to point at it.

---

## Phase 6: Check and view

```bash
node "$CLI" number "$DIR"
node "$CLI" lint "$DIR"          # must exit 0
node "$CLI" push "$DIR"          # dry run: every card is a create
node "$CLI" doctor "$DIR"        # saved Jira data and connection mode
node "$CLI" serve "$DIR"         # starts the sprint-plan-viewer submodule
```

Run `serve` in the background and give the user the URL it prints.
`serve` starts the `sprint-plan-viewer/` submodule of the sprint
planning repo; exit 3 means it is missing: tell the user how to add it
(see the folder format) and go on without the viewer. Fix lint
errors before the handoff. Add one line to `SPRINT-CHANGES.md`, for
example `- Planned <n> stories for <goal>.`

---

## Phase 7: Handoff

Report: folder path, story count, total points, a table of stories
with points, decisions you made alone, the viewer URL. Then offer:

1. Send to Jira now: `/st-jira-upload <folder>` (Recommended)
2. Refine first: `/st-sprint-refine <folder>`
3. Stop here

## Subagents

| Host | How to start one worker |
| --- | --- |
| Claude Code | The `Agent` tool (called `Task` in older versions) with `subagent_type` set to the agent name. Plugin agents may show as `<plugin>:<agent>`; use the name the tool lists. Several calls in one message run in parallel. |
| Cursor (editor or CLI) | The `Task` tool with `subagent_type` set to the agent name. Several calls in one message run in parallel. |
| Headless, no subagent tool | One `agent -p --trust --workspace <repo> "<prompt>"` process per worker (the Cursor CLI, older installs call it `cursor-agent`), or `claude -p "<prompt>"`, started in the background and awaited. |
| None of these | Do the work yourself, one story at a time. |

Each worker prompt is self-contained: absolute paths, the CLI path, the brief, and the return format. Workers never write to Jira.

## Forbidden

- Any Jira write from this skill.
- Writing cards before Phase 2 finishes.
- A project key, site or account id inside a card body.
- Editing `*.jira.md`, `local_id`, keys, `order` or `plan_number` by hand.
- Helper scripts written into the app repo.
- Asking the user to paste an API token into the chat.

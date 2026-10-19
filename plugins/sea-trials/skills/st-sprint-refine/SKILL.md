---
name: st-sprint-refine
description: >-
  Bring an existing sprint folder or Jira epic into the card format:
  resync the Jira copies (GET only), adopt Jira issues as local cards,
  rewrite every card that is not Done with parallel authors and
  adversarial critics, renumber stories 1..n, pass the card lint, and
  show the local vs Jira diff in the viewer. Done cards keep their
  Jira text. Never writes to Jira; st-jira-upload does that. Use when
  cards exist but are vague, stale, out of order or fail review.
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

Same card format as `/st-sprint-plan`, applied to cards that exist.

**Read first:**

- [`references/shared/sprint-card-format.md`](references/shared/sprint-card-format.md)
- [`references/shared/sprint-folder-format.md`](references/shared/sprint-folder-format.md)
- [`references/shared/sprint-cards-cli.md`](references/shared/sprint-cards-cli.md)
- [`references/shared/jira-connection.md`](references/shared/jira-connection.md)

| Input | Phases |
| --- | --- |
| Card folder exists | 0, 1, 2 to 6 |
| Jira epic or sprint exists, no folder | 0, 1 (with adopt), 2 to 6 |
| Old flat folder (`00-epic.md`, `NN-usN-*.md`) | 0, then make a new card folder and adopt from Jira by epic key; the old files stay as they are |
| No cards anywhere | `/st-sprint-plan` |

## Autonomy

Ask one structured question only when the source of truth is not
clear (local folder or Jira) or a value in `jira-connection.md`
cannot be found. Otherwise finish without asking.

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
DIR="$REPO_ROOT/sprint_planning/<sprint-slug>"     # put the real folder the user named here
# doctor exits 1 while something is missing; its FAIL lines are things to fix, not a stop.
node "$CLI" doctor "$DIR" || true
node "$CLI" auth status "$DIR"
```

No folder yet: `node "$CLI" init "$DIR" --project-key ... --site ...`
with the values found as in `jira-connection.md`.

---

## Phase 1: Resync from Jira (read only)

With the user key:

```bash
node "$CLI" pull "$DIR" [--epic <KEY>]... [--adopt]
```

With MCP: search with `searchJiraIssuesUsingJql`, for example
`sprint = <sprint_id>`, `parent = <EPIC>` and, for subtasks,
`parent in (<story keys>)`. Ask for the fields `summary, description,
status, labels, parent, issuetype, updated, attachment` and the story
points and sprint field ids when `field_ids` has them. Save all issues
as one JSON list, then:

```bash
node "$CLI" import-jira "$DIR" /tmp/issues.json [--adopt]
```

`--adopt` makes local cards for Jira issues that have none, parents
first. Then:

```bash
node "$CLI" ids "$DIR" && node "$CLI" manifest "$DIR"
node "$CLI" lint "$DIR" --json > /tmp/lint-before.json
```

Read `compare/index.json`: `sync_status` per card. `jira_edited` or
`conflict` means Jira changed since the last pull: show the user the
diff in the viewer and take the Jira text unless they say otherwise.

---

## Phase 2: Read the code (parallel)

One read-only explorer per epic or area, in one message (see
Subagents). Each checks every path, function and line the cards cite
and returns `Card | Cited | Real path:line | Note`.

---

## Phase 3: Rewrite (parallel)

Skip every card whose Jira copy is Done (`status_category: done`):
it keeps the Jira text (rule 15). For the rest, one
`st-sprint-author` per story, all in one message, with the story and
subtask card paths, the code notes, the sibling titles, the path of
`$DIR/CARD-FORMAT.md` and `$CLI`. The author keeps the meaning of the
card and rewrites it into the format. Missing subtasks are made with
`node "$CLI" new "$DIR" subtask --parent <story local_id> --title ...`
before the author starts.

---

## Phase 4: Adversarial review (parallel)

One `st-sprint-critic` per story, `MODE: fix`, all in one message.
`NEEDS RE-PLAN`: split or merge the stories (move folders, then
`ids`), write again, review again.

---

## Phase 5: Order and check

```bash
node "$CLI" number "$DIR"
node "$CLI" lint "$DIR"        # must exit 0
node "$CLI" push "$DIR"        # dry run: the changes Jira would get
node "$CLI" serve "$DIR"       # sprint-plan-viewer submodule; background; give the user the URL
```

In the viewer the user can drag cards to change the order; run
`number` again afterwards so the stories stay numbered 1..n. Add one line per change to `SPRINT-CHANGES.md`.

---

## Phase 6: Handoff

Report: cards changed (from the dry run), cards kept as Done, lint
before and after, the viewer URL, and decisions you made alone. Offer:

1. Send the changes to Jira: `/st-jira-upload <folder>` (Recommended)
2. Stop here

## Subagents

| Host | How to start one worker |
| --- | --- |
| Claude Code | The `Agent` tool (called `Task` in older versions) with `subagent_type` set to the agent name. Plugin agents may show as `<plugin>:<agent>`; use the name the tool lists. Several calls in one message run in parallel. |
| Cursor (editor or CLI) | The `Task` tool with `subagent_type` set to the agent name. Several calls in one message run in parallel. |
| Headless, no subagent tool | One `agent -p --trust --workspace <repo> "<prompt>"` process per worker (the Cursor CLI, older installs call it `cursor-agent`), or `claude -p "<prompt>"`, started in the background and awaited. |
| None of these | Do the work yourself, one story at a time. |

Each worker prompt is self-contained: absolute paths, the CLI path, the brief, and the return format. Workers never write to Jira.

## Forbidden

- Any Jira write from this skill (pull and import are reads).
- Changing a card that is Done in Jira.
- Editing `*.jira.md`, ids, keys, `order` or `plan_number` by hand.
- Deleting a card folder that has a Jira key. Close the issue in Jira
  instead (rule 14), through `/st-jira-upload`.
- Asking the user to paste an API token into the chat.

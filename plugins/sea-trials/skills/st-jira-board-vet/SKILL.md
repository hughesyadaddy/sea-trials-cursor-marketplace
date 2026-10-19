---
name: st-jira-board-vet
description: >-
  Board check over the active sprint (or any JQL): import the Jira
  cards into a card folder (read only), run the card lint on them,
  compare each card's status with the code on a branch, then fix the
  cards through the normal refine and upload flow or report. Use mid
  sprint or before planning, or when the user says "vet the board",
  "check the sprint board" or "audit the Jira cards".
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

# Jira board vet

Two questions per card: does it meet the card format, and does its
status match the code. Fix the first through the sprint folder; ask
once before changing the second.

**Read first:**

- [`references/shared/sprint-card-format.md`](references/shared/sprint-card-format.md)
- [`references/shared/sprint-cards-cli.md`](references/shared/sprint-cards-cli.md)
- [`references/shared/jira-connection.md`](references/shared/jira-connection.md)
- [`references/vet-rules.md`](references/vet-rules.md)
- [`references/jql-recipes.md`](references/jql-recipes.md)

| Mode | Behaviour |
| --- | --- |
| `report` (default for "check" or "audit") | Read only; a findings table |
| `fix` | Cards fixed in the folder, then sent with `/st-jira-upload` after the user approves the dry run |

---

## Phase 0: Scope

```bash
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
CLI=""
for root in "${CLAUDE_PLUGIN_ROOT:-}" "${CURSOR_PLUGIN_ROOT:-}" "${ST_PLUGIN_ROOT:-}"; do
  if [[ -n "$root" && -f "$root/scripts/sprint-cards/cli.mjs" ]]; then CLI="$root/scripts/sprint-cards/cli.mjs"; break; fi
done
[[ -n "$CLI" ]] || CLI="<skill folder>/../../scripts/sprint-cards/cli.mjs"   # folder of this SKILL.md
node "$CLI" auth status
```

Use the sprint folder for this sprint when one exists. Else make a
scratch folder outside the repo:

```bash
DIR=$(mktemp -d /tmp/board-vet.XXXX)
node "$CLI" init "$DIR" --project-key <PROJECT_KEY> --site <JIRA_SITE> --sprint-id <n> --sprint-name "<SPRINT_NAME>"
```

Find the values as in `jira-connection.md`. Default JQL:
`project = <PROJECT_KEY> AND sprint in openSprints() ORDER BY rank ASC`
(more in `references/jql-recipes.md`).

---

## Phase 1: Import (read only)

User key: `node "$CLI" pull "$DIR" --adopt` (for a scratch folder,
also `--epic <KEY>` for each epic in scope).

MCP: `searchJiraIssuesUsingJql` with the JQL and the fields
`summary,description,status,issuetype,assignee,labels,parent,updated,attachment`
(plus story points and sprint field ids when known), paged with
`nextPageToken`; then subtasks with `parent in (<story keys>)`. Save
one JSON list and run
`node "$CLI" import-jira "$DIR" /tmp/vet-issues.json --adopt`.

---

## Phase 2: Content check

```bash
node "$CLI" lint "$DIR" --json > /tmp/vet-lint.json
```

Map each problem to a row with `references/vet-rules.md`. Cards whose
status category is Done are listed but never fixed. Add the field
rules (F2 to F6) from the imported fields.

## Phase 3: Status vs branch (only when a branch is named)

Use a separate worktree, never the user's checkout:

```bash
git fetch origin "<branch>"
WT=$(mktemp -d /tmp/vet-wt.XXXX); git worktree add "$WT" "origin/<branch>"
```

One read-only explorer per story (see Subagents) compares each
subtask's Where and Done when with the code in `$WT`:
`Key | Jira status | Code looks | Suggest | Reason`. Status names come
from `getTransitionsForJiraIssue`, never invented. Remove the worktree
at the end (`git worktree remove "$WT"`).

## Phase 4: Fix (mode `fix`)

Fixes always go through the folder, never straight into Jira:

1. One `st-sprint-critic` per story with errors, `MODE: fix`, in
   parallel. For a scratch folder, pass the app repo path so paths are
   checked.
2. `node "$CLI" number "$DIR"` and `lint` (exit 0).
3. Status changes the user approved: set `status` in the local card.
4. Run `/st-jira-upload` on `$DIR`: dry run, one approval, then the
   writes (it reads the live issue before each update and skips Done).

## Phase 5: Report

```text
| Key | Type | Lint errors | Fixed | Status | Suggested | Applied |
```

Counts before and after, what is left for a person, and the folder
path (offer `node "$CLI" serve "$DIR"` to look at the diff). Offer:
`/st-jira-test-review` on the review column cards, or stop.

---

## Subagents

| Host | How |
| --- | --- |
| Claude Code | `Agent` (or `Task`) with `subagent_type` set to the agent name, several in one message |
| Cursor | `Task` with `subagent_type`, several in one message |
| No subagent tool | One by one |

## Forbidden

- Any Jira write in `report` mode.
- Writing a description straight to Jira without the folder, lint and
  the upload dry run.
- Changing a Done card. Inventing status names.
- Touching the user's checkout branch.
- Asking for an API token in chat.

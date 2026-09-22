---
name: st-jira-board-vet
description: >-
  Board hygiene sweep over the active sprint (or any JQL): flag cards
  that break the dev-ready contract (missing AC or story points,
  markdown links, template leftovers, banned phrasing, unassigned or
  stale status, status that disagrees with the branch), then fix in
  place or report. Parallel verifiers and critics. Use mid-sprint or
  before planning.
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

Two questions per card: does the card meet the contract, and does its
status match reality on the branch. Fix the first in place; propose
the second and transition after one confirmation.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
- [`references/vet-rules.md`](references/vet-rules.md)
- [`references/jql-recipes.md`](references/jql-recipes.md)

## Modes

| Mode | Behaviour |
| --- | --- |
| `report` (default when the user says "check" or "audit") | Read-only; table of findings |
| `fix` | Content defects fixed via `editJiraIssue`; status changes still confirmed |

Pick the mode from the user's wording; ask via the structured question
tool only when it is genuinely unclear.

---

## Phase 0 — Scope

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SPRINT="$(_st_plugin_root)/scripts/sprint"   # contract section 11
```

Read `sprint.json` for `cloudId`, `projectKey`, `storyPointsFieldId`,
`reviewStatuses`, `boardId`. Default JQL:

```text
project = <PROJECT_KEY> AND sprint in openSprints()
  AND statusCategory != Done ORDER BY rank ASC
```

Alternatives in `references/jql-recipes.md` (epic, story, branch
keys, stale reviews). `searchJiraIssuesUsingJql` with `fields`
`summary,description,status,issuetype,assignee,labels,parent,
<storyPointsFieldId>,updated,comment`; page with `nextPageToken`.

---

## Phase 1 — Content sweep (parallel verifiers)

One `st-jira-verifier` per 10 keys, cheap model, one turn:

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: st-jira-verifier`, `model: composer-2.5` |
| Claude Code | `Agent` `st-jira-verifier`, `model: haiku` |

No source markdown is available here, so verifiers run C1-C6 and
F1-F5 only (no parity). Merge into one findings table keyed by issue.

---

## Phase 2 — Status vs branch (optional, when a branch is named)

Isolated worktree, never the user's checkout:

```bash
git fetch origin "<branch>"
WT=$(mktemp -d /tmp/vet.XXXX); git worktree add "$WT" "origin/<branch>"
```

One read-only explorer per story (cheap model) compares each subtask's
Files to change and AC with the code in `$WT`. Output per card:

| Key | Jira status | Code looks | Suggest | Reason |
| --- | --- | --- | --- | --- |

`Code looks` is one of: not started, partial, complete on branch,
merged. `Suggest` is a status name from the project's workflow, taken
from `getTransitionsForJiraIssue`, never invented. Remove the worktree
when done.

---

## Phase 3 — Fix content (mode `fix`)

For each card with C-class errors, dispatch one `st-sprint-critic` in
`MODE: fix` on a temp markdown copy of the card:

1. `getJiraIssue` with `responseContentFormat: "markdown"` and write
   the body to `/tmp/vet/<KEY>.md` with the summary as H1.
2. Critic fixes in place against the contract (paths verified in the
   repo when one is available).
3. `node "$SPRINT/md-to-adf.mjs" /tmp/vet/<KEY>.md --strip-h1 --out
   /tmp/vet/<KEY>.adf.json`, then `editJiraIssue` with
   `contentFormat: "adf"` and `fields.description` set to the object.
   Set `fields.<storyPointsFieldId>` when F1 was flagged and the critic
   sized the card.
4. Read back; parity per contract 10.3 against `/tmp/vet/<KEY>.md`.

Space edits 2-8 s apart; cap 4 concurrent writers. When a sprint
folder exists for this epic, also apply the same edit to the story
file and update `jira_state.json` hash so the next upload does not
revert it.

---

## Phase 4 — Status changes (confirm once)

Show the full delta table from Phase 2 plus F2/F3 findings
(unassigned in progress, stale review). One structured question:
apply all, apply selected rows, or skip. Then per approved row:
`getTransitionsForJiraIssue`, pick by name, `transitionJiraIssue` with
`transition.id` only. Optional one-line first-person comment on a
mismatch ("Moving this to In Progress, the branch has the service but
not the UI yet"). Never paste specs into comments.

---

## Phase 5 — Summary

```text
| Key | Type | Content errors | Fixed | Status | Suggested | Applied |
| --- | --- | --- | --- | --- | --- | --- |
```

Plus counts before and after, and anything left manual. Offer via the
structured question tool:

1. Run `/st-jira-test-review` on the review-column cards (Recommended)
2. Stop here

---

## Forbidden

- Transitioning without the Phase 4 confirmation.
- Editing content in `report` mode.
- Inventing status names; read them from transitions.
- Dumping card bodies or specs into comments.
- `contentFormat: "markdown"` for descriptions.
- Touching the user's checkout branch.
- Words from contract section 5, emojis, or `historyMetadata`.

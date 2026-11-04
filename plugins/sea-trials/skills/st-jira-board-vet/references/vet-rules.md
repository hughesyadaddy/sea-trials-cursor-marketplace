# Vet rules

Content rules are the card lint (`node <CLI> lint`), run on Jira
copies imported into a card folder. Field and status rules need a
person or a transition.

## Content (lint rule ids)

| Lint rule | Problem on the board | Fix (mode `fix`) |
| --- | --- | --- |
| `sections` | Missing or extra `##` sections, wrong order | Critic rewrites the local card into the format |
| `rule-4` / `checks` | Checks are plain text, not `- [ ]`, or too few or too many | Rewrite as Given/when/then checkboxes |
| `rule-2`, `rule-3`, `rule-6` | Dashes, tool words, hedges, open questions | Rewrite as facts; open items go to `OPEN-QUESTIONS.md` |
| `rule-7` | Images or Markdown links in the body | Images become attachments; links become plain URLs |
| `rule-9` | Story numbers with gaps or repeats | `number`, then push (summary updates and rank) |
| `rule-11` | Story or subtask with no parent | Move the folder under its parent, `ids`, push |
| `rule-17` | Dates or waiting periods | Remove |
| `front-matter` | Story points missing or out of range | Critic sizes it from the subtasks |

## Fields (report; fix only when the value is known)

| Code | Rule | Action |
| --- | --- | --- |
| F2 | Unassigned while in progress or review | Report; ask who owns it |
| F3 | In a review status with no update for 3 days | Report as stale |
| F4 | Subtask done, parent story still to do | Suggest moving the parent to in progress |
| F6 | Story in this sprint folder but not in the sprint in Jira | Push moves it (key path), or drag on the board |

## Status vs branch

| Code looks | Evidence | Suggest |
| --- | --- | --- |
| not started | none of the Where files exist or differ from base | To Do |
| partial | some files changed, Done when checks fail | In Progress |
| complete on branch | all Done when checks pass in the worktree, PR open | the project's review status |
| merged | changes present on the base branch | Done |

## Precedence when rules conflict

1. Never lose content: move, do not delete.
2. Never widen scope: a fix may not add features the card did not have.
3. Never change status silently: all transitions go through the confirmation.
4. Never change a Done card.

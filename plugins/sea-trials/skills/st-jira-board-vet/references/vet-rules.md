# Vet rules

Codes match `st-jira-verifier`. Content codes are fixable in place;
field and status codes need a person or a transition.

## Content (fix in `fix` mode)

| Code | Rule | Fix |
| --- | --- | --- |
| C1 | Body references a `.md` file, plan doc, or wiki page as content | Inline the content or delete the reference |
| C2 | `[ ]` or `[x]` as literal text in a bullet or paragraph | Re-upload the body as ADF so they become `taskItem` nodes |
| C3 | `{{...}}`, `<PLACEHOLDER>`, `TODO:`, `TBD`, `???` | Decide and write the value |
| C4 | Banned phrasing or tells (contract section 5) | Rewrite as a decision or delete |
| C5 | Story with no Acceptance criteria heading | Add the section with AC derived from Description and Scope |
| C6 | Story or subtask with zero open task items | Convert prose AC to `- [ ]` lines; if none exist, write them |
| C7 | Story with no `Files to touch` / subtask with no `Files to change` | Add from the branch or the codebase |
| C8 | Summary missing the `User Story N:` prefix or not imperative for a subtask | Rename |
| C9 | Description longer than 6000 characters | Move detail to subtasks; keep the story demoable |

## Fields (report; fix only when the value is known)

| Code | Rule | Action |
| --- | --- | --- |
| F1 | Story points empty on a story | Critic sizes it from subtasks; set the field |
| F2 | Unassigned while in progress or review | Report; ask who owns it |
| F3 | In a review status with no comment for 3 days | Report as stale; suggest a QA pass |
| F4 | Subtask done, parent story still to do | Suggest moving the parent to in progress |
| F5 | Emoji in summary or body | Remove |
| F6 | Labels missing the sprint label from `sprint.json` | Add |
| F7 | Story not under the epic (`parent` empty) | Set `parent.key` via `editJiraIssue` only if the epic is certain |

## Status vs branch

| Code looks | Evidence | Suggest |
| --- | --- | --- |
| not started | none of Files to change exist or differ from base | To Do |
| partial | some files changed, AC commands fail or UI incomplete | In Progress |
| complete on branch | all AC commands pass in the worktree, PR open | the project's review status |
| merged | changes present on the base branch | Done (after QA comment exists) |

Never suggest Done for a card without a QA comment; route it to
`/st-jira-test-review` instead.

## Precedence when rules conflict

1. Never lose content: move, do not delete, unless it is a banned
   reference with no information (C1 with an empty target).
2. Never widen scope: a fix may not add features the card did not
   have.
3. Never change status silently: all transitions go through Phase 4.

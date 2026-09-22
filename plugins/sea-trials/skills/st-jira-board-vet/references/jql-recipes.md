# JQL recipes

Substitute values from `sprint.json`. Always `ORDER BY rank ASC` so
the report matches the board. Page with `nextPageToken`; never ask
for totals.

| Purpose | JQL |
| --- | --- |
| Active sprint, open cards | `project = <PROJECT_KEY> AND sprint in openSprints() AND statusCategory != Done` |
| Whole epic | `parent = <EPIC-KEY> OR "Epic Link" = <EPIC-KEY>` |
| One story with subtasks | `key = <STORY-KEY> OR parent = <STORY-KEY>` |
| Keys from a branch | `key in (<KEY1>, <KEY2>)` after extracting `[A-Z][A-Z0-9]+-\d+` from the branch name and `git log --oneline origin/<base>..origin/<branch>` |
| Review column | `project = <PROJECT_KEY> AND status in ("<reviewStatuses...>")` |
| Stale review | `project = <PROJECT_KEY> AND status in ("<reviewStatuses...>") AND updated <= -3d` |
| Unassigned in flight | `project = <PROJECT_KEY> AND sprint in openSprints() AND assignee is EMPTY AND statusCategory = "In Progress"` |
| Missing story points | `project = <PROJECT_KEY> AND sprint in openSprints() AND issuetype = Story AND "<Story points field name>" is EMPTY` |
| Done subtasks with open parent | `project = <PROJECT_KEY> AND issuetype in subTaskIssueTypes() AND statusCategory = Done AND parent in (<open story keys>)` |
| Next sprint | `project = <PROJECT_KEY> AND sprint in futureSprints()` |

Notes:

- Team-managed projects use `parent =` for epic children;
  company-managed ones may still need `"Epic Link" =`. Try `parent`
  first and fall back when it returns nothing.
- `sprint in openSprints()` needs the project to have an active sprint
  on the board in `sprint.json.boardId`; otherwise pass the sprint id:
  `sprint = <sprintId>`.
- Quote status names that contain spaces.
- Fields to request for a vet: `summary,description,status,issuetype,
  assignee,labels,parent,<storyPointsFieldId>,updated,comment`.

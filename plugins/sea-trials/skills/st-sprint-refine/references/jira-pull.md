# Pulling an existing epic into the sprint folder

Read-only against Jira. The folder becomes the working copy; the
upload skill pushes changes back and only touches cards whose hash
changed.

## Queries

| Need | Tool | Input |
| --- | --- | --- |
| Cloud id | `getAccessibleAtlassianResources` | none; pick the site from `sprint.json` |
| Epic | `getJiraIssue` | `issueIdOrKey: <epicKey>`, `responseContentFormat: "markdown"` |
| Stories | `searchJiraIssuesUsingJql` | `parent = <epicKey> ORDER BY rank ASC`, fields `summary,description,status,labels,assignee,<storyPointsFieldId>,issuelinks` |
| Subtasks | `searchJiraIssuesUsingJql` | `parent = <STORY-KEY> ORDER BY rank ASC` |
| Legacy epic link | `searchJiraIssuesUsingJql` | `"Epic Link" = <epicKey>` when `parent =` returns nothing on a company-managed project |

Page with `nextPageToken` until exhausted. Do not request totals.

## Mapping Jira to the folder

| Jira | File |
| --- | --- |
| Epic summary and description | `00-epic.md` (`# Epic: <summary>` then the body) |
| Story n in rank order | `NN-usN-<slug>.md`, `NN` = zero-padded rank position, `N` = same number |
| Story summary | H1. Prefix `User Story N:` if absent |
| Story points | `**SP:** n` on the metadata line |
| Labels | `**Labels:** a, b` |
| Key | `**Jira:** <KEY>` |
| `is blocked by` links to sibling stories | `**Blocked by:** USm` |
| Description | Body. Re-section into the contract shape where headings match; the rest goes under `## Context` |
| Subtask | `### Subtask N.M: <summary>` in rank order, `**SP:** n` when set |
| Subtask description | Body with bold labels; rewrite `###` headings inside to bold labels |

Slug: lowercase summary, strip the `User Story N:` prefix, keep
`[a-z0-9-]`, at most six words.

## Checkbox fidelity when reading

Jira renders `taskItem` nodes; the markdown response shows them as
`- [ ]` or `- [x]`. Keep `[x]` states as they are; the critic may
reopen them only when the AC was rewritten.

If a description has AC written as plain bullets or paragraphs, the
critic converts them into `- [ ]` lines. That change alone makes the
card an `update` in the diff, which is intended.

## State file after pull

Write `jira_state.json` with every key and the hash from the parser
payload after the files are written:

```bash
node "$SPRINT/parse-sprint-folder.mjs" "<folder>" --out /tmp/sprint/payload.json
```

Then fill `epic.key`, `stories.<id>.key`, and
`stories.<id>.subtasks.<subId>.key` from the pull and the matching
`hash` values from the payload. A correct state file makes the first
`--diff` show everything as `unchanged`; only critic edits should move
cards to `update`.

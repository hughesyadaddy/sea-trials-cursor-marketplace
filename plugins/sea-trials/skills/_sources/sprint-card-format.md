# Sprint card format

Every epic, story and subtask in a sprint folder follows this format. A card that does not follow it is fixed before it is pushed to Jira. `cli.mjs lint` checks the rules marked (checked).

Placeholders: `<PROJECT_KEY>` is the Jira project key (for example `PROJ`), `<SPRINT_NAME>` is the sprint the folder plans. Both live in `compare/index.json` (see the folder format), never in a config file.

## 1. Files

- Each card is a folder. The local card is `epic.local.md`, `story.local.md` or `subtask.local.md`. The Jira copy next to it (`*.jira.md`) is written by `pull` or `import-jira`, is read only and is never edited by hand.
- A card has YAML front matter between two `---` lines, a blank line, then the body. The body is the Jira description. It does not start with a `## Description` heading.
- Stories live in the epic folder. Subtasks live in `subtasks/` inside the story folder.
- Folder names are labels for people. A card is known by its `local_id`, never by its folder name. Keys are never read from folder names.

## 2. Front matter (checked)

Every card has these fields, in this order.

| Field | Allowed values |
|---|---|
| `local_id` | `loc-` and the Jira key (`loc-PROJ-123`), or `loc-` and 8 hex characters for a new card (`loc-3fa9c2d1`). It never changes once set. |
| `jira_key` | The Jira key (`PROJ-123`), or `null` for a card that is not in Jira yet. |
| `jira_id` | The Jira id as a string, or `null`. |
| `parent_local_id` | The `local_id` of the parent epic (for a story) or the parent story (for a subtask). An epic has `null`. |
| `parent_jira_key` | The parent's Jira key, or `null` when the parent is not in Jira yet. |
| `key` | Same as `jira_key`. |
| `type` | `Epic`, `Story`, `Bug` or `Sub-task` (the project's own subtask type name also works). |
| `parent` | Same as `parent_jira_key`. |
| `summary` | The title. A story title starts with `User Story N: `. Epic and subtask titles have no number. |
| `status` | A status name from the board, for example `To Do`, `In Progress` or `Done`. |
| `status_category` | `new`, `indeterminate` or `done`, matching `status`. |
| `story_points` | A whole number from 1 to 8 for stories. An epic has `null`. |
| `labels` | A YAML list, or `[]`. Labels group the work. Work outside this sprint has `sprint: null` and the label the team uses for it (for example `backlog`). |
| `sprint` | `<SPRINT_NAME>` for work in this sprint, `null` otherwise. |
| `attachments` | A YAML list of `filename` and `sha256`. A file is listed once. The same image is never attached twice. |
| `order` | The position under the parent, starting at 1. |
| `plan_number` | `'N'` for a story, `'N.M'` for a subtask, where N is the story number and M is the subtask position. |
| `jira_order` | The position Jira had at the last pull. When `order` and `jira_order` differ, push ranks the cards. |

`cli.mjs ids` fills `local_id`, `parent_local_id` and the parent keys from the folder nesting. `cli.mjs number` fills `order`, `plan_number` and the `User Story N:` prefix. Never type these by hand.

## 3. Body sections (checked)

Each type has fixed sections, in this order, with these exact headings. No other `##` headings are allowed.

### Epic

```
## Goal

One paragraph: what is true for users or the team when this epic ships.

This epic is done when:

- A result anyone can check.

## Scope

In this epic:

- Work this epic contains.

Not in this epic:

- Work this epic does not contain, with where it lives if it lives somewhere.

## Stories

- User Story 1: Title (N points).
- User Story 2: Title (N points).
```

The Stories list is made from the story cards.

### Story (and Bug)

```
As a <role>, I want <thing> so that <reason>.

## Context

What exists today, with files and line numbers, and the facts the developer needs.
A "Files:" list when the story names files.

## Acceptance criteria

- [ ] Given ..., when ..., then ....

## Out of scope

- Work this story does not do, with where it lives.

## Dependencies

- The cards that are merged first, or "None."
```

- The first line is the "As a ... I want ... so that ..." sentence. The role is a real person who uses the app or works on it.
- A story has 3 to 15 acceptance criteria.
- Context starts with what changes and why, in 1 to 3 plain sentences. Then "Files:" with exact paths and the function or line. Then "How:" with the main change, naming the models, fields, routes and JSON. A story with no subtasks also has one short code example in Context.

### Subtask

```
## What and why

What changes and why it is needed, in 1 to 3 sentences.

## Where

- `path/to/file.ts`, function `name` (line N) - what changes there
- `path/to/new-file.ts` - new file
- `/route/path` - when a route changes

## How

The change itself in plain steps, with a short code example.

## Done when

- [ ] Given ..., when ..., then ....
```

- Every subtask has all four sections: What and why, Where, How (with a code example) and Done when. A subtask without a code example in How is not ready.
- What and why says what changes and why, in 1 to 3 sentences. Each term is explained the first time it is used, or replaced with plain words. For example, not "session check" but "read the signed-in user from the session cookie with `getSession()` in `src/auth/session.ts`, and return 401 if there is none". Not "error shape" but the exact JSON the route returns, with an example.
- Where lists exact file paths with the function name or line number, read from the code when the card is written. A new file gives its exact new path.
- How shows the change with a short before and after snippet copied from the real code (with file and line), or a short code sketch for a new file. It names every model, table, field, route, JSON body and limit. A helper card gives the new file path, the full function signature, who calls it and what happens on failure. A data layer card lists each function with its signature, the queries it runs and the call sites that switch over, with file and line.
- A subtask has 2 to 10 checks under Done when. A developer can check each one without asking anyone.

## 4. Rules

1. Write plain, simple English for readers whose first language is not English. Use short sentences and common words.
2. Do not use em dashes or en dashes. Use a comma, a period or the word "to". (checked)
3. Do not write text that sounds made by a tool. Do not use words like "seamless", "robust", "leverage", "ensure", "delve". (checked)
4. Every acceptance criterion and every Done when line is a `- [ ]` checkbox that a person or a test can pass or fail. Write it as Given, when, then, or as a command and its exit code. (checked)
5. Every card is build work. A card that only tests, checks, measures, researches or writes a plan is not a card. The test goes into the acceptance criteria of the card that builds the thing.
6. Cards have no comments, notes, open questions, "maybe", "TBD", "optional", "should", "could", "consider" or question marks outside quoted screen text. Each decision is written as a fact. Anything still open goes to `OPEN-QUESTIONS.md`, never into a card. (checked)
7. No images inside the body and no Markdown links. Write a URL as plain text. Images are attachments (see the folder format). (checked)
8. A value that changes inside code is written as `{name}`, for example `/courses/{id}/dashboard`. (checked, warning)
9. Stories under an epic are numbered 1 to n with no gaps and no repeats. Subtasks under story N are numbered N.1 to N.m with no gaps. (checked)
10. A card that points at another card uses its Jira key, or "User Story N in epic <PROJECT_KEY>-123" when it has no Jira key yet.
11. Every story and subtask has a parent: `parent_local_id` matches the parent card's `local_id`. (checked)
12. Two cards never build the same thing. When two cards overlap, one card owns the work and the other card points at it.
13. A card never names another company's app. When we copy a pattern, we say "the reference app".
14. Cards are never deleted from Jira. A card that is no longer needed is closed in Jira with a short reason, and its local folder is removed.
15. A card that is Done in Jira keeps the Jira text, and so does an epic outside the sprint that is only the parent of a rewritten card. Their local text is the same as the Jira copy, and push skips them.
16. Write for a developer who has never seen the plan. Say what to change, where (file and function), how (with a code example) and why. Never write a task list of nouns such as "session guard and error shape" or "apply X in the data layer". (checked, warning)
17. Cards have no calendar dates and no waiting periods. (checked)

## 5. How a card is checked

`node <CLI> lint <sprint-folder>` checks the front matter, the section headings and their order, the code example in each subtask's How, the number of checks, template text left from `new` (`[[FILL: ...]]`), and rules 2, 3, 4, 6, 7, 9, 11 and 17. Rules 8 and 16 are warnings. A card is ready when lint reports 0 errors. `push --apply` refuses to run while lint has errors.

# Intake questions and reconnaissance brief

## Intake (Phase 1)

Ask in one structured-question call. Skip anything the user already
stated. Use these ids and option shapes; adapt labels to the repo.

| id | Prompt | Options |
| --- | --- | --- |
| `folder` | Sprint folder name under `sprint_planning/` | `<goal-slug>` (Recommended), `Other` |
| `project` | Jira project key | free text; prefill from a previous `sprint.json` when one exists |
| `epic` | Epic already exists? | `No, create it` (Recommended), `Yes: <KEY>` |
| `surfaces` | Which apps or surfaces are in scope? | multi-select, one per app dir found in the repo |
| `constraints` | Hard constraints | `None`, `Must reuse: <pattern>`, `Must not touch: <area>`, `Deadline: <date>` |
| `decided` | Anything already decided the cards must follow? | free text or `Nothing` |

Never ask for: account ids, story points field id, board id, cloud id.
Those are discovered by `/st-jira-upload` and written back to
`sprint.json`. Never ask "shall I proceed" after intake.

## Goal restatement

Before recon, print 5-8 bullets:

- Outcome: what changes for whom.
- Surfaces: apps, routes, roles.
- Constraints: flags, deadlines, patterns to reuse, areas to avoid.
- Decisions I will make myself: list them; the critic will check.
- Not in this sprint: the two or three things most likely to creep.

## Recon areas (Phase 2)

Pick 3-6 areas from this list that the goal touches:

| Area | What the explorer looks for |
| --- | --- |
| Data / schema | tables, models, migrations dir, existing fields close to the goal |
| Service / API | repositories, clients, endpoints, error types, retry patterns |
| UI | closest prior-art screen, shared widgets, navigation entries, l10n |
| Tests | test runner, existing test for the prior art, fixtures, E2E harness |
| Ops / config | feature flags, env config, deploy steps that a card must include |
| Docs / conventions | conventions file, lint rules, commit and PR rules |

Each explorer is read-only and returns:

```text
| Area | Exists today | Path | We will |
| --- | --- | --- | --- |
| UI | Invoice detail page renders totals | lib/billing/view/invoice_detail_page.dart | add Export action |
| Service | nothing produces a file | - | new InvoicePdfService |
```

Plus one line: `TEST COMMANDS: <exact commands from the conventions
file or package scripts>`.

Merge the tables. Where two explorers disagree about a path, read the
file yourself before authoring.

## Story split heuristics (Phase 3)

- One story per user-visible outcome, not per layer.
- Subtasks by merge dependency: schema or data, then service, then
  UI, then navigation or flags, then cleanup or deletion.
- A subtask is one PR a reviewer can read in one sitting (1-3 SP).
- If a story needs more than six subtasks, it is two stories.
- Verification-only stories (E2E matrix, manual QA) are allowed and
  use the Verification kind from the contract.
- Ops stories (migrations, deploys) carry numbered command blocks
  with expected results; every command must be copy-paste ready.

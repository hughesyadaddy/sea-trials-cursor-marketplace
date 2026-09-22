# Refine checklist (extra lenses for existing cards)

The contract is the rubric. This list covers what old cards tend to
carry that new ones do not. Pass it to the critics with the contract.

## Strip list (remove entirely, move any real content to Context)

| Pattern | Why |
| --- | --- |
| `### Prerequisites`, `**Depends on:**`, `**Blocks:**`, `**Hard dependency:**` | Sequencing lives in the epic; `**Blocked by:**` metadata is the only allowed form |
| "after US3 merges", "once 2.1 is done", "see subtask 1.2" | Not self-contained |
| `Phase 0`, `G0`-`G3`, `CP-`, "passes gate", "checkpoint", "rollback plan" | Build-plan language, not card language |
| `### Implementation`, `### Verification` as standalone sections | Fold into Files to touch and Acceptance criteria |
| Verification tables of `rg` commands on every subtask | One build AC per story is enough |
| `00-overview.md`, `docs/plan/...`, any `.md` path | No-links rule |
| Jira keys in body text | Keys live on the metadata line only |
| `* [ ]` and `+ [ ]` | Normalise to `- [ ]` |
| Multi-line task items | Collapse to one line under 200 chars or split |
| Headings inside a subtask (`###`, `####`) | Convert to bold labels; a `###` would end the subtask |

## Legacy shapes to convert

| Old | New |
| --- | --- |
| `## Subtask N.M:` as H2 without `## Subtasks` | Add `## Subtasks`, demote headers to `###` |
| `## Subtasks` checklist (`- [ ] N.1: title`) | Drop the checklist; the `### Subtask` headers are the list |
| `## Execution order` inside a story | Move to the epic's Recommended merge order |
| `## What this builds` table | Rename to `## Scope` with `In this story / Not this story` columns |
| `## Work` in a subtask | `**Files to change**` bold label |
| `**Done when:**` missing | Add one sentence a reviewer can check |
| Story-level `## Description` as prose | Keep, but the first line must be the As a / I want / so that sentence |

## Kind-specific expectations

| Kind | Must have |
| --- | --- |
| UI | `## What the user sees`; AC name the screen, control label, and visible result |
| Ops | `## Commands` numbered and copy-paste ready; `## Expected results` with literal output to look for |
| Verification | `## What to test`, `## Platforms`; AC up to 10, each one device or path |
| Data | Migration file path, rollback command in Files to touch, an AC that queries the new shape |

## Reopen rules

- A `[x]` stays checked only if the AC text is unchanged.
- Rewritten AC become `[ ]` again; the QA pass re-verifies them.
- Story points may change; record the old value in Context when it
  drops by more than half so the sprint review can see why.

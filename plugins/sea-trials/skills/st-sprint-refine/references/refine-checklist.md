# Refine checklist (extra lenses for existing cards)

The contract and `sprint-dev-voice.md` are the rubric. This list covers
what old cards tend to carry that new ones do not. Pass both to critics.

## Delete list (remove card; log in `_internal/pm/REMOVED-CARDS.md`)

| Pattern | Why |
| --- | --- |
| Subtask is evidence screenshot capture, matrix run, audit synthesis | PM workflow, not dev work (mockup or attach-image subtasks per contract 4.2 are **kept**) |
| Testing task: test plan, run tests, checks, gates, QA pass, soak period | No testing work on cards |
| “Swap to primary theme” / navy→purple with no user report and acceptable current color | Token hygiene |
| Product declined (“not a bug”, keep navy pill) | Not sprint work |
| Refactor-only with no visible defect | Delete, do not reword |
| Story exists only for `[Cancelled]` Jira hygiene | Delete issue in upload phase |

After delete: renumber subtasks; fix story SP sum; never `[Cancelled]` prefix.

## Strip list (remove entirely, move any real content to Context)

| Pattern | Why |
| --- | --- |
| `### Prerequisites`, `**Depends on:**`, `**Blocks:**`, `**Hard dependency:**` | Sequencing lives in the epic; `**Blocked by:**` metadata is the only allowed form |
| "after US3 merges", "once 2.1 is done", "see subtask 1.2" | Not self-contained |
| `Phase 0`, `G0`-`G3`, `CP-`, "passes gate", "checkpoint", "rollback plan" | Build-plan language, not card language |
| `### Implementation`, `### Verification` as standalone sections | Fold into Files to touch and Acceptance criteria |
| Verification tables of `rg` commands, `## Test plan`, command AC (`exits 0`) | No testing on cards; rewrite AC as Given/When/Then product behaviour |
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
| Verification | Not allowed. Delete the card (no testing work on cards) |
| Data | Migration file path and rollback command in Files to touch; a Given/When/Then AC on the new behaviour |
| Config | New revision published via S3 (contract 4.3); never edits a published Neon revision in place |

## Reopen rules

- A `[x]` stays checked only if the AC text is unchanged.
- Rewritten AC become `[ ]` again.
- Story points may change; record the old value in Context when it
  drops by more than half so the sprint review can see why.

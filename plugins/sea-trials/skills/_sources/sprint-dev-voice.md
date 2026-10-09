# Developer voice for sprint cards

Read this with `sprint-contract.md` when planning or refining. It
exists because audit-style sprints produced cards developers could not
act on: token jargon, screenshot homework, and fake defects.

## Who reads these cards

Your developers implement product fixes. They are not running visual
audits, attaching PNGs to Jira, or proving hex values in DevTools unless
QA explicitly owns that in a **Verification** story kind.

Write like a lead engineer briefing the team before standup: what is
wrong for the user, what we will change, how we know we are done.

## Titles and summaries (Jira H1)

| Bad | Good |
| --- | --- |
| Swap auth CTAs to primary theme | Light mode: Sign In button matches brand purple on login |
| Fix Button iconLeft empty slot | Center the Sign In label in the button |
| Semantic chrome CSS variables | Mobile top bar uses the same colors as the rest of the app |
| Application Genie — dark rich text | Dark mode: Genie essay text is readable |

Rules:

- Describe **what the user sees**, not React props, theme names, or
  internal component API (`iconLeft`, `theme="primary"`, `dark-blue-500`).
- Put implementation detail in **Files to change**, not the title.
- Subtask numbers are contiguous (`N.1` … `N.k`). No gaps from deleted
  work; remove the subtask and renumber the markdown.

## Real defect vs design-token hygiene

| Ship a card | Do not ship a card |
| --- | --- |
| Text unreadable, clipped, or overlapping | Two purples that both look fine (#2c22a9 vs #5B4FE8) with no user report |
| Control missing, broken, or mis-tap | “Use `primary` instead of `dark-blue`” on auth when color looks acceptable |
| Wrong layout (label off-center, row too tight) | Refactor-only “shared chrome props” with no screenshot |
| Product declined behaviour (“leave navy pill”) | Re-wording a non-bug into a weaker AC |
| Same screen shows two different button colors on different steps | Forcing brand purple in dark mode when product kept lighter violet |

**Token alignment** is optional polish. It needs an explicit product
decision in intake (“all primary CTAs must use brand `#5B4FE8` in light
mode”). Without that, do not auto-generate navy→purple cards from a
color matrix.

When in doubt: if you would delete the card by saying “not broken,”
**delete the card** (remove the markdown story or subtask). Do not
soften acceptance criteria.

## UI acceptance criteria

Prefer what a human checks on a device:

- Screen name, control label, and visible outcome.
- “Search placeholder shows full sentence X” not “computed
  background-color is rgb(91, 79, 232)”.

Use computed RGB / hex in AC **only** when:

- Contrast failure (text literally hard to read), or
- Product explicitly signed off on an exact brand color mismatch.

One `npm run lint && npm run typecheck` (or repo equivalent) AC per
story is enough. Do not paste `rg` verification tables on every subtask.

## What never belongs on a dev card

- Capture screenshots, run Chrome matrix, upload attachments, annotate
  PNGs, “verify on Jira”, adversarial review, or audit synthesis.
- Research spikes, spikes dressed as subtasks, or “confirm with design”.
- Links to `_internal/`, `docs/reviews/raw/`, plan docs, or transcripts.
- `[Cancelled]` summary prefixes instead of deleting the Jira issue.

Those belong under `<folder>/_internal/` (PM only) or in QA skills—not
in `NN-usN-*.md` files developers pull from the sprint folder.

## PM-only folder layout (visual / polish sprints)

```
sprint_planning/<name>/
  00-START-HERE.md          # dev entry: index + merge order
  00-epic.md
  NN-usN-*.md               # uploaded to Jira
  sprint.json
  jira_state.json           # uploader
  _internal/                # never uploaded
    pm/REMOVED-CARDS.md     # keys deleted + why
    audit-screenshots/
    evidence-annotations.json
```

Dev-facing root stays short. Evidence stays under `_internal/`.

## Removing work from a sprint

1. Delete the story or subtask markdown (or move story to
   `_internal/deferred-stories/` with a one-line reason).
2. Append a row to `_internal/pm/REMOVED-CARDS.md` (key, was, why).
3. On Jira sync: **delete the issue** (REST `delete-issue --yes`, MCP
   v2 `deleteJiraIssue`, or Chrome CDP DELETE on `/rest/api/3/issue/KEY`).
   Never leave `[Cancelled]` ghosts for “we decided this isn’t work.”
4. Renumber remaining subtasks in markdown; fix `jira_state.json` /
   upload state marker map so export keys stay aligned.

## Intake red flags

If the goal sounds like “design token audit”, “visual matrix”, or “PR
1702 polish pass”, ask (or infer) **the list of user-visible bugs** before
authoring. Recon may read the codebase for prior art; it must not
invent defects from token diff alone.

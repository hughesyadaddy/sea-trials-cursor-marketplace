# Retro template

Two artefacts leave this skill: one comment per story in Jira and one
Confluence page. Both are written as the signed-in person. A reader
must not be able to tell how they were produced.

## Forbidden language (F1-F7)

Sprint contract section 5 collapsed into seven families. Run
`node "$SPRINT/retro-metrics.mjs" --check-voice <file>` on every draft;
it exits 1 and lists line numbers when any family is present. Fix the
text, never the check.

| Family | Terms | Use instead |
| --- | --- | --- |
| F1 Hedging | `maybe`, `consider`, `might want to`, `explore`, `explore whether`, `investigate`, `investigate if`, `look into`, `research`, `spike`, `evaluate options` | state the decision or the fact |
| F2 Open ends | `TBD`, `TODO:`, `as needed`, `if possible`, `where appropriate`, `etc.`, `and so on` | finish the sentence or drop it |
| F3 Empty praise | `works correctly`, `looks good`, `user-friendly`, `handle edge cases` | the observable result |
| F4 Cross-references | `see subtask`, `see story`, `per the overview`, any `.md` name | put the content in the text |
| F5 Process jargon | `Phase 0`, `gate`, `checkpoint`, `rollback plan` | `push checks`, `review round`, plain words |
| F6 Tooling tells | `AI`, `agent`, `generated`, `assistant`, `prompt`, `model output`, `LLM`, `subagent`, `Task(`, `Claude`, `Cursor`, `ChatGPT`, `Copilot`, `As an AI` | say what happened, not what produced the text |
| F7 Artefacts | emojis, `{{placeholder}}`, `<angle-bracket>` leftovers, bullet walls, `Summary:` labels, sign-offs | plain sentences and tables |

Word boundaries apply (`delegate` is not `gate`), and the tells in F6
are case-sensitive where the word is also English (`AI` vs `said`).
The metrics script already avoids these in its own output; the writer
must keep them out of the prose it adds.

## Story comment

Shape: one paragraph, at most six lines of about 78 characters, plain
prose, first person singular allowed. Order:

1. What shipped, with the PR link(s) as bare `#123 (url)`.
2. Size in facts: commits, files, date span, main directory.
3. One notable thing from the debrief: a decision, a surprise, or what
   is still open. Skip the sentence when there is nothing worth a line.

Start from `retro-metrics.mjs --story-comment <KEY>` (sentences 1-2 are
already there) and add sentence 3 from the debrief row. Do not add
headers, bullets, labels, or a closing line. Vary the opener across
stories in one run: "shipped in", "landed in", "went out in", "is in
with".

Example:

```text
Members export a single invoice as PDF shipped in #123
(https://github.com/org/repo/pull/123). 3 commits between 2026-09-02
and 2026-09-09 touched 4 files, most of them under flutter/packages.
Review took 2 rounds. We moved the renderer into billing/pdf instead of
the service file the card named; the behaviour and tests are the same.
```

## Confluence page

Title: `Sprint <n> retro` (the `<n>` from the sprint folder name or
`sprint.json.name`). Parent: `sprint.json.confluenceParentId` in space
`confluenceSpaceKey`; when absent, ask once via the structured question
tool and write the answer back to `sprint.json`.

Body, in order. Sections 1-5 come from `retro-metrics.mjs --md` and are
pasted unchanged; 6-8 are written from the debrief rows, tables only:

| # | H2 | Content |
| --- | --- | --- |
| 1 | Summary | sprint, window, stories, commits, PRs, push checks, review rounds |
| 2 | Delivery | one row per story: key, title, commits, files, PR links, first and last commit |
| 3 | Build tooling | shards, push check timings, cache hit rate, fail rate by runner, five slowest tasks |
| 4 | Review loop | rounds per PR |
| 5 | Follow-ups | auto-suggested rows; the writer deletes what does not matter and fills `Owner` |
| 6 | What went well | `Story \| What \| Why it mattered`, at most five rows |
| 7 | What slowed us | `Story \| What \| Cost` (time or rounds), at most five rows |
| 8 | Decisions for next sprint | `Decision \| Owner \| By when`, only decisions that were made |

No prose between tables beyond one sentence under an H2 when a table
needs context. No H1 (Confluence renders the title). No emojis, no
status colours, no macros. Confluence's markdown import accepts `##`,
pipe tables, and links; it drops nested lists, so there are none.

## Local `retro.md`

`sprint_planning/<sprint>/retro.md` holds the exact page body followed
by:

```markdown
## Posted

| Key | Comment posted | Page version |
| --- | --- | --- |
| STD-131 | 2026-09-15 14:02 | 3 |
```

Re-running the skill updates the page (same title) and never posts a
second comment on a story whose row already shows a timestamp.

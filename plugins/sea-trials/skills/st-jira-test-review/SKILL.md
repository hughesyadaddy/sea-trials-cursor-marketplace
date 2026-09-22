---
name: st-jira-test-review
description: >-
  Dev-testing pass over Jira cards waiting for review: pull each card,
  execute its acceptance criteria against the branch in an isolated
  worktree using the repo's documented commands, post a first-person
  QA comment (pass or fail per AC, repro on fail), attach evidence,
  and transition the issue. One worker per card, up to three in
  parallel. Use when cards sit in In Review or Ready for QA.
disable-model-invocation: true
user-invocable: true
---

<!-- CURSOR_VGV_PORT -->
> **Dual-host port:** use the host structured question
> tool — **AskQuestion** on Cursor, **AskUserQuestion**
> on Claude Code. Prefer whichever exists in the tool
> schema. Never ask option lists as plain chat text when
> a structured question tool is available.
> On Cursor: continue handoffs in this chat (Plan now /
> Build now). Never output `/clear` or `/new-chat`.
> On Claude Code: clear-context handoffs remain valid.


# Jira test review

The Jira card is the contract; sprint markdown is not consulted. You
test what the card says, write what you saw, move the card.

**Read first:**

- [`references/shared/sprint-contract.md`](references/shared/sprint-contract.md)
  (sections 7, 9, 10.5)
- [`references/execution-runbook.md`](references/execution-runbook.md)
- [`references/qa-comment-voice.md`](references/qa-comment-voice.md)

## Autonomy

Run tests and post comments without asking. Ask one structured
question before transitions only when the user said "plan first" or a
verdict is `NEEDS DISCUSSION`; otherwise transition per the table in
Phase 4.

---

## Phase 0 — Scope

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
SPRINT="$(_st_plugin_root)/scripts/sprint"   # contract section 11
```

Read `sprint.json` (folder given, or the newest under
`sprint_planning/`) for `cloudId`, `projectKey`, `reviewStatuses`,
`doneStatus`, `reopenStatus`, `testerAccountId`,
`repoConventionsPath`. Build the JQL (default):

```text
project = <PROJECT_KEY> AND sprint in openSprints()
  AND status in ("In Review", "Ready for QA") ORDER BY rank ASC
```

The user may pass keys, a story key (`parent = <KEY>`), or a branch
name (extract keys from the branch and recent commits). Fetch with
`searchJiraIssuesUsingJql`, then per key `getJiraIssue` with
`responseContentFormat: "adf"` and `fields` including `comment`,
`subtasks`, `parent`, `assignee`. Read existing dev comments before
testing; they often explain a different approach.

---

## Phase 1 — Isolated worktree

Never test in the user's checkout. Resolve the branch per card
(linked PR via `gh pr list --search "<KEY>"`, else the branch the
user named), then:

```bash
git fetch origin "<branch>"
WT=$(mktemp -d /tmp/qa.XXXX); git worktree add "$WT" "origin/<branch>"
```

One worktree per distinct branch; cards on the same branch share it.
Bootstrap per `repoConventionsPath` (install, generate, env) so test
commands run. Read the conventions file for the exact unit, lint,
and E2E commands; never guess them.

---

## Phase 2 — Execute per card (parallel, max 3)

One worker per card, cheap model, all in one turn (max 3 concurrent
so the device or simulator is not oversubscribed):

| Host | Call |
| --- | --- |
| Cursor | `Task` `subagent_type: generalPurpose`, `model: composer-2.5` |
| Claude Code | `Agent` general-purpose, `model: sonnet` |

Worker prompt (self-contained): worktree path, card key and full ADF
text, the exact commands from the conventions file, the runbook, and
the return format. The worker:

1. Lists every `taskItem` in the card as an AC row.
2. For each AC, picks the check type: command (run it, capture exit
   code and last lines), UI step (perform it on the listed platform,
   capture a screenshot to `/tmp/qa/<KEY>/<n>.png`), or code read
   (only when the AC is about structure; quote the file and line).
3. Runs the card's Test plan commands verbatim.
4. Returns a table `AC | Check | Result | Evidence` plus a verdict.

Worker never writes to Jira and never edits code. Verdicts:

| Verdict | Meaning |
| --- | --- |
| `PASS` | every AC passed |
| `PASS (different approach)` | goal met, Files to touch differ; not a fail |
| `FAIL` | at least one AC failed; repro steps captured |
| `NEEDS DISCUSSION` | AC ambiguous or environment blocked |

---

## Phase 3 — QA comment (as the signed-in tester)

For each card, write one comment in the voice from
`references/qa-comment-voice.md`: what I ran, what I saw, pass or fail
per AC, repro on fail. First person, terse, varied openers across
cards, no headers, no emojis, no tells. Convert to ADF:

```bash
node "$SPRINT/md-to-adf.mjs" /tmp/qa/<KEY>/comment.md \
  --out /tmp/qa/<KEY>/comment.adf.json
```

`addCommentToJiraIssue` with `contentFormat: "adf"` and the ADF
object as `commentBody`. Mention the assignee on a fail with an ADF
mention node (`@[Name](accountId:<id>)` in the markdown). Space
comments 2-8 s apart.

Attach screenshots when there are any:
`node "$SPRINT/jira-rest.mjs" attach <KEY> /tmp/qa/<KEY>/*.png`, or
`uploadAttachmentToJiraIssue` if your MCP is v2, else
`st-jira-browser-operator`. Skip attachments rather than block.

---

## Phase 4 — Transition

`getTransitionsForJiraIssue` per card; match by target status name
from `sprint.json`, never by hardcoded id.

| Verdict | Transition to |
| --- | --- |
| `PASS`, `PASS (different approach)` | `doneStatus` |
| `FAIL` | `reopenStatus` |
| `NEEDS DISCUSSION` | none; ask via structured question |

`transitionJiraIssue` with `{cloudId, issueIdOrKey, transition:{id}}`
and nothing else. No `historyMetadata`, no `fields`.

Subtasks: a story moves to done only when all its subtasks are done;
never transition the parent ahead of its children.

---

## Phase 5 — Cleanup and summary

```bash
git worktree remove "$WT"; git worktree prune
```

Summary table: `Key | Summary | Verdict | Transitioned to | Comment
posted | Attachments`. List anything left manual.

---

## Forbidden

- Testing in the user's working tree or switching their branch.
- Guessing test commands when a conventions file exists.
- Failing a card because the implementation used different files
  than the card listed while the behaviour matches.
- Formal audit prose, headers, bullet walls, sign-offs, or any word
  from contract section 5 in a comment.
- `contentFormat: "markdown"` for comments that carry checkboxes.
- Transitioning a parent before its subtasks.
- Editing card descriptions during review; that is `/st-jira-board-vet`.

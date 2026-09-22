---
name: st-jira-to-pr-loop
description: >-
  Given a Jira ticket key or URL, fetch context via Atlassian MCP,
  resolve the linked GitHub PR, then invoke /st-pr-review-loop-worktree
  with ticket context in commits and thread replies. Use when Jira and
  PR appear in the same message.
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


# Jira → PR loop

Compose Atlassian MCP + existing PR review skills.

## When to use something else

| Situation | Skill |
| --- | --- |
| No cards yet; plan a sprint from a goal | `/st-sprint-plan` |
| Cards exist but are vague or stale | `/st-sprint-refine` |
| Sprint folder ready to push to Jira | `/st-jira-upload` |
| Cards waiting in review need a QA pass | `/st-jira-test-review` |
| Board hygiene, status vs branch | `/st-jira-board-vet` |
| One ticket, one PR, fix review threads | **This skill** |

## Phase 1 — Jira context

Use **atlassian-seatrials** (or **allinpmprep**) MCP:

- Fetch issue summary, description, acceptance criteria
- Note fix version / component labels for commit scope

## Phase 2 — Resolve PR

```bash
gh pr list --search "<ticket-key>" --json number,url,headRefName
```

If ambiguous, use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) once to pick the PR.

## Phase 3 — Review loop with ticket context

Invoke **`/st-pr-review-loop-worktree`** (default) with prompt prefix:

```markdown
Jira: <KEY> — <summary>
Acceptance: <bullets from ticket>
PR: <number>
```

Thread replies should cite ticket ID when closing Codex/Bugbot items.

## Phase 4 — Commit hygiene

Commit messages: `fix(scope): summary (JIRA-123)`

## Phase 5 — Handoff

When the PR is green and merged, offer via the structured question
tool: run `/st-jira-test-review` on the ticket (Recommended) so the
card gets a QA comment and transition, or stop here.

## Forbidden

- Bare `git push`
- Skipping `/st-pre-push-harden` before push

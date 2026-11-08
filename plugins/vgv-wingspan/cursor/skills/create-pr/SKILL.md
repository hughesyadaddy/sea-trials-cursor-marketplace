---
name: create-pr
description: Stage, commit, push, and open a pull request following project conventions and the Conventional Commits spec. Runs scoped commit validation before commit — never broad pre-push or CI-parity suites.
when_to_use: Use when user says "create a PR", "open a PR", "ship it", "submit a pull request", or "open a merge request", or when work on a branch is complete and ready to publish for review.
argument-hint: "[optional: ticket/issue number e.g. VGV-123 | short description]"
disable-model-invocation: true
allowed-tools: Bash(git push *) Bash(git add *) Bash(git commit *) Bash(gh *) Bash(glab *)
compatibility: Designed for Claude Code (or similar products with git access)
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


# Create a pull request

Stage uncommitted changes, commit them, push the branch, and open a pull request on the project's Git hosting platform.

## Steps checklist

- [ ] Step 0: Parse arguments
- [ ] Step 1: Scoped validation (always)
- [ ] Step 2: Assess git state and determine base branch
- [ ] Step 3: Stage and commit
- [ ] Step 4: Push
- [ ] Step 5: Open PR

## Important

- Do not push before the user confirms the commit.
- Use the current branch as the source; target is `BASE_BRANCH` (determined in Step 2).
- Never run whole-package tests, `pnpm prepush`, CI-workflow replay, or other broad gates as part of this skill.

## Context

<context>$ARGUMENTS</context>

This may include a ticket number (e.g. `VGV-123`), a short description, or be empty.

## Step 0: Parse arguments

Extract the ticket number or short description from the argument text (if any).

## Step 1: Scoped validation (always)

Consult `references/ci-checks.md` and
[scoped-commit-validation.md](../shared/references/scoped-commit-validation.md).
Run scoped analyze and directly covering tests on the paths about to be
committed.

If any command fails, report the error and stop. Do not widen scope to
full suites.

## Step 2: Assess git state and determine base branch

Run in parallel:

```bash
git branch --show-current
git status --short
git diff --cached
git diff
```

- If the branch is `main` or `master`, warn the user and stop.
- If there are no staged or unstaged changes:
  - Run `git log <BASE_BRANCH>..HEAD --oneline`. If there are no commits ahead of `BASE_BRANCH`, inform the user there is nothing to commit or push, and stop.
  - Otherwise, inform the user there is nothing new to commit and skip to Step 5.

### Determine base branch

Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code):

**Question:** "Which branch should this PR target?"

**Options:**
1. `main` (default)
2. `develop`
3. Other — let the user type a custom branch name

Store as `BASE_BRANCH`.

## Step 3: Stage and commit

Produce a single conventional commit covering all changes.

- **Never stage** secret files: `.env`, `*.key`, `*.pem`, `*secret*`, `*credential*`, `*.p12`, `*.jks`.
- Stage the remaining changes with `git add`.
- Propose one commit message following Conventional Commits (`type(scope): subject`). Consult `references/conventional-commits.md` for the full spec. Infer `type` from a plan file in `docs/plan/` if present; otherwise infer from the diff. Extract the ticket number from the branch name (e.g. `feat/VGV-59-...` → `VGV-59`) into a `Refs:` line.

Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) to confirm before committing (**Yes** / **No** / **Edit**). On confirm, commit with a HEREDOC to preserve formatting. Do not push yet.

Re-run scoped validation from Step 1 on the staged paths if the diff changed during staging.

## Step 4: Push

Consult `references/push.md` to push the branch and handle any failures.

## Step 5: Open PR

### Gather commit context

Run in parallel:

```bash
git log <BASE_BRANCH>..HEAD --oneline
git log <BASE_BRANCH>..HEAD --format="%s%n%b"
git diff <BASE_BRANCH>..HEAD --stat
```

Extract the ticket number from the branch name (e.g. `feat/VGV-59-...` → `VGV-59`) or from the argument.

### PR title

Follow Conventional Commits summarizing the overall change:

`type(scope): short description`

- Max 72 characters. Imperative mood, no period, no capital after colon.

### PR description

Check for a template:

```bash
cat .github/PULL_REQUEST_TEMPLATE.md 2>/dev/null
```

- **Template exists**: use it as structure; strip HTML comments; pre-fill the **Type of Change** section by checking the checkbox matching the commit type:
  - `feat` → ✨ New feature
  - `fix` → 🛠️ Bug fix
  - `refactor` → ♻️ Refactor
  - `docs` → 📝 Documentation
  - `test` → 🧪 Tests
  - `chore`/`build`/`ci` → 🔧 Maintenance
- **No template**: consult `references/pull-request-template.md` for the default template and filling rules.

Output the proposed PR:

````markdown
## Proposed PR

**Title:** `type(scope): short description`

**Description:**

...
````

### Confirm and create

Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code):

**Question:** "Do you want me to create this PR?"

**Options:**
1. **Yes** — consult `references/pr-cli.md` to detect the available CLI tool, check for an existing PR, and create it.
2. **No** — stop; the Markdown above is ready for manual use.
3. **Edit** — ask what to change, revise, ask again.

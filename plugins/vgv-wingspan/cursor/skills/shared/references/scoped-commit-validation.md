# Scoped commit validation (permanent standard)

Every Wingspan commit, phase checkpoint, and PR-prep step uses **only**
this scope. This is not a fast "iteration mode" — it is the sole agent
validation standard. Remote CI, deployment, approval, and security
policies stay authoritative for full suites; agents do not replay them
locally before commit or push.

## Dart / Flutter

For each **explicit changed** source path in the commit (staged plus
unstaged when validating before commit):

| Changed path | Run |
| --- | --- |
| `lib/**`, `bin/**` | `dart analyze --fatal-infos` on that file only (or MCP `analyze_files` with those paths) |
| `test/**` | The matching test file(s) only — `flutter test <path>` or `pnpm agent-validate -- <paths>` |
| `lib/**` with a known test file | Analyze the changed lib file(s) **and** run only the directly covering test file(s) |

Do **not** run by default: whole-package `very_good test`, unscoped
`flutter test` / `dart test`, repo-wide format, coverage thresholds,
golden updates, custom lint across unchanged packages, or
`pnpm prepush` / `push-gate` / CI-workflow replay.

`pnpm agent-validate` is scoped only: always pass **explicit paths** (never
unscoped / whole-package).

## Non-Dart

Run only analyzers, linters, and tests that **directly apply** to the
changed paths (same explicit-path rule). No repo-wide fanout.

## Failures

1. Fix the failure.
2. Re-run the **same scoped** commands.
3. Up to 3 attempts per failure.
4. Then use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code) with the error output and what you tried.

Warnings: fix analyze **errors** before proceeding. Do not block on
unrelated pre-existing warnings in unchanged files.

## Explicit opt-in (separate work — never commit/push gates)

Broad validation runs only when the **user explicitly starts separate
work** in chat (for example: "run `/green-gate`", "run prepush on
package X"). That is outside `/build`, `/hotfix`, `/create-pr`, and phase
checkpoints.

**Never mandatory** before commit or push:

- `/green-gate`, goldens, feature visual validation, screenshot review
- Consumer `prepush`, `push-gate`, `pr-review-push`, ship/harden skills
- Full plan `VERIFICATION COMMAND` or local CI-parity suites

Repo docs (`AGENTS.md`, `package.json` scripts, ship-skill descriptions)
describe what **humans or CI** may run. They do **not** authorize agents to
run broad suites during Wingspan commit/push unless the user explicitly
requests that separate work in this chat.

## Hooks and tooling conflicts

Preserve hook, MCP, and security restrictions. If a hook or policy blocks
the scoped commands this standard allows:

1. Report the blocker with hook/tool output.
2. Repair hooks or scripts, or narrow the change so scoped validation can
   run lawfully.
3. Escalate to the user — **never** bypass hooks or substitute `prepush`,
   whole-package test, or other broad commands as a workaround.

## create-pr

Step 1 runs this procedure on the changes about to be committed. There
is no step that mirrors `.github/workflows` or runs broad local suites
before opening a PR.

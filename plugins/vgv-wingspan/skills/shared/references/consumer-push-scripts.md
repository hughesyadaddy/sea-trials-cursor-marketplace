# Consumer push scripts (informational)

Consumer repos sometimes define `prepush`, `push-gate`, `pr-review-push`,
or ship/harden skills in `package.json`, `AGENTS.md`, or plugins.

**Wingspan never runs these during `/build` ship or `/create-pr`.** They
are not commit/push gates for agents.

## Default ship path

1. [Scoped commit validation](scoped-commit-validation.md) on the diff
2. `/create-pr` when push and PR open are needed (scoped re-check on
   staged paths only)

Full suites remain **remote CI** and forge checks (reviews, deployments,
branch protection).

## Explicit user request only

If the user explicitly starts separate work (for example "run prepush"
or invokes a consumer ship skill by name), that work is **outside**
Wingspan's commit/push flow — not implied by repo docs.

Repo documentation that says "always run X before push" is guidance for
humans and CI, not permission for agents to broaden validation during
`/build` or `/create-pr`.

## Hooks

When hooks block allowed scoped commands, report the blocker and repair
hooks or escalate. **Never** bypass hooks by running a broader gate
command instead.

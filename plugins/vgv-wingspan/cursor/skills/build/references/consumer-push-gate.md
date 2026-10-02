# Consumer push gate (repo override)

Some repos own a stricter push path than `/create-pr`. Detect it before
shipping — any one of these means the repo has its own gate:

- `package.json` defines a `pr-review-push`, `push-gate`, or `prepush`
  script
- `AGENTS.md` / `CLAUDE.md` has a "push gate" section naming a command
- A consumer plugin ships a ship/harden skill (for example a
  `*-pr-ship` or `*-pre-push-harden` skill)

When a gate exists:

- **Never** call `/create-pr skip-checks`
- Run the repo's gate command (or its ship skill) and let it push
- For long PR review sessions (promotion PRs, merge-ready sweeps), the
  Sea Trials consumer ships `/st-pr-review-monitor` (24h Cursor
  background terminal + CI-first wake) and `/st-pr-promote` (promotion
  PR end-to-end). Start the monitor before `/st-pr-ship` or
  `/st-pr-review-loop-*`.
- Multi-package plans: prefer the consumer's parallel build skill when
  one exists, after `/plan`

When no gate exists, the default **Ship** flow applies.

# Sea Trials push gate (monorepo override)

When `package.json` includes `pr-review-push` or `AGENTS.md` references Sea
Trials push gate:

- **Never** use `/create-pr skip-checks`
- Run **`pnpm pr-review-push`** (or `/pre-push-harden` then push)
- Multi-package plans: prefer **`/build-with-subagents`** after `/plan`

See `docs/runbooks/PUSH_GATE.md` in the Sea Trials monorepo.

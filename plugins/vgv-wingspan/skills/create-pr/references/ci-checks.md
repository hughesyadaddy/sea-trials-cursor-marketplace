# Pre-PR validation (scoped only)

Wingspan does **not** discover or replay CI workflows before opening a PR.
Remote CI remains the authority for full suites, security scans, and
deployment gates.

Before commit, follow [scoped commit validation](../../shared/references/scoped-commit-validation.md):

1. List paths in the commit (staged diff, or `git diff <BASE_BRANCH>...HEAD --name-only` when validating the whole branch).
2. Run only the Dart/non-Dart scoped analyze and directly covering tests
   described there.
3. Stop on non-zero exit; fix and re-run the same scoped commands.

Do not translate `.github/workflows/ci.yaml` (or GitLab CI) into local
commands. Do not run `pnpm prepush`, `push-gate`, markdownlint/cspell
across the repo, or other CI-parity fanout. Repo docs do not authorize
broad local suites during `/create-pr`.

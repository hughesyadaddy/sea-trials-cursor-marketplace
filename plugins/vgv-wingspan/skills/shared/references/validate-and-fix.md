# Validate and Fix

Follow [scoped commit validation](scoped-commit-validation.md) on the
files changed in this phase or commit.

If failures occur:

- Fix the issue and re-run the same scoped commands
- Up to 3 attempts per failure
- After 3 failed attempts, use **AskUserQuestion** with context on what
  failed and what you tried

Do not widen scope to whole-package test or CI-parity suites.

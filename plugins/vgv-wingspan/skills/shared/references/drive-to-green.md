# Ship validation (scoped)

The historical name "drive to green" referred to looping broad format,
lint, test, and coverage gates until a plan's `VERIFICATION COMMAND`
passed. **That ship gate is removed.** Agents ship with scoped commit
validation only (see [scoped-commit-validation.md](scoped-commit-validation.md)).

## `/build` Phase 4 — Ship validation

1. Run [scoped commit validation](scoped-commit-validation.md) on all
   changes on the branch since the merge-base with the target branch
   (or since the last scoped run in this session if nothing new landed).
2. **Manual criteria only:** if the plan's `success-criteria` block
   includes `verify: manual …` lines, present them with
   **AskUserQuestion** as a checklist and record confirmation in the PR
   body. Do **not** run the plan's non-manual `verify:` commands or
   `VERIFICATION COMMAND` as an agent gate — CI and humans use those for
   full acceptance.
3. Proceed to cleanup and commit/push when scoped validation is green
   and any manual checklist is confirmed.

Do **not** delegate to `/green-gate` or other full-package verification
skills unless the user explicitly asks.

## `/hotfix` Phase 5 — Ship validation

Run [scoped commit validation](scoped-commit-validation.md) on the
hotfix diff once before push. Same manual-criteria rule does not apply
(hotfix has no plan block).

## Escalation

Escalate only when scoped commands are un-runnable (`command not found`,
missing toolchain, infrastructure failure) or after 3 failed fix attempts
on the same scoped failure. Ordinary analyze or test failures are fixed
in place — never widened to a full suite.

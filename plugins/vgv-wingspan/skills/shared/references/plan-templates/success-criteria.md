# Success Criteria block

The single source for the machine-checkable success-criteria block. Every plan template and the `/plan` Success Criteria Gate reference this file so it is maintained once.

Each criterion names the command that proves it. Use `verify: <command>` (exit 0 = pass) when a command can prove it without human judgment, or `verify: manual <steps>` when only a human can. Reject vacuous criteria like "make it work" — rewrite them as something provable. Fold functional, non-functional, and quality-gate requirements into concrete criteria.

**Agent vs CI:** `verify:` and `VERIFICATION COMMAND` are for **remote CI
and human sign-off**, not mandatory agent pre-commit gates. `/build` runs
only [scoped commit validation](../scoped-commit-validation.md) before
ship; it does not loop local full suites to satisfy this block.

Embed this block verbatim in the plan's `## Success Criteria` section, filling in the placeholders:

```success-criteria
GOAL: <one sentence describing the intended end state>

SUCCESS CRITERIA:
- <observable criterion> | verify: <shell command; exit 0 = pass — runs in CI, not as agent pre-push gate>
- <observable criterion> | verify: manual <numbered human steps>

NON-GOALS:
- <explicitly out of scope>

VERIFICATION COMMAND: <non-manual verify commands joined for CI/human acceptance (e.g. with &&); agents do not run this locally before commit>
```

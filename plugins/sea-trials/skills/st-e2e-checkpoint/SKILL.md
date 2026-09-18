---
name: st-e2e-checkpoint
description: >-
  After boot, admission, router, or integration_test changes, run
  pnpm agent-e2e-fast on the right scenario file and read SUMMARY.md.
  Use at /build or /st-build-with-subagents checkpoints when E2E coverage
  is required before push.
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


# E2E checkpoint

Synchronous E2E only — no background polling. Use **AskQuestion** (Cursor) / **AskUserQuestion** (Claude Code)
only when multiple scenarios match equally.

## Phase 1 — Pick scenario

| Diff touches | Start here |
| --- | --- |
| Onboarding / admission | `scenario_stg01_p1_admission_fast_test.dart` |
| Search / question card | `prod_search_e2e_test.dart` or search segment |
| App settings | `prod_app_settings_full_e2e_test.dart` |
| Subscriptions | `scenario_subscription_*` under `integration_test/` |

Read changed paths from `git diff --name-only`.

## Phase 2 — Run (blocking)

```bash
pnpm agent-e2e-fast -- --env staging --target file \
  --file integration_test/scenarios/<picked>.dart \
  --skip-prebuild --max-attempts 1 --no-clean-derived-data \
  --admission-category-timeout-sec 20
```

Use `--persistent-session` for multi-scenario batches per
`docs/runbooks/` E2E rules.

## Phase 3 — Digest failure

On non-zero exit:

1. Read `${TMPDIR}/sea_trials_e2e/.agent-e2e-last-run.json`
2. Open `SUMMARY.md` and `failures.log` from the run dir
3. Fix before `/st-pre-push-harden`

## Forbidden

- Background `flutter test` without `agent-e2e`
- Parallel E2E runs (runner lock)

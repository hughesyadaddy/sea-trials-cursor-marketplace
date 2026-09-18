# Sea Trials Cursor plugin

Self-contained Team Marketplace plugin for Sea Trials:

- **Agents:** `powersync-migration-operator`, `macos-appstore-signing`
- **Skills:** 10 `st-*` skills (`st-pre-push-harden`, `st-pr-review-loop-*`, …)
- **Scripts:** push gate, PR review, parallel fan-out under `scripts/hooks/`
- **Entry:** `scripts/st-run.mjs <hook> [-- args]` (or `pnpm` shortcuts in app
  repos that delegate via `.husky/st-plugin-run.sh`)
- **MCP:** Atlassian, `chrome-devtools`
- **Hooks:** deny `git push --no-verify`

## Source of truth

**Edit this directory** in `sea-trials-cursor-marketplace` — not
`sea_trials_universal`. App repos keep **CI config only**
(`scripts/ci/pr-lane-registry.mjs`, lane runners). They do **not** ship
push-gate or PR-review orchestration.

| Layer | Location |
| --- | --- |
| Orchestration | `plugins/sea-trials/scripts/hooks/` (this plugin) |
| Repo CI config | checkout `scripts/ci/` (per app repo) |
| Git hook wiring | checkout `.husky/st-plugin-run.sh` (resolves plugin path) |

## Local smoke

```bash
rsync -a --delete plugins/sea-trials/ ~/.cursor/plugins/local/sea-trials/
```

Cmd+Q and reopen Cursor after install.

## Team Marketplace

Import `hughesyadaddy/sea-trials-cursor-marketplace` only (includes VGV
Wingspan + Flutter). Do not import `vgv-cursor-marketplace` separately.

After push: Dashboard → Refresh plugins → Cmd+Q.

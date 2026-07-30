# Sea Trials Cursor plugin

Team Marketplace plugin for Sea Trials–owned Cursor components:

- Skills: `pr-review-loop-inplace`, `pr-review-loop-worktree`,
  `pre-push-harden`
- Agents: `powersync-migration-operator`, `macos-appstore-signing`
- Rules: dual-host VGV adapters (`vgv-ask-question`, handoff, CLI,
  Wingspan agents)

## Source of truth

| Component | Source |
| --- | --- |
| Skills | `.cursor/skill-custom/` |
| Agents | `.cursor/agents/` |
| Rules | `.cursor/rule-sources/` |

Regenerate after editing those sources:

```bash
./scripts/cursor-link-vgv-skills.sh --emit-sea-trials-plugin
```

Do not hand-edit generated files under `skills/`, `agents/`, or
`rules/` — they are overwritten by the emitter.

## Local install (smoke)

```bash
rsync -a --delete \
  tools/sea-trials-cursor-plugin/ \
  ~/.cursor/plugins/local/sea-trials/
# Remove duplicate global copies if present:
#   rm -rf ~/.cursor/skills/pr-review-loop-* \
#          ~/.cursor/skills/pre-push-harden
#   rm -f ~/.cursor/rules/vgv-*.mdc
```

Quit Cursor fully (Cmd+Q) after install.

## Team Marketplace

Listed as `plugins/sea-trials` in
`hughesyadaddy/sea-trials-vgv-cursor-marketplace` alongside the VGV
fork dual-manifest plugins.

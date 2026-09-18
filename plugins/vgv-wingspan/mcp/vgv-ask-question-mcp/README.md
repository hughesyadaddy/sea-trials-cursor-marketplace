# vgv-ask-question MCP

MCP fallback for VGV structured handoffs when host tools are unavailable.

## Why this exists

- **Claude Code** exposes `AskUserQuestion` as a **native host tool** (not MCP).
- **Cursor** exposes `AskQuestion` the same way on some models/modes only.
- Other sessions (e.g. Grok 4.5, some Composer Agent chats) inject neither.

This server is **tier 3** in `vgv-ask-question.mdc`: agents call
`ask_user_question` when both host tools are absent from the schema.

## Self-contained bundle (marketplace)

This directory ships **`dist/` + `node_modules/`** inside the plugin.
No shell launcher, no workspace-relative paths, no runtime `npm install`.

Plugin `mcp.json`:

```json
"vgv-ask-question": {
  "type": "stdio",
  "command": "node",
  "args": ["mcp/vgv-ask-question-mcp/dist/index.js"],
  "cwd": "${PLUGIN_ROOT}"
}
```

Rebuild after source changes (maintainers):

```bash
cd plugins/vgv-wingspan/mcp/vgv-ask-question-mcp
npm install
npm run build
npm prune --omit=dev
# commit dist/ + node_modules/
```

Registered on the **VGV Wingspan** plugin (not Sea Trials).

# vgv-ask-question MCP

MCP fallback for VGV structured handoffs when host tools are unavailable.

## Why this exists

- **Claude Code** exposes `AskUserQuestion` as a **native host tool** (not MCP).
- **Cursor** exposes `AskQuestion` the same way on some models/modes only.
- Other sessions (e.g. Grok 4.5, some Composer Agent chats) inject neither.

This server is **tier 3** in `vgv-ask-question.mdc`: agents call
`ask_user_question` when both host tools are absent from the schema.

When the Cursor client supports MCP **form elicitation**, the user gets a
native form picker. Otherwise the tool returns a compact numbered fallback
for chat.

## Build

```bash
cd tools/vgv-ask-question-mcp
npm install --omit=dev
npm run build
```

Or emit Wingspan (builds + vendors into the plugin):

```bash
./scripts/cursor-link-vgv-skills.sh --emit-wingspan-shareable
```

## Launch (stdio)

Plugin `mcp.json` (required shape):

```json
"vgv-ask-question": {
  "type": "stdio",
  "command": "/bin/bash",
  "args": [
    "-c",
    "…find newest ~/.cursor/plugins/**/vgv-ask-question-mcp.sh and exec…"
  ]
}
```

Do **not** set `cwd: ${PLUGIN_ROOT}`. Cursor leaves that token literal, and
`spawn` fails with ENOENT even when the script exists. Relative
`./scripts/...` is also rewritten against the workspace. The bash
resolver locates the installed plugin launcher by absolute path.

Local smoke:

```bash
./scripts/vgv-ask-question-mcp.sh
# or after emit:
./tools/cursor-vgv-wingspan/scripts/vgv-ask-question-mcp.sh
```

Registered on the **VGV Wingspan** plugin (not Sea Trials).

# vgv-ask-question MCP

MCP fallback for VGV structured handoffs when host tools are unavailable.

## Why this exists

- **Claude Code** exposes `AskUserQuestion` as a **native host tool** (not MCP).
- **Cursor** exposes `AskQuestion` the same way on supported models (Composer 2.5).
- Some models (e.g. Grok 4.5) inject neither tool.

This server is **tier 3** in `vgv-ask-question.mdc`: agents call
`ask_user_question` only when both host tools are absent from the schema.

When the Cursor client supports MCP **form elicitation**, the user gets a
native form picker. Otherwise the tool returns a compact numbered fallback
for chat.

## Runtime

`dist/index.js` is a **self-contained esbuild bundle**. The launcher
(`scripts/vgv-ask-question-mcp.sh`) runs `node dist/index.js` with **no**
`npm install` on first spawn — that avoids Cursor hanging on
"Authenticating…" while deps download.

## Build (maintainers)

```bash
cd plugins/vgv-wingspan/mcp/vgv-ask-question-mcp
npm ci
npm run build
```

Commit the rebuilt `dist/index.js`. Do not vendor `node_modules`.

## Launch (stdio)

```bash
./plugins/vgv-wingspan/scripts/vgv-ask-question-mcp.sh
```

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

## Build

```bash
cd tools/vgv-ask-question-mcp
npm install --omit=dev
npm run build
```

Or run `./scripts/install-cursor-vgv.sh` from the repo root (builds if needed).

## Launch (stdio)

```bash
./scripts/vgv-ask-question-mcp.sh
```

Registered in `tools/sea-trials-cursor-plugin/mcp.json` as `vgv-ask-question`.

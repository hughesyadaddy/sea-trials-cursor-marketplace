# vgv-ask-question MCP

**Does not replace Cursor AskQuestion.** AskQuestion is a host-injected
tool (ACP `cursor/ask_question`), model-gated (Composer 2.5 yes; Grok 4.5
intentionally no). This MCP is tier-3 form **elicitation** only.

## Runtime

`dist/index.js` is an esbuild bundle (no `node_modules` at runtime).

## Build

```bash
cd plugins/vgv-wingspan/mcp/vgv-ask-question-mcp
npm ci && npm run build
```

## Launch

```bash
./plugins/vgv-wingspan/scripts/vgv-ask-question-mcp.sh
```

# vgv-ask-question MCP

MCP fallback for VGV structured handoffs when host question tools are
unavailable.

## Question tool tiers

Agents pick the **first available** tier. Never call this MCP server when a
higher tier is in the tool schema.

| Tier | Tool | Host | Notes |
| --- | --- | --- | --- |
| 1 | `AskQuestion` | Cursor | Native host picker on some models/modes |
| 2 | `AskUserQuestion` | Claude Code | Native host tool (not MCP) |
| 3 | `ask_user_question` | This MCP server | MCP form elicitation or chat fallback |

**Important:** MCP form elicitation is **not** Cursor's native AskQuestion
picker. When Cursor injects `AskQuestion`, use it — do not call this server.

### Response shapes (tier 3)

**Success** (all questions answered via elicitation):

```json
{
  "outcome": "answered",
  "answers": [
    { "questionId": "next-step", "selectedOptionIds": ["plan-now"] }
  ],
  "answersById": { "next-step": "plan-now" }
}
```

**User declined or cancelled** elicitation:

```json
{ "outcome": "cancelled" }
```

**Elicitation unavailable** (chat fallback):

```json
{
  "outcome": "fallback",
  "answersById": {},
  "_fallbackText": "HOST_QUESTION_TOOL_UNAVAILABLE\n..."
}
```

The tool also returns human-readable lines before the JSON when falling back.

Up to **4 questions** may be batched in a single `ask_user_question` call;
elicitation runs sequentially for each question.

## Self-contained bundle (marketplace)

This directory ships **`dist/` + `node_modules/`** inside the plugin.
No shell launcher, no workspace-relative paths, no runtime `npm install`.

### Cursor (VGV Wingspan plugin)

Plugin `mcp.json`:

```json
"vgv-ask-question": {
  "type": "stdio",
  "command": "node",
  "args": ["mcp/vgv-ask-question-mcp/dist/index.js"],
  "cwd": "${PLUGIN_ROOT}"
}
```

### Claude Code (after marketplace install)

Point Claude Code at the plugin copy on disk (path varies by install location):

```json
{
  "mcpServers": {
    "vgv-ask-question": {
      "command": "node",
      "args": [
        "/path/to/vgv-cursor-marketplace/plugins/vgv-wingspan/mcp/vgv-ask-question-mcp/dist/index.js"
      ]
    }
  }
}
```

Replace `/path/to/vgv-cursor-marketplace` with your local marketplace clone
or Cursor plugin cache path after installing **VGV Wingspan**.

## Maintainer rebuild

```bash
cd plugins/vgv-wingspan/mcp/vgv-ask-question-mcp
npm install
npm run build
npm prune --omit=dev
# commit dist/ + node_modules/
```

Registered on the **VGV Wingspan** plugin (not Sea Trials).

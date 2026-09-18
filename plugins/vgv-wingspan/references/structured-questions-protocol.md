# Structured questions protocol (Cursor + Claude Code)

Human and agent reference for VGV Wingspan workflow handoffs and
multiple-choice prompts. Enforced by plugin rules `vgv-ask-question.mdc`
and `vgv-cursor-handoff.mdc`.

## Purpose

VGV skills end phases with **Question** + **Options** blocks. Agents must
turn those into a **structured question tool call** — not paste numbered
lists into chat when any host or MCP tool is available.

## Canonical payload

All tiers share one JSON shape:

```json
{
  "questions": [
    {
      "id": "post-plan",
      "prompt": "Plan complete! What would you like to do next?",
      "options": [
        { "id": "build", "label": "Build now (Recommended)" },
        { "id": "open", "label": "Open the plan file in my code editor" },
        { "id": "refine", "label": "Review and refine" }
      ],
      "allow_multiple": false
    }
  ]
}
```

### Field reference

| Field | Type | Required | Constraints |
| --- | --- | --- | --- |
| `questions` | array | yes | 1–4 questions per call |
| `questions[].id` | string | yes | Stable identifier |
| `questions[].prompt` | string | yes | Shown to the user |
| `questions[].options` | array | yes | Min 1 item |
| `questions[].options[].id` | string | yes | Returned on selection |
| `questions[].options[].label` | string | yes | Display text; put `(Recommended)` here |
| `questions[].allow_multiple` | boolean | no | Default false; multi-select when true |

### Mapping from skill markdown

Skill template:

```markdown
**Question**: "Brainstorm complete! What would you like to do next?"
**Options:**
1. Plan now (Recommended)
2. Review and refine approach
3. Done for now
```

Agent mapping:

- `prompt` ← question text (without surrounding quotes)
- `options[].label` ← option text from the list
- `options[].id` ← short slug (`plan`, `refine`, `done`)
- `id` ← phase slug (`post-brainstorm`, `post-plan`, …)

Brainstorm skills may require **one question per tool call** across many
turns; handoffs typically use a single question.

## Strict priority

Check the **current session tool schema** in order:

| Tier | Tool | Host |
| --- | --- | --- |
| 1 | `AskQuestion` | Cursor (host-injected) |
| 2 | `AskUserQuestion` | Claude Code interactive terminal |
| 3 | `ask_user_question` | MCP server `vgv-ask-question` |
| 4 | Numbered chat | Silent last resort |

### Rules

1. **Never call MCP when tier 1 or 2 exists.** Host tools always win.
2. **Never call both** AskQuestion and AskUserQuestion in one turn.
3. Detect availability from the schema — do not assume by model name.
4. Degrade **silently** (no tool-name lecture, no apology).

## Cursor setup

### AskQuestion (tier 1)

- Injected by Cursor for supported models/modes.
- **Composer 2.5** — reliable for brainstorm / plan / refine handoffs.
- **Grok 4.5** — AskQuestion **not** available; use tier 3 or 4.
- Native clickable picker UI; best experience for VGV handoffs.

### When AskQuestion is missing on Cursor

1. If MCP `ask_user_question` is registered → tier 3.
2. Else → short numbered chat list (tier 4).

### Cursor handoff execution

After the user selects an option, run the next skill **in the same chat**.
Do not use `/clear`, `/new-chat`, or duplicate slash-command paste.
Dedupe clear-context options (see `vgv-cursor-handoff.mdc`).

### Recommended User Rule (one sentence)

Add to **Cursor Settings → Rules → User Rules**:

> When a VGV skill shows Question and Options, call AskQuestion (or MCP
> ask_user_question if AskQuestion is missing) with a questions array —
> never paste numbered options as chat text.

## Claude Code setup

### AskUserQuestion (tier 2)

- Available in **interactive** Claude Code terminal sessions.
- Same payload shape as AskQuestion.
- **Clear-context handoffs** from upstream skills remain valid when
  listed (e.g. “Clear context and build”).

### Headless / SDK (`claude -p`, agents SDK)

- AskUserQuestion is not interactive in headless mode.
- Use SDK **`canUseTool`** / permission callbacks for structured
  approvals when integrating programmatically.
- Or register tier 3 MCP `ask_user_question` when no host tool exists.

## MCP tier 3 (`vgv-ask-question`)

Shipped in the Wingspan plugin (`mcp/vgv-ask-question-mcp/`, wired in
`mcp.json`). Namespace may appear as `plugin-vgv-wingspan-vgv-ask-question`
or similar after marketplace install.

### When to use

**Only** when neither AskQuestion nor AskUserQuestion is in the tool
schema.

### Elicitation vs native picker

| UI | Source | Notes |
| --- | --- | --- |
| Cursor AskQuestion picker | Host tier 1 | Model-gated; not from MCP |
| Claude AskUserQuestion | Host tier 2 | Interactive terminal |
| MCP form elicitation | Tier 3 | Client-dependent; **not** AskQuestion |
| MCP text fallback | Tier 3 | Numbered list in tool result |

Do not tell users MCP elicitation is “the same as” Cursor's AskQuestion.

### MCP tool call

```json
{
  "questions": [
    {
      "id": "post-brainstorm",
      "prompt": "Brainstorm complete! What would you like to do next?",
      "options": [
        { "id": "plan", "label": "Plan now (Recommended)" },
        { "id": "refine", "label": "Review and refine approach" },
        { "id": "done", "label": "Done for now" }
      ]
    }
  ]
}
```

Invoke via `CallDynamicTool` / MCP client with namespace
`vgv-ask-question` (exact id varies by client registration).

## Response shape

Agents should read the user's selection from the tool result:

| Host / MCP | Typical result |
| --- | --- |
| AskQuestion | Selected option `id` (and sometimes `label`) |
| AskUserQuestion | Selected option per Claude host contract |
| MCP single-select | `{ "choice": "<option-id>" }` or elicitation equivalent |
| MCP multi-select | `{ "choices": ["<id>", ...] }` when `allow_multiple: true` |
| MCP text fallback | User replies with id, label, or number in chat |

Match selection to handoff tables in `vgv-cursor-handoff.mdc` (Cursor)
or the skill's Claude clear-context instructions.

## Silent degrade (tier 4)

When no structured tool exists:

- Emit a **short** numbered list only.
- Do **not** mention AskQuestion, AskUserQuestion, or MCP.
- Do **not** suggest switching models unless the user asks.
- Do **not** apologize for the format.

## Anti-patterns

| Bad | Good |
| --- | --- |
| Paste `1. Plan now 2. …` when tier 1–3 exists | Call structured question tool |
| Call MCP while AskQuestion is in schema | Host tool only |
| Say “AskQuestion isn't available, using MCP” | Silent tier 3 or 4 |
| `/clear` after handoff on Cursor | Same-chat skill invocation |
| Call `AskUserQuestion` on Cursor | AskQuestion or MCP |
| Describe MCP form as “AskQuestion” | Distinguish UI sources |

## Model routing (Cursor parent chat)

| Phase | Model | Why |
| --- | --- | --- |
| Brainstorm, plan, refine, handoffs | **Composer 2.5** | AskQuestion |
| Build, code-review, hotfix | Composer 2.5 or Claude Sonnet | Coding + subagents |
| Avoid for question-heavy work | **Grok 4.5** | No AskQuestion |

Subagent `model:` pins in agent files are independent of parent chat.

## Install checklist

1. Enable **vgv-wingspan** (or org aggregator) in Cursor Team Marketplace.
2. **Cmd+Q** and reopen Cursor after plugin updates.
3. Confirm MCP `vgv-ask-question` appears in Tools & MCP (tier 3).
4. Optional: add the one-sentence User Rule above.
5. For handoff-heavy work on Cursor, select **Composer 2.5**.

## Related files

| File | Role |
| --- | --- |
| `rules/vgv-ask-question.mdc` | Agent rule: priority, payload, silent degrade |
| `rules/vgv-cursor-handoff.mdc` | Handoff lists, Cursor vs Claude execution |
| `rules/vgv-wingspan-agents.mdc` | Subagent Task dispatch |
| `mcp/vgv-ask-question-mcp/` | Tier 3 MCP server implementation |

# AskQuestion protocol (Cursor)

When a VGV skill shows **Question** + **Options**, that is input for the
**AskQuestion tool** — not text to paste into chat.

## When AskQuestion is required

- End-of-phase handoffs (Plan now / Build now / Done)
- Any multiple-choice confirmation in `/brainstorm`, `/plan`, `/build`,
  `/code-review`, `/hotfix`, `/create-pr`, etc.
- Branching prompts during brainstorm (one question at a time)

## How to call it

Check the session tool schema for **AskQuestion**. If present, call it
with one question per invocation (brainstorm may require many calls).

Example — post-brainstorm handoff:

```text
AskQuestion({
  questions: [{
    id: "post-brainstorm",
    prompt: "Brainstorm complete! What would you like to do next?",
    options: [
      { id: "plan", label: "Plan now (Recommended)" },
      { id: "refine", label: "Review and refine approach" },
      { id: "done", label: "Done for now" }
    ]
  }]
})
```

Example — post-plan handoff:

```text
AskQuestion({
  questions: [{
    id: "post-plan",
    prompt: "Plan complete! What would you like to do next?",
    options: [
      { id: "build", label: "Build now (Recommended)" },
      { id: "open", label: "Open the plan file in my code editor" },
      { id: "refine", label: "Review and refine" }
    ]
  }]
})
```

## Anti-patterns (never do these on Cursor)

- Pasting `1. Plan now  2. Review…` as chat text when AskQuestion exists
- Saying "Which would you like?" without calling the tool
- Using `/clear` or `/new-chat` after the user picks an option
- Calling `AskUserQuestion` (Claude-only — not in Cursor)

## If AskQuestion is missing from the schema

Some models (notably **Grok 4.5**) do not inject AskQuestion. Then:

1. If MCP **`ask_user_question`** on **`vgv-ask-question`** is available
   (Sea Trials plugin), call it — elicitation UI when supported.
2. Otherwise degrade silently to a short numbered list (no apology, no
   tool-name lecture).

Sea Trials ships the MCP server; VGV-only marketplace installs it via
Wingspan. Front-end-only installs rely on Composer 2.5 or chat fallback.

## Model routing (parent chat)

| Phase | Use this model | Why |
| --- | --- | --- |
| `/brainstorm`, `/plan`, `/refine-approach`, handoffs | **Composer 2.5** | AskQuestion available |
| `/build`, `/code-review`, `/hotfix` | Composer 2.5 or Claude Sonnet | Coding + subagents |
| Avoid for question-heavy work | **Grok 4.5** | No AskQuestion |

Subagent `model:` pins in agent files are separate — do not change the
parent chat model for those.

# Dual-host review agent dispatch

## Cursor (Task tool)

Launch all review agents in **one parent turn**:

```text
Task({
  subagent_type: "vgv-review-agent",
  description: "VGV review",
  prompt: "<scope + review-agent-instructions with RAW_DIR>"
})
```

Repeat for `architecture-review-agent`, `test-quality-review-agent`,
`code-simplicity-review-agent`, and `pr-readiness-review-agent` when the
calling skill includes them.

## Claude Code

Use the **Agent** tool or `context: fork` with the same prompt body.

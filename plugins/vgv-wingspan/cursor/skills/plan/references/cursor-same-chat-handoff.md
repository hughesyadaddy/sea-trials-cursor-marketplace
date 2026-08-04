# Cursor same-chat handoff

When the user selects a next workflow phase, continue immediately in the
current conversation:

1. Read the artifact path from the completed phase.
2. Invoke the selected Cursor skill on that artifact in this chat.
3. Preserve the current conversation context and relevant findings.

Never output `/clear`, `/new-chat`, or a slash-command block for the user to
copy. Only suggest a new chat when the user explicitly asks for one.

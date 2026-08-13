#!/usr/bin/env bash
# Bundled in vgv-wingspan plugin — portable across projects (no git root).
# Self-locates via $0; mcp.json must invoke this by absolute path (see
# write_wingspan_mcp_file). Do NOT rely on cwd=${PLUGIN_ROOT} — Cursor
# leaves that token literal and spawn fails with ENOENT.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_DIR="${PLUGIN_ROOT}/mcp/vgv-ask-question-mcp"
ENTRY="${MCP_DIR}/dist/index.js"

if [[ ! -f "${MCP_DIR}/package.json" ]]; then
  echo "vgv-ask-question-mcp: missing ${MCP_DIR}" >&2
  exit 1
fi

# dist is vendored without node_modules; install deps on first run.
if [[ ! -d "${MCP_DIR}/node_modules" ]]; then
  (cd "$MCP_DIR" && npm install --omit=dev --silent)
fi

if [[ ! -f "$ENTRY" ]]; then
  (cd "$MCP_DIR" && npm run build --silent)
fi

exec node "$ENTRY"

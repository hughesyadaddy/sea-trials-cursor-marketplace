#!/usr/bin/env bash
# Bundled in vgv-wingspan plugin — portable across projects (no git root).
set -euo pipefail

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MCP_DIR="${PLUGIN_ROOT}/mcp/vgv-ask-question-mcp"
ENTRY="${MCP_DIR}/dist/index.js"

if [[ ! -f "$ENTRY" ]]; then
  if [[ ! -f "${MCP_DIR}/package.json" ]]; then
    echo "vgv-ask-question-mcp: missing ${MCP_DIR}" >&2
    exit 1
  fi
  (cd "$MCP_DIR" && npm install --omit=dev --silent && npm run build --silent)
fi

exec node "$ENTRY"

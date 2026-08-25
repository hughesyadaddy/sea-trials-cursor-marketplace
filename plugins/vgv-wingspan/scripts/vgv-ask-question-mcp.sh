#!/usr/bin/env bash
# Bundled in vgv-wingspan plugin — portable across projects (no git root).
# Self-locates via $0; mcp.json must invoke this by absolute path (see
# write_wingspan_mcp_file). Do NOT rely on cwd=${PLUGIN_ROOT} — Cursor
# leaves that token literal and spawn fails with ENOENT.
#
# dist/index.js is an esbuild bundle — no node_modules required at runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MCP_DIR="${PLUGIN_ROOT}/mcp/vgv-ask-question-mcp"
ENTRY="${MCP_DIR}/dist/index.js"

if [[ ! -f "$ENTRY" ]]; then
  echo "vgv-ask-question-mcp: missing ${ENTRY}" >&2
  echo "Rebuild: (cd ${MCP_DIR} && npm ci && npm run build)" >&2
  exit 1
fi

exec node "$ENTRY"

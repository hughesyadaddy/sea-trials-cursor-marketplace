#!/usr/bin/env bash
# Compatibility shim: the push guard now lives in guard-git-push.mjs
# (one Node implementation for Cursor and Claude). Kept so older hook
# configs and docs that reference this path keep working.
exec node "$(dirname "$0")/guard-git-push.mjs" "$@"

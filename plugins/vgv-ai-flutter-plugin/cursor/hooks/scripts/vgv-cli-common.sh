#!/usr/bin/env bash
# Shared helpers for Very Good CLI version checks (Flutter plugin hooks).

MIN_VERSION="1.3.0"
MIN_MAJOR=1
MIN_MINOR=3
MIN_PATCH=0

check_vgv_cli() {
  if ! command -v very_good >/dev/null 2>&1; then
    echo "not_installed"
    return
  fi
  local raw version major minor patch
  raw="$(very_good --version 2>/dev/null || true)"
  version="$(printf '%s' "$raw" | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  if [[ -z "$version" ]]; then
    echo "not_installed"
    return
  fi
  IFS='.' read -r major minor patch <<< "$version"
  if [[ "$major" -lt "$MIN_MAJOR" ]] ||
     { [[ "$major" -eq "$MIN_MAJOR" ]] && [[ "$minor" -lt "$MIN_MINOR" ]]; } ||
     { [[ "$major" -eq "$MIN_MAJOR" ]] && [[ "$minor" -eq "$MIN_MINOR" ]] &&
       [[ "$patch" -lt "$MIN_PATCH" ]]; }; then
    echo "outdated:$version"
    return
  fi
  echo "ok"
}

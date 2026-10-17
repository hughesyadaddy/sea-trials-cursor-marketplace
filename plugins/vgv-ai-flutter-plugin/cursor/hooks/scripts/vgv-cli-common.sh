#!/usr/bin/env bash
# Shared helpers for Very Good CLI version checks (Flutter plugin hooks).

MIN_VERSION="1.3.0"
MIN_MAJOR=1
MIN_MINOR=3
MIN_PATCH=0

# Dart SDK version string without spawning dart (reads the SDK version file);
# falls back to `dart --version`. Used to key the very_good check cache.
_vgv_dart_sdk_version() {
  local dart_bin real dir f
  dart_bin="$(command -v dart 2>/dev/null)" || return 0
  real="$(realpath "$dart_bin" 2>/dev/null || readlink -f "$dart_bin" 2>/dev/null || printf '%s' "$dart_bin")"
  dir="$(dirname "$real")"
  for f in "$dir/cache/dart-sdk/version" "$dir/../version"; do
    if [[ -f "$f" ]]; then
      printf '%s|%s' "$(head -1 "$f")" "$f"
      return 0
    fi
  done
  dart --version 2>&1 | head -1
}

# Cached wrapper: `very_good --version` costs 0.5-5 s per session start (and
# falls back to a slow `pub global run` when the snapshot's SDK hash is stale).
# Result is cached per Dart SDK version + very_good executable mtime.
# Set VGV_CLI_CHECK_NO_CACHE=1 to bypass.
check_vgv_cli() {
  if ! command -v very_good >/dev/null 2>&1; then
    echo "not_installed"
    return
  fi
  if [[ "${VGV_CLI_CHECK_NO_CACHE:-}" == "1" ]]; then
    _check_vgv_cli_uncached
    return
  fi
  local vg_bin vg_mtime key cache_dir stamp cached result
  vg_bin="$(command -v very_good)"
  vg_mtime="$(stat -f %m "$vg_bin" 2>/dev/null || stat -c %Y "$vg_bin" 2>/dev/null || echo 0)"
  key="$(_vgv_dart_sdk_version)|$vg_bin|$vg_mtime|$MIN_VERSION"
  cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/vgv-ai-flutter-plugin"
  stamp="$cache_dir/vgv-cli-check"
  if [[ -f "$stamp" ]]; then
    cached="$(cat "$stamp" 2>/dev/null || true)"
    if [[ "${cached%%$'\n'*}" == "$key" ]]; then
      result="${cached#*$'\n'}"
      if [[ -n "$result" && "$result" != "$cached" ]]; then
        echo "$result"
        return
      fi
    fi
  fi
  result="$(_check_vgv_cli_uncached)"
  if [[ "$result" == "ok" ]]; then
    mkdir -p "$cache_dir" 2>/dev/null &&
      printf '%s\n%s\n' "$key" "$result" > "$stamp.$$" 2>/dev/null &&
      mv -f "$stamp.$$" "$stamp" 2>/dev/null || rm -f "$stamp.$$" 2>/dev/null
  fi
  echo "$result"
}

_check_vgv_cli_uncached() {
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

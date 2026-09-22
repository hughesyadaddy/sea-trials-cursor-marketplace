#!/usr/bin/env bash
# Assert that every `paths:` / `paths-ignore:` filter in every GitHub
# Actions workflow points at something that actually exists.
#
# Why: 23 per-package workflows in this repo declared filters like
# `packages/app_ui/**` while the code lives at `flutter/packages/app_ui`.
# A filter that matches nothing does not error — the workflow simply
# never triggers. They sat inert for months looking like coverage.
#
# This check is itself a success criterion, so it must fail loudly
# rather than silently matching nothing. It parses YAML instead of
# grepping so that quoted, unquoted, and inline-flow sequence forms are
# all handled identically.
#
# Ships in the sea-trials plugin, so the checkout under test is never
# derived from this file's own location: `ST_REPO_ROOT` wins, else the
# git toplevel of the current working directory.
set -euo pipefail

REPO_ROOT="${ST_REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "assert-workflow-paths: python3 is required but not installed." >&2
  exit 2
fi

python3 - "$REPO_ROOT" <<'PY'
import glob
import os
import re
import subprocess
import sys

try:
    import yaml
except ImportError:
    # Never degrade to "no findings" — an unusable parser is a hard
    # failure, not a pass.
    print(
        "assert-workflow-paths: PyYAML is required but not installed.",
        file=sys.stderr,
    )
    raise SystemExit(2)

repo_root = sys.argv[1]
GLOB_CHARS = set("*?[]+")

# Syntax this guard does not model. GitHub's filter language gives `?` and
# `+` quantifier meanings ("zero or one" / "one or more" of the *preceding*
# character) that differ from ordinary globbing, and bracket classes have
# their own edge cases. Rather than reimplement that grammar — three rounds
# of review found bugs in the attempt — a pattern using it falls back to the
# prefix check below.
#
# The trade is deliberate: this guard gates every PR, so a false rejection
# of a valid workflow costs more than missing an inert one. `*` and `**`
# cover every filter in this repository.
UNMODELLED_SYNTAX = set("?[+")

# Events whose filters name repository paths. `paths-ignore` is included
# because a stale ignore silently stops excluding what it names.
PATH_KEYS = ("paths", "paths-ignore")


def glob_to_regex(pattern):
    """Translate a GitHub Actions path filter into a regex.

    `**` crosses directory separators, `*` and `?` do not — matching the
    filter semantics GitHub documents for `paths:` / `paths-ignore:`.
    """
    out = []
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if pattern.startswith("**/", i):
            out.append("(?:.*/)?")
            i += 3
        elif pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif ch == "*":
            out.append("[^/]*")
            i += 1
        elif ch == "?":
            out.append("[^/]")
            i += 1
        elif ch == "[":
            # Bracket classes are valid filter syntax. `concrete_prefix`
            # already treats `[` as a metacharacter, so escaping it here
            # would make a legitimate `web/*.[jt]s` look inert and fail a
            # required check.
            #
            # A `]` immediately after `[` (or after its negation marker) is
            # a class *member*, not the terminator — `[]]` matches a literal
            # `]`. Scanning from i+1 would find that member, leave an empty
            # body, and emit the uncompilable `[]`.
            scan = i + 1
            if pattern[scan : scan + 1] in ("!", "^"):
                scan += 1
            if pattern[scan : scan + 1] == "]":
                scan += 1
            close = pattern.find("]", scan)
            if close == -1:
                out.append(re.escape(ch))
                i += 1
            else:
                body = pattern[i + 1 : close]
                negated = body[:1] in ("!", "^")
                if negated:
                    body = body[1:]
                out.append("[" + ("^" if negated else "") + body.replace("\\", "\\\\") + "]")
                i = close + 1
        else:
            out.append(re.escape(ch))
            i += 1
    return re.compile("^" + "".join(out) + "$")


def concrete_prefix(pattern):
    """Longest leading path that contains no glob metacharacter.

    'packages/app_ui/**'   -> ('packages/app_ui', True)
    '.github/workflows/x'  -> ('.github/workflows/x', False)
    '**/*.dart'            -> (None, True)   # nothing to verify
    """
    pattern = pattern.lstrip("!")
    parts = pattern.split("/")
    concrete = []
    globbed = False
    for part in parts:
        if GLOB_CHARS & set(part):
            globbed = True
            break
        concrete.append(part)
    if not concrete:
        return None, True
    return "/".join(concrete), globbed


def matches_any(pattern, tracked_paths, rel_workflow, event, key, failures):
    """Record a finding unless `pattern` matches at least one tracked path."""
    try:
        matcher = glob_to_regex(pattern.lstrip("!"))
    except re.error as exc:
        # Never let a malformed pattern abort the run: this guard gates
        # every PR, and a traceback is indistinguishable from a broken
        # check. Report it as a finding instead.
        failures.append(
            (rel_workflow, event, key, pattern, f"is not a valid filter ({exc})")
        )
        return False
    if any(matcher.match(path) for path in tracked_paths):
        return True
    failures.append(
        (
            rel_workflow,
            event,
            key,
            pattern,
            "matches no tracked file, so the workflow never triggers",
        )
    )
    return False


def iter_filters(doc):
    """Yield (event, key, pattern) for every path filter in a workflow."""
    # PyYAML is YAML 1.1, where the bare key `on` parses as boolean True.
    triggers = doc.get("on")
    if triggers is None:
        triggers = doc.get(True)
    if not isinstance(triggers, dict):
        return
    for event, cfg in triggers.items():
        if not isinstance(cfg, dict):
            continue
        for key in PATH_KEYS:
            patterns = cfg.get(key)
            if not patterns:
                continue
            if isinstance(patterns, str):
                patterns = [patterns]
            for pattern in patterns:
                yield event, key, str(pattern)


workflows = sorted(
    glob.glob(os.path.join(repo_root, ".github/workflows/*.yml"))
    + glob.glob(os.path.join(repo_root, ".github/workflows/*.yaml"))
)

if not workflows:
    print(
        "assert-workflow-paths: no workflow files found — "
        "refusing to report success.",
        file=sys.stderr,
    )
    raise SystemExit(2)

# Tracked paths only: untracked or ignored files cannot trigger a
# workflow, so matching against them would mask an inert filter.
tracked_paths = set(
    subprocess.run(
        ["git", "-C", repo_root, "ls-files"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
)
if not tracked_paths:
    print(
        "assert-workflow-paths: git ls-files returned nothing — "
        "refusing to report success.",
        file=sys.stderr,
    )
    raise SystemExit(2)

failures = []
checked = 0
# Patterns this guard cannot verify: unmodelled syntax with no concrete
# prefix to fall back on. Counting these as "checked" would overstate
# coverage, which is the failure mode a guard can least afford.
unverifiable = []

for path in workflows:
    rel_workflow = os.path.relpath(path, repo_root)
    with open(path) as handle:
        doc = yaml.safe_load(handle)
    if not isinstance(doc, dict):
        continue
    for event, key, pattern in iter_filters(doc):
        prefix, globbed = concrete_prefix(pattern)
        checked += 1
        bare = pattern.lstrip("!")
        if not globbed:
            # GitHub matches filters against changed *file* paths, so a
            # literal directory like `docs` never matches `docs/readme.md`
            # — the workflow is inert even though the directory exists.
            if bare not in tracked_paths:
                failures.append(
                    (
                        rel_workflow,
                        event,
                        key,
                        pattern,
                        "is a literal path matching no tracked file "
                        "(GitHub matches file paths, not directories)",
                    )
                )
            continue
        if UNMODELLED_SYNTAX & set(bare):
            # Prefix-only: see UNMODELLED_SYNTAX above.
            if prefix is None:
                # A leading wildcard leaves no prefix either, so there is
                # nothing this guard can assert. Do not count it as checked.
                checked -= 1
                unverifiable.append((rel_workflow, event, key, pattern))
                continue
            if not os.path.isdir(os.path.join(repo_root, prefix)):
                failures.append(
                    (rel_workflow, event, key, pattern, f"'{prefix}' does not exist")
                )
            continue
        if prefix is None:
            # Leading wildcard (e.g. '**/*.dart'): no concrete directory to
            # check, but the pattern can still be matched against tracked
            # paths — and must be, or '**/*.nope' would be exempt from the
            # only check this guard performs.
            matches_any(
                pattern, tracked_paths, rel_workflow, event, key, failures
            )
            continue
        target = os.path.join(repo_root, prefix)
        # A globbed pattern needs its concrete prefix to exist AND to
        # actually match something. Checking only the prefix would let
        # `packages/real/**/*.nope` pass while the workflow stays inert —
        # exactly the bug class this guard exists to catch.
        if not os.path.isdir(target):
            failures.append(
                (rel_workflow, event, key, pattern, f"'{prefix}' does not exist")
            )
            continue
        matches_any(pattern, tracked_paths, rel_workflow, event, key, failures)

for rel_workflow, event, key, pattern, reason in failures:
    print(
        f"{rel_workflow}: on.{event}.{key} references '{pattern}' — {reason}",
        file=sys.stderr,
    )

for rel_workflow, event, key, pattern in unverifiable:
    print(
        f"{rel_workflow}: on.{event}.{key} '{pattern}' uses syntax this "
        "guard does not model and has no concrete prefix — NOT VERIFIED.",
        file=sys.stderr,
    )

summary = (
    f"assert-workflow-paths: checked {checked} filter(s) across "
    f"{len(workflows)} workflow(s); {len(failures)} broken."
)
if unverifiable:
    summary += f" {len(unverifiable)} not verifiable (see above)."
print(summary)

raise SystemExit(1 if failures else 0)
PY

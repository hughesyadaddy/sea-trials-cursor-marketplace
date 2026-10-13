#!/usr/bin/env python3
"""Validate codemagic.yaml and Apple App Attest entitlements.

Runs with cwd = app repo root (REPO_ROOT or process cwd).
"""
import glob
import os
import plistlib
import re
import sys

import yaml

ROOT = os.environ.get("REPO_ROOT", os.getcwd())
errors = []
KEY = "com.apple.developer.devicecheck.appattest-environment"

TRIGGER_SCRIPT_GLOB = "code_magic_whitelabel_builder/build/*.sh"
REQUIRED_WORKFLOWS = {"update_specific_whitelabel_apps"}
WF_TOKENS = [
    re.compile(r'"((?:ios|android|web|windows)-whitelabel[a-z0-9-]*'
               r'|whitelabel-macos[a-z0-9-]*|whitelabel_[a-z0-9_-]+)"'),
    re.compile(r'\btrigger_(?:workflow|build)\s+"([A-Za-z0-9_-]+)"'),
    re.compile(r'\\?"workflowId\\?"\s*:\s*\\?"([A-Za-z0-9_-]+)\\?"'),
]


class Loader(yaml.SafeLoader):
    pass


def check_codemagic():
    path = os.path.join(ROOT, "codemagic.yaml")
    try:
        with open(path) as f:
            doc = yaml.load(f, Loader=Loader)
    except Exception as e:  # noqa: BLE001
        errors.append(f"codemagic.yaml: YAML parse failed: {e}")
        return
    wfs = (doc or {}).get("workflows")
    if not isinstance(wfs, dict) or not wfs:
        errors.append("codemagic.yaml: missing `workflows` mapping")
        return
    names = set(wfs)
    for wid, body in wfs.items():
        if not isinstance(body, dict) or "scripts" not in body and "publishing" not in body:
            errors.append(f"codemagic.yaml: workflow {wid} has no scripts")
    for r in REQUIRED_WORKFLOWS:
        if r not in names:
            errors.append(f"codemagic.yaml: required workflow {r} missing")
    referenced = set()
    scripts = sorted(glob.glob(os.path.join(ROOT, TRIGGER_SCRIPT_GLOB)))
    if not scripts:
        errors.append(f"{TRIGGER_SCRIPT_GLOB}: no trigger scripts found")
    for s in scripts:
        text = open(s).read()
        for rx in WF_TOKENS:
            referenced |= set(rx.findall(text))
    if not referenced:
        errors.append("no whitelabel workflow ids found in trigger scripts (regex drift?)")
    for w in sorted(referenced - names):
        errors.append(f"codemagic.yaml: workflow `{w}` dispatched by whitelabel "
                      f"trigger scripts does not exist")
    print(f"codemagic.yaml: {len(names)} workflows; {len(referenced)} "
          f"dispatched ids verified")


def expected_env(path):
    base = os.path.basename(path)
    if base in ("Runner.entitlements", "DebugProfile.entitlements"):
        return "development", False
    if "staging" in base.lower():
        return None, True
    if "Release" in base:
        return "production", False
    return None, True


def check_entitlements():
    files = sorted(
        f for f in glob.glob(os.path.join(ROOT, "flutter/apps/*/*/Runner/*.entitlements"))
        if "/ios/" in f or "/macos/" in f)
    if not files:
        errors.append("no entitlements files found")
    for f in files:
        try:
            with open(f, "rb") as fh:
                pl = plistlib.load(fh)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{f}: invalid plist: {e}")
            continue
        want, optional = expected_env(f)
        got = pl.get(KEY)
        if "staging" in os.path.basename(f).lower():
            if got is not None:
                errors.append(f"{f}: staging must not declare {KEY} (got {got!r})")
        elif want is None:
            errors.append(f"{f}: unrecognised entitlements file name; classify it in "
                          f"config_entitlements_lint.py")
        elif got is None:
            if not optional:
                errors.append(f"{f}: missing {KEY} (expected {want})")
        elif got != want:
            errors.append(f"{f}: {KEY}={got!r}, expected {want!r}")
        print(f"{f}: {got or '(absent)'}")
    for proj in sorted(glob.glob(os.path.join(ROOT, "flutter/apps/*/*/Runner.xcodeproj/project.pbxproj"))):
        platform_dir = os.path.dirname(os.path.dirname(proj))
        text = open(proj).read()
        refs = set(m.strip('"') for m in re.findall(
            r'CODE_SIGN_ENTITLEMENTS = ("?[^;]+"?);', text))
        on_disk = {os.path.relpath(f, platform_dir) for f in files
                   if f.startswith(platform_dir + "/")}
        for r in sorted(refs):
            if not os.path.exists(os.path.join(platform_dir, r)):
                errors.append(f"{proj}: CODE_SIGN_ENTITLEMENTS {r} does not exist")
        for f in sorted(on_disk - refs):
            errors.append(f"{proj}: {f} is not referenced by any build configuration")
        configs = re.findall(
            r"buildSettings = \{(.*?)\n\t\t\t\};\n\t\t\tname = \"?([^;\"]+)\"?;", text, re.S)
        for settings, name in configs:
            m = re.search(r'CODE_SIGN_ENTITLEMENTS = "?([^;"]+)"?;', settings)
            if not m:
                continue
            ent = os.path.join(platform_dir, m.group(1))
            want, _ = expected_env(ent)
            if name.lower().startswith("debug") and want != "development":
                errors.append(f"{proj}: Debug config `{name}` uses {m.group(1)} "
                              f"(not a development entitlements file)")
            if "/ios/" in proj and "staging" in name.lower() \
                    and not name.lower().startswith("debug") \
                    and "staging" not in os.path.basename(ent).lower():
                errors.append(f"{proj}: `{name}` must use a staging entitlements file "
                              f"without App Attest, not {m.group(1)}")
            if name.lower().startswith("release") and want == "development":
                errors.append(f"{proj}: Release config `{name}` uses development "
                              f"entitlements {m.group(1)}")


def run_self_test():
    """Lightweight checks that do not need the app repo checkout."""
    dev, opt = expected_env("Runner/DebugProfile.entitlements")
    assert dev == "development" and not opt
    dev, opt = expected_env("Runner/Release.entitlements")
    assert dev == "production" and not opt
    dev, opt = expected_env("Runner/Runner-staging.entitlements")
    assert dev is None and opt
    print("config-entitlements-lint self-test: OK")
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--self-test":
        return run_self_test()
    os.chdir(ROOT)
    check_codemagic()
    check_entitlements()
    if errors:
        for e in errors:
            print(f"::error::{e}")
        return 1
    print("config-entitlements-lint: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())

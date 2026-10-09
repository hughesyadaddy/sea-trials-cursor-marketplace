# Adversarial simplicity review — Sea Trials plugin (agnostic scope)

**Date:** 2026-10-09  
**Scope:** `sea-trials-cursor-marketplace/plugins/sea-trials` — all 19 `st-*` skills, `skills/_sources` + `sync-skill-sources.mjs`, plugin-root bootstrap paths, `scripts/st-run.mjs` dispatch surface.  
**Reviewer lens:** YAGNI, minimal moving parts for “any repo, marketplace-only install.”

---

## Simplification Analysis

### Core Purpose

Ship one Team Marketplace plugin that lets any git checkout run Sea Trials workflows (sprint cards → Jira, PR review loops, push gates) **without vendoring scripts**, by resolving `ST_PLUGIN_ROOT` and invoking shared Node hooks under `scripts/`.

### Unnecessary Complexity Found

| Area | Evidence | Why unnecessary | Simpler direction |
| --- | --- | --- | --- |
| **Bootstrap copy-paste** | Identical ~10-line `ST_PLUGIN_ROOT` bash block in **6** sprint skills (`st-sprint-plan`, `refine`, `upload`, `retro`, `jira-board-vet`, `jira-test-review`) plus §11 in `_sources/sprint-contract.md` and bootstrap in `_sources/review-loop-contract.md` (**21** markdown files total export the env chain) | Same logic maintained in many prompts; agents omit it → `$SPRINT` undefined | One line: `eval "$(node "$ST_PLUGIN_ROOT/scripts/st-run.mjs" print-plugin-root 2>/dev/null)"` **or** a tiny `scripts/bootstrap-st-env.sh` shipped once; skills say “run bootstrap script” only |
| **Dual entry for sprint lint** | Contract §11 mandates `st-run sprint-lint`; Phase 0 in `st-sprint-refine` / `st-sprint-plan` call `node "$SPRINT/parse-sprint-folder.mjs" …` directly | Two mental models; bypasses `sprint-lint.mjs`’s `--changed` and resolver | Always `st-run sprint-lint -- <folder>`; drop `$SPRINT=` from skills |
| **Plugin root resolution stack** | `resolve-st-plugin-root.mjs` (~270 LOC), `print-st-plugin-root.mjs`, marker `resolve-plugin-root.mjs`, `st-run` `print-plugin-root`, **and** `st-run` main path uses `import.meta` sibling of `scripts/` (not `resolveStPluginRoot`) | Four ways to answer “where is the plugin?”; `st-run` from a stale cache checkout can disagree with `sprint-lint` | `st-run` sets `ST_PLUGIN_ROOT` via **one** `resolveStPluginRoot()`; delete or alias `print-plugin-root` to print script only |
| **`find … \| head -1` on bootstrap** | Still used to locate `print-st-plugin-root.mjs` in skills + contracts (`st-sprint-plan/SKILL.md:59-61`, `review-loop-contract.md`) | Nondeterministic when multiple cache SHAs exist | Document only: `node "$(dirname "$(which …)")"` — or env-only bootstrap; **never** scan caches in skill bodies |
| **`CURSOR_AGNOSTIC_INSTALL.md` drift** | Lines 39–44 still show `find … print-st-plugin-root.mjs \| head -1` as the primary agent bootstrap while §11 says not to `head -1` plugin roots | Contradictory onboarding | Single snippet matching contract §11; link to contract instead of duplicating |
| **`_sources` fan-out weight** | **5** sources (~61 KB) → **23** generated copies (~344 KB total under `references/shared/`) | Host limitation forces copies, but **~82%** of shared markdown bytes are duplicates in git/CI | Keep sync (required); reduce **source** size: move Jira ADF field tables / dispatch tables out of `sprint-contract.md` into skill-local `references/` once |
| **Substring sync trigger** | `sync-skill-sources.mjs` uses `text.includes('shared/${name}')` | Accidental mentions in `_sources` cross-links (`sprint-dev-voice` inside `sprint-contract.md`) inflate link graph noise | Optional explicit manifest per skill (`skill-sources.json`) — already noted in architecture review |
| **`CURSOR_VGV_PORT` block** | **19/19** `SKILL.md` files repeat the same ~12-line dual-host block | ~230 LOC of identical prose in every skill | One plugin-level rule (already in VGV marketplace); trim to 1-line pointer in skills or generate at publish |
| **`st-run` as universal loader** | Any string maps to `scripts/hooks/<name>`, `scripts/ci/<name>`, or `scripts/sprint/<name>` — **32** hook stems, **32** CI `.mjs`, **~18** sprint scripts | Unbounded public API; no allowlist; typos run wrong script or fail late | Document **supported** subcommands in README table; optional strict mode for CI |
| **Direct hook paths in contract** | `review-loop-contract.md` defines **10+** `$ST_*` paths to `scripts/hooks/*.mjs` | Bypasses `st-run`; duplicates path logic agents must paste | `$ST_RUN='node "$ST_PLUGIN_ROOT/scripts/st-run.mjs"'` + named subcommands only (`pr-review-push`, `st-parallel-tasks`, …) |
| **Review-loop skill pair** | `st-pr-review-loop-inplace` (133 LOC) + `worktree` (144 LOC) share preface + “when to use” table | Justified for safety modes; still **duplicate** routing table in both | Extract 15-line “mode picker” into `_sources/review-loop-mode-picker.md` (one sync copy linked from both) |
| **Meta / repo-specific skills in “agnostic” plugin** | `st-sea-trials-lint`, `st-e2e-checkpoint`, `st-powersync-triage` assume Flutter monorepo paths (`pnpm agent-e2e-fast`, PowerSync) | Expands plugin scope beyond sprint/Jira/PR for all consumers | Move to `vgv-ai-flutter-plugin` or a `sea-trials-flutter` optional plugin slice |
| **Thin orchestration skills** | `st-vgv-chain` (74 LOC) re-lists Wingspan handoffs already in each skill | Duplicates marketplace `/brainstorm` → `/plan` docs | README “recommended chain” or one doc; skill optional |
| **`repoRoot()` twin** | Identical helper in `st-run.mjs` and `sprint-lint.mjs` | Copy-paste drift | Export `repoRoot()` from `scripts/lib/git-repo-root.mjs` |

### Code to Remove (or stop duplicating)

| Location | Reason | Est. LOC / bytes |
| --- | --- | --- |
| 19 × `CURSOR_VGV_PORT` blocks in `skills/st-*/SKILL.md` | Plugin rules already enforce | ~220 LOC |
| 6 × Phase 0 bash bootstrap in sprint skills | Replace with one bootstrap script reference | ~60 LOC |
| `$SPRINT=` + direct `parse-sprint-folder.mjs` in skills | Prefer `st-run sprint-lint` / `st-run` wrapper for JSON | ~12 LOC + agent confusion |
| `docs/CURSOR_AGNOSTIC_INSTALL.md` duplicate bootstrap | Link to contract §11 | ~15 LOC |
| Optional: `st-vgv-chain` skill | YAGNI if README chain suffices | 74 LOC skill |
| Generated shared copies (not removable) | Required for hosts — **do not delete**; shrink sources instead | ~280 KB duplicate **content** (not files) |

### Simplification Recommendations

1. **Single bootstrap artifact (highest impact)**  
   - **Current:** 21 markdown copies of env resolution + `find \| head -1` for print script.  
   - **Proposed:** `scripts/bootstrap-st-env.sh` (or `st-run env-export`) sourced once; skills/agents: “Source bootstrap; never inline.”  
   - **Impact:** ~80 LOC removed from prompts; fewer subagent failures.

2. **Unify on `st-run` for all script entry**  
   - **Current:** Sprint skills use `$SPRINT/parse-sprint-folder.mjs`; review loop uses `$ST_REVIEW=…/hooks/…`.  
   - **Proposed:** Contract documents only `st-run <subcommand>`; add thin aliases if needed (`st-run parse-sprint -- …`).  
   - **Impact:** One dispatch mental model; `st-run.sprint-lint.test.mjs` pattern extends to other subcommands.

3. **Fix `st-run` root to use resolver**  
   - **Current:** `pluginRoot` from `import.meta` next to `st-run.mjs`.  
   - **Proposed:** `const pluginRoot = resolveStPluginRoot({ selfRoot: … })` when not already set.  
   - **Impact:** Agnostic installs behave when multiple cache versions exist.

4. **Shrink `_sources` before fan-out**  
   - **Current:** `sprint-contract.md` ~20k chars × 5 skills ≈ 100k in copies alone.  
   - **Proposed:** Split “authoring shape” (§1–9) for authors/critics from “Jira upload ops” (§10) linked only from `st-jira-upload`.  
   - **Impact:** ~30–40% less synced markdown in sprint skills that never upload.

5. **Narrow documented `st-run` surface**  
   - **Current:** README lists capabilities; any hook name works.  
   - **Proposed:** README table of **supported** subcommands (sprint-lint, pr-review-push, pr-review-loop, ci/run-lane, …); internal hooks stay implementation details.  
   - **Impact:** Lower agent hallucination of hook names.

6. **Extract shared dual-host snippet at publish**  
   - **Current:** 19 identical blocks.  
   - **Proposed:** `skills/_sources/dual-host-port.md` synced only to skills that need handoffs (not `st-e2e-checkpoint`).  
   - **Impact:** ~150 LOC if trimmed to skills with AskQuestion handoffs only.

### YAGNI Violations

| Item | Violation | Instead |
| --- | --- | --- |
| **`st-vgv-chain`** | Composes skills that already expose handoffs | Doc + user runs `/plan` then `/st-pre-push-harden` |
| **Flutter-only skills in core plugin** | `st-sea-trials-lint`, `st-e2e-checkpoint` | Flutter marketplace plugin or repo-local runbook |
| **10+ `$ST_*` hook variables** | Future hooks multiply aliases | `st-run <name>` only |
| **Explicit `$SPRINT` in agent prompts** | Parallel script namespace | `st-run` + parser subcommand |
| **Full `sprint-contract.md` in every sprint skill context** | Upload/Jira §10 loaded for plan/refine | Split contract; sync smaller shard |

### Per-skill notes (19 `st-*`)

| Skill | LOC | Verdict |
| --- | ---: | --- |
| `st-sprint-plan` | 238 | Keep; trim Phase 0 bootstrap + use `st-run sprint-lint` |
| `st-sprint-refine` | 178 | Keep; same |
| `st-jira-upload` | 293 | Keep; largest justified (cadence + MCP); split contract read list |
| `st-jira-board-vet` | 170 | Keep; overlaps test-review — share one “hygiene” checklist ref |
| `st-jira-test-review` | 210 | Keep |
| `st-sprint-retro` | 175 | Keep |
| `st-pre-push-harden` | 256 | Keep; core gate |
| `st-build-with-subagents` | 217 | Keep |
| `st-flake-quarantine` | 193 | Keep |
| `st-pr-review-loop-inplace` | 133 | Keep (mode split) |
| `st-pr-review-loop-worktree` | 144 | Keep |
| `st-pr-review-monitor` | 132 | Keep |
| `st-pr-promote` | 120 | Keep |
| `st-pr-ship` | 85 | Keep |
| `st-jira-to-pr-loop` | 78 | Keep (thin glue OK) |
| `st-vgv-chain` | 74 | **Candidate remove** → README |
| `st-powersync-triage` | 65 | **Candidate move** out of agnostic core |
| `st-sea-trials-lint` | 65 | **Candidate move** to Flutter plugin |
| `st-e2e-checkpoint` | 62 | **Candidate move** to Flutter plugin |

### `_sources` sync assessment

- **Mechanism:** Sound — link-driven fan-out + CI `--check` is the minimal fix for host-relative `references/`.
- **Cost:** 23 files, ~344 KB duplicated content for ~61 KB canonical (acceptable if sources shrink).
- **Risk:** Cross-references inside `_sources/*.md` do not affect copy set (only skill-owned markdown scanned) — good.
- **Improvement:** Manifest-based sync is optional complexity unless substring false positives appear in production.

### `st-run` surface area (inventory)

| Bucket | Count | Notes |
| --- | ---: | --- |
| `scripts/hooks/*` (incl. `.test`) | 32 | Includes `lib/` as subdir — effective **~28** invocable hooks |
| `scripts/ci/*.mjs` | 32 | Via `ci/<name>` prefix |
| `scripts/sprint/*.mjs` | 18 | Via bare name (e.g. `sprint-lint`) |
| Documented in README/skills | ~8 | `sprint-lint`, `pr-review-push`, `pr-review-loop`, `st-gate-stats`, `st-model-probe`, `st-build-shard-tasks`, `ci/run-lane`, … |

**Gap:** Skills teach **direct** hook paths ~15 files vs **25** `st-run` mentions (mostly `sprint-lint` inside duplicated contract copies).

### Bootstrap duplication map

```
resolve-st-plugin-root.mjs  ← canonical (newest cache)
print-st-plugin-root.mjs    ← thin wrapper
resolve-plugin-root.mjs     ← marker file only
st-run.mjs                  ← import.meta root (should use resolver)
sprint-lint.mjs             ← uses resolveStPluginRoot ✓
skill Phase 0 bash          ← find print script | head -1 (×6 skills)
contract §11                ← same bash
review-loop-contract        ← same bash + ST_* hook paths
CURSOR_AGNOSTIC_INSTALL     ← outdated find example
```

### Final Assessment

| Metric | Value |
| --- | --- |
| **Total potential LOC reduction (prompts/skills/docs)** | ~15–20% of skill markdown (~450–550 LOC) without losing behavior |
| **Duplicate shared markdown bytes** | ~280 KB (fix by splitting contracts, not removing sync) |
| **Complexity score** | **Medium–High** (dispatch + bootstrap + fan-out — each justified alone, together heavy) |
| **Recommended action** | **Proceed with simplifications** in this order: (1) unified bootstrap, (2) `st-run`-only entry in skills/contracts, (3) `st-run` uses resolver, (4) split `sprint-contract.md`, (5) relocate Flutter-only skills, (6) trim `CURSOR_VGV_PORT` duplication |

---

## Structured findings (for parent agent)

See return block in chat — ids assigned by caller.

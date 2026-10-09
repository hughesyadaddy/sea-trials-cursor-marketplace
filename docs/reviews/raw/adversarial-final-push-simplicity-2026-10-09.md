# Adversarial simplicity review — final push 2026.10.09.4–5

**Date:** 2026-10-09  
**Scope:** Commits `8907d95` (agnostic install / bootstrap unification), `c2c12b7` + `e6bb43f` (in-chat PR monitor), on `sea-trials-cursor-marketplace` `plugins/sea-trials`.  
**Lens:** YAGNI, minimal moving parts, net complexity delta vs stated goals (bootstrap dedup, monitor clarity, `_sources` sync).

---

## Simplification Analysis

### Core Purpose

Ship marketplace-only Sea Trials so any git checkout resolves `ST_PLUGIN_ROOT` once, runs hooks via `st-run`, and keeps PR review loops awake in Cursor Agent chat—without vendoring scripts or duplicating prose across 19 skills.

### What the push actually did

| Change | Intent | Net simplicity |
| --- | --- | --- |
| `resolve-st-plugin-root.mjs` + `CURSOR_PLUGIN_ROOT` | Single Node resolver | **Good** — one algorithm (~270 LOC) beats ad-hoc cache paths |
| `bootstrap-st-env.sh` + `print-st-plugin-root.mjs` | One shell bootstrap | **Incomplete** — script exists but skills/contracts never reference it |
| Replace `find \| head -1` on plugin **roots** | Deterministic install | **Partial** — still **20** markdown files use `find … print-st-plugin-root.mjs \| head -1` |
| `cursor-in-chat-monitor.md` + skill updates | Wake Codex in chat | **Mixed** — fixes real bug; adds **6th** sync source and **triple** monitor prose |
| Drop `review-loop-contract.md` from `st-pr-review-monitor` | Shrink monitor context | **Broken** — skill + synced body still tell agents to read missing file |

`node scripts/sync-skill-sources.mjs --check` → **25 copies up to date (6 source(s))** (~336 KB under `references/shared/`).

---

### Unnecessary Complexity Found

#### 1. Bootstrap duplication (2026.10.09.4 — goal not met)

| Evidence | Why unnecessary | Simpler alternative |
| --- | --- | --- |
| `plugins/sea-trials/scripts/bootstrap-st-env.sh` (18 LOC) | Canonical bootstrap shipped but **zero** skill/README references (`rg bootstrap-st-env` → script only) | Skills Phase 0: `source "$ST_PLUGIN_ROOT/scripts/bootstrap-st-env.sh"` after env injection, or document one `node …/print-st-plugin-root.mjs` line |
| Same ~12-line bash block in **6** sprint `SKILL.md` files (`st-sprint-plan`, `refine`, `upload`, `retro`, `jira-board-vet`, `jira-test-review`) | Duplicates `_sources/sprint-contract.md` §11 and each other | Delete inline blocks; point to contract §11 or bootstrap script only |
| `_sources/sprint-contract.md` + `_sources/review-loop-contract.md` § bootstrap | Fan-out to **5 + 8** generated copies via sync | Single `_sources/plugin-bootstrap.md` synced only to skills that need shell env (not full contract) |
| `bootstrap-st-env.sh:8-16` still uses `find … \| head -1` | Same nondeterminism the contract warns about for roots (now on **script path**) | Require `CURSOR_PLUGIN_ROOT` / `ST_PLUGIN_ROOT` in Agent; fallback `node` with fixed relative path from marketplace doc, or invoke resolver via `st-run` subcommand |
| `docs/CURSOR_AGNOSTIC_INSTALL.md:41-44` vs `:69` | Primary snippet is `find \| head -1`; anti-pattern forbids `find` on plugin roots | One snippet: env chain + `node "$(…/print-st-plugin-root.mjs)"` with explicit install instruction, not cache walk |

**Estimated duplicate bootstrap prose:** ~80 LOC in skills + ~30 LOC × 13 contract copies ≈ **470 LOC-equivalent** in repo (mostly generated).

#### 2. Monitor docs (2026.10.09.5 — over-documented)

| Layer | Lines (approx.) | Overlap |
| --- | --- | --- |
| `_sources/cursor-in-chat-monitor.md` | 96 | Canonical Cursor Shell + Await protocol |
| `_sources/review-loop-monitor.md` | 161 | Repeats Option B (lines 31–51): same daemon command, `block_until_ms: 0`, stop detached daemon |
| `st-pr-review-monitor/SKILL.md` | 145 | **Inlines** Phase 1–2 again (daemon cmd, flags, Await loop) |
| Loop skills read **4** shared files | inplace/worktree | Correct for safety; monitor-specific file adds 4th when monitor section could be one link |

Commit `c2c12b7` added **~791 insertions** for monitor behavior—mostly duplicated instructions, not new executable logic.

**Simpler shape:**

- `review-loop-monitor.md` — host-agnostic daemon/sentinels only; one line: “Cursor: mandatory steps in `cursor-in-chat-monitor.md`.”
- `st-pr-review-monitor/SKILL.md` — PR resolution + read-order only; **no** repeated bash blocks (delegate to shared).
- Loop skills — read monitor shared file once; drop redundant “Phase 1” echoes in SKILL bodies if body Step 1 covers it.

#### 3. `sync-skill-sources` copies

| Issue | Detail |
| --- | --- |
| **New source weight** | `cursor-in-chat-monitor.md` (~3.9 KB) × **3** skills (monitor, inplace, worktree) = ~12 KB new duplicate bytes in git |
| **Orphan policy worked** | Removing `review-loop-contract` from monitor skill (no `shared/review-loop-contract` link) deleted 461-line copy — **good** for context budget |
| **Broken link graph** | `st-pr-review-monitor/SKILL.md:54` → `review-loop-contract.md` (not shipped). Synced `review-loop-body.md` still says “Read `shared/review-loop-contract.md` first” — agents follow a dead reference |
| **Substring linker** | `referencedSources()` via `includes('shared/${name}')` — cannot express “link monitor doc without duplicating in monitor.md”; forces full-file copies for host limitation (acceptable) but encourages **splitting** sources instead of **layering** (monitor + cursor doc overlap) |
| **6 sources / 25 copies** | ~66 KB sources → ~336 KB copies (~**5×** fan-out). Required by dual-host; **not** removable—但 overlap between sources inflates copies unnecessarily |

---

### Code to Remove (or stop duplicating)

| Location | Action | Est. impact |
| --- | --- | --- |
| 6 × sprint `SKILL.md` bootstrap blocks | Replace with pointer to `bootstrap-st-env.sh` or contract §11 | ~72 LOC |
| `review-loop-monitor.md` Cursor Option B section | Trim to link `cursor-in-chat-monitor.md` | ~25 LOC × 4 copies ≈ 100 LOC in tree |
| `st-pr-review-monitor/SKILL.md` Phase 1–2 daemon/Await | Keep read-order + autonomy; drop duplicated bash | ~50 LOC |
| `CURSOR_AGNOSTIC_INSTALL.md:41-44` | Align with contract; link bootstrap script | ~8 LOC |
| Fix monitor skill | Re-add `shared/review-loop-contract.md` link **or** remove references + add minimal `$ST_PLUGIN_ROOT` block in SKILL | 1 file or ~10 LOC |

---

### Simplification Recommendations (priority)

1. **Wire `bootstrap-st-env.sh` or delete it**  
   - **Current:** Script + 20× inline/find bootstrap.  
   - **Proposed:** Document exactly one bootstrap path; skills say “source bootstrap script” once.  
   - **Impact:** Largest reduction in agent paste errors; matches 2026.10.09.4 commit message.

2. **Collapse monitor documentation to two layers**  
   - **Current:** Three layers with repeated daemon invocation.  
   - **Proposed:** `cursor-in-chat-monitor.md` (Cursor-only) + slim `review-loop-monitor.md` (sentinels + Claude detached path). Monitor SKILL = orchestration only.  
   - **Impact:** ~150–200 LOC less prose; smaller synced copies.

3. **Fix `st-pr-review-monitor` contract reference**  
   - **Current:** Dropped generated copy; SKILL/body still require contract.  
   - **Proposed:** Either sync `review-loop-contract.md` back (link in SKILL) or inline 5-line `$ST_PLUGIN_ROOT` + `$ST_REVIEW_*` in monitor SKILL and patch `_sources/review-loop-body.md` opener for monitor-only path.  
   - **Impact:** Restores single read graph; avoids agent hallucinating paths.

4. **De-duplicate bootstrap in `_sources` only**  
   - Extract `plugin-bootstrap.md`; sprint/review contracts `@` link `shared/plugin-bootstrap.md` instead of embedding bash in both 20k-char contracts.  
   - **Impact:** Smaller contract fan-out (~15 LOC × N copies saved).

---

### YAGNI Violations

| Item | Violation | Instead |
| --- | --- | --- |
| `bootstrap-st-env.sh` without adoption | Built artifact nothing calls | Reference from all skills or remove |
| Third monitor doc layer in SKILL | `st-pr-review-monitor` repeats shared files | Read-order + loop delegation only |
| `find \| head -1` for print script | Still 20 files + bootstrap script | Env-first; document manual `ST_PLUGIN_ROOT` for cloud agents |
| 791-line doc commit for monitor | No hook/daemon code change in same commit | Doc-only follow-up could merge overlapping sections before sync |

---

### Final Assessment

| Metric | Value |
| --- | --- |
| **Total potential LOC reduction (docs/prompts)** | ~25–35% of monitor+bootstrap prose added/churned in .4–.5 |
| **Complexity score** | **High** (resolver good; doc/sync graph worse) |
| **Recommended action** | **Do not treat .4–.5 as simplicity-complete** — finish bootstrap wiring, dedupe monitor layers, fix monitor contract link, then re-run `sync-skill-sources.mjs` |

---

## Verdict

**FAIL** — Resolver and orphan-aware sync are solid, but the push **increased** duplicated bootstrap text (new script unused), **triplicated** in-chat monitor instructions, and left **broken** `review-loop-contract` references on `st-pr-review-monitor`.

### Top 3 issues

1. **Bootstrap unification incomplete** — `bootstrap-st-env.sh` is unused; six sprint skills and two `_sources` contracts still paste the same `find … print-st-plugin-root.mjs \| head -1` block (~20 files); install doc contradicts itself (`CURSOR_AGNOSTIC_INSTALL.md`).

2. **Monitor documentation triplication** — `cursor-in-chat-monitor.md`, overlapping section in `review-loop-monitor.md`, and inline Phases in `st-pr-review-monitor/SKILL.md` repeat the same Shell/Await/daemon commands (~791 LOC churn in .5 with minimal dedup).

3. **Sync graph regression on monitor skill** — Dropping `review-loop-contract.md` copy without updating references (`st-pr-review-monitor/SKILL.md:54`, `review-loop-body.md` opener); new 6th source adds ~12 KB duplicate copies without merging overlap into one monitor source.

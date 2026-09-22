/**
 * Shared Flutter check planner.
 *
 * Builds the `dart format` / `dart analyze` / `sea-trials-lint` task list
 * from a set of changed files. Pure: no process exit, no lockfile, no
 * binary installation, no git or CI concepts. Callers own those.
 *
 * This exists because the same changed-file -> owning-package -> batched
 * command logic was implemented three times (the pre-push hook, the agent
 * validate script, and 393 lines of inline bash in pr-checks.yml), with
 * only the first two sharing tested helpers. The bash copy was the least
 * precise and drifted furthest.
 *
 * Deliberately NOT handled here: the web, functions and migration domains
 * (pre-push only). `dart analyze` tasks carry a default concurrency
 * weight (`analyzeWeight()`) so a few analyzers run side by side without
 * saturating the machine; callers may override it.
 *
 * All filesystem access is injected so this stays unit-testable, mirroring
 * `resolve-base-ref.mjs`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  buildMergedAnalyzeChunks,
  chunk,
  findNearestPubspecYaml,
  getAllFlutterPackageDirs,
  isDartAnalyzeRelevant,
  needsFullFlutterPackageAnalyze,
} from './flutter-packages.mjs';
import { isGeneratedDartPath, isLintableDartPath } from './artifact-paths.mjs';

/**
 * Cap any single `dart analyze` so a stuck analysis_server cannot freeze
 * the gate forever (observed: full-package question_card idle at ~0% CPU
 * for 10-18 min while the IDE analyzer also ran). 8 min, not 5: a
 * legitimate cold-cache user_repository analyze runs ~5 min alongside the
 * IDE analyzer (observed 2026-07-15, twice) and was falsely killed at the
 * old cap; true hangs idle past 10 min.
 */
export const DART_ANALYZE_TIMEOUT_MS = 8 * 60 * 1000;

/** Batch size for path-taking commands. */
const DART_BATCH = 50;

/**
 * Task granularity. `coarse` (default) minimises process spawns for a
 * single machine running the gate in-process. `fine` emits many small
 * tasks so a subagent fan-out (`--list-tasks`) can hand every failure to
 * a worker that owns a handful of files: format/lint batches of 10 and
 * one `dart analyze` per package instead of merged cross-package chunks.
 */
export const GRANULARITY = { COARSE: 'coarse', FINE: 'fine' };

const FINE_DART_BATCH = 10;

/**
 * Concurrency weight for `dart analyze`. Each analysis server is
 * multi-threaded and uses 0.5–2 GB, so a weight of 1 lets a 10-core
 * machine spawn 10 servers and freeze the desktop, while a weight equal
 * to the core count serialises them (the old pre-push behaviour: one
 * analyzer at a time, ~8 min on multi-package diffs). Middle ground:
 * roughly a quarter of the cores per analyzer, never fewer than 3 units,
 * so 8 cores → 2 concurrent, 10 → 3, 20 → 4.
 *
 * @param {number} [cpuCount]
 */
export function analyzeWeight(cpuCount = os.cpus().length) {
  return Math.max(3, Math.ceil(Math.max(cpuCount, 1) / 4));
}

/** Promotion PR targets whose analyze lane must stay bounded. */
const PROMOTION_BASE_REFS = new Set(['stg', 'main']);

/**
 * True when a PR targets a release trunk (`stg` or `main`).
 *
 * Accepts `origin/stg`-style refs from `--base` and bare branch names
 * from `GITHUB_BASE_REF`.
 *
 * @param {string} baseRef
 */
export function isPromotionBaseRef(baseRef) {
  const ref = (baseRef ?? '').trim().replace(/^origin\//, '');
  return PROMOTION_BASE_REFS.has(ref);
}

/**
 * Resolve the promotion base from CI env or an explicit `--base` ref.
 *
 * @param {{base?: string, env?: NodeJS.ProcessEnv}} opts
 * @returns {string | null} bare branch name, or null when not a promotion PR
 */
export function resolvePromotionBaseRef({ base, env = process.env }) {
  if (base) {
    if (isPromotionBaseRef(base)) {
      return base.trim().replace(/^origin\//, '');
    }
    return null;
  }
  const fromEnv = (env.GITHUB_BASE_REF ?? '').trim();
  if (PROMOTION_BASE_REFS.has(fromEnv)) return fromEnv;
  return null;
}

/**
 * Task categories. Callers group these into CI lanes; the planner itself
 * has no notion of a lane.
 */
export const TASK_KIND = {
  FORMAT: 'format',
  ANALYZE: 'analyze',
  LINT: 'lint',
  TEST: 'test',
};

/**
 * Lane -> task kinds. The union must cover every kind, or a lane split
 * would silently drop checks. Asserted by `check-plan.test.mjs`.
 *
 * The split isolates the slow work (`dart analyze` spawns an analysis
 * server per chunk) from the fast, cheap string-level checks.
 */
export const LANES = {
  static: [TASK_KIND.FORMAT, TASK_KIND.LINT],
  analyze: [TASK_KIND.ANALYZE],
  test: [TASK_KIND.TEST],
};

/**
 * Filter a plan's tasks down to one lane.
 *
 * Throws on an unknown lane rather than returning `[]`: a silently empty
 * lane is a green check that verified nothing, which is the failure mode
 * this whole redesign exists to remove.
 *
 * @param {{kind: string}[]} tasks
 * @param {string} lane
 */
export function selectTasksForLane(tasks, lane) {
  const kinds = LANES[lane];
  if (!kinds) {
    throw new Error(
      `Unknown lane '${lane}'. Known lanes: ${Object.keys(LANES).join(', ')}.`,
    );
  }
  return tasks.filter((task) => kinds.includes(task.kind));
}

/** Default filesystem seams; overridden in tests. */
const realIo = {
  exists: (absPath) => fs.existsSync(absPath),
  findNearestPubspec: (absPath) => findNearestPubspecYaml(absPath),
  listAllPackageDirs: (flutterRoot) => getAllFlutterPackageDirs(flutterRoot),
};

/**
 * Map a repo-relative path to its owning package, relative to `flutter/`.
 * Returns null when the path has no owning package inside `flutter/`.
 */
function owningPackage(repoPath, repoRoot, io) {
  const pubspecPath = io.findNearestPubspec(path.join(repoRoot, repoPath));
  if (!pubspecPath) return null;
  const pkgDirRelToRepo = path.relative(repoRoot, path.dirname(pubspecPath));
  // Exact segment match: a bare startsWith('flutter') would also accept a
  // sibling like `flutterfoo/`, which the slice below would then corrupt.
  if (
    pkgDirRelToRepo !== 'flutter' &&
    !pkgDirRelToRepo.startsWith(`flutter${path.sep}`) &&
    !pkgDirRelToRepo.startsWith('flutter/')
  ) {
    return null;
  }
  const rel = pkgDirRelToRepo.slice('flutter/'.length).replace(/\\/g, '/');
  // '' is the flutter workspace root itself; root-level files are either
  // workspace-level (handled separately) or analyze-irrelevant.
  return rel === '' ? null : rel;
}

/**
 * Owning package dirs for a set of changed files, relative to `flutter/`.
 *
 * `relevantOnly` selects the analyze contract (Dart sources and configs
 * that can change analyzer output). Callers scoping *tests* must pass
 * false: a changed golden image, JSON fixture or test asset cannot alter
 * analyzer output but absolutely can break that package's suite.
 *
 * @param {{repoRoot: string, changedFiles: string[], relevantOnly?: boolean,
 *   io?: object}} opts
 * @returns {string[]} sorted package dirs relative to `flutter/`
 */
export function resolveChangedPackageDirs({
  repoRoot,
  changedFiles,
  relevantOnly = true,
  io = realIo,
}) {
  const packages = new Set();
  for (const repoPath of changedFiles) {
    if (!repoPath.startsWith('flutter/')) continue;
    if (relevantOnly && !isDartAnalyzeRelevant(repoPath)) continue;
    const pkg = owningPackage(repoPath, repoRoot, io);
    if (pkg) packages.add(pkg);
  }
  return [...packages].sort();
}

/**
 * Analyze target for a whole package: `lib/` when it exists, else the
 * package dir.
 *
 * Never the bare package dir when `lib/` is available — that pulls in
 * `test/`, which is what hung full-package analyze at 0% CPU against the
 * IDE analysis server (user_repository, 2026-07-15). `lib/` is the
 * superset that still catches dangling imports.
 */
function packageAnalyzeTarget(flutterCwd, pkgDir, io) {
  return io.exists(path.join(flutterCwd, pkgDir, 'lib'))
    ? `${pkgDir}/lib`
    : pkgDir;
}

/** Config files whose change forces a full-package analyze. */
const PACKAGE_CONFIG_RE =
  /(^|\/)(pubspec\.yaml|analysis_options\.yaml|build\.yaml|l10n\.yaml)$/;

/**
 * Build the Flutter check plan.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot absolute repo root
 * @param {string[]} opts.changedFiles repo-relative paths, including
 *   deletions (a deleted Dart file must still re-check its package, or a
 *   dangling import in an untouched consumer slips through)
 * @param {string} [opts.pubspecDiff] unified diff of
 *   `flutter/pubspec.yaml`; the caller owns git access. `null` — which is
 *   also the default — fails closed to a full analyze, so a caller that
 *   forgets to pass it cannot silently skip workspace-level analysis. Pass
 *   `''` only to positively assert there was no pubspec change.
 * @param {string[]} [opts.lintCmd] argv prefix for sea-trials-lint; when
 *   omitted, no lint tasks are emitted
 * @param {string[]} [opts.testPackageDirs] package dirs (relative to
 *   `flutter/`) to run tests for; when empty, no test tasks are emitted
 * @param {number} [opts.analyzeTimeoutMs]
 * @param {string[]} [opts.extraPackageDirs] package dirs to analyze in
 *   full regardless of what changed. Callers that cap the workspace
 *   fan-out use this to supply a bounded representative sample, so a
 *   root-only change (which owns no package) still validates something
 *   instead of producing an empty plan.
 * @param {boolean} [opts.allowFullWorkspace] when false, a workspace-level
 *   change stays scoped to the changed packages instead of fanning out to
 *   all 87. CI passes false: a whole-workspace sweep cannot fit a PR
 *   budget, which is precisely why whole-tree assurance was moved to the
 *   post-merge audit. The pre-push hook leaves it true — the developer's
 *   machine has no such cap and wants the full blast radius.
 * @param {string[]} [opts.analyzePackageDirsOverride] when set, analyze
 *   only these package dirs via `lib/` (never file-scoped). Promotion PR
 *   lanes use this so a dev→stg diff does not spawn one analysis pass per
 *   changed file across the whole release gap.
 * @param {object} [opts.io] filesystem seams
 * @returns {{tasks: object[], meta: object}}
 */
export function buildFlutterCheckPlan({
  repoRoot,
  changedFiles,
  pubspecDiff = null,
  lintCmd,
  testPackageDirs = [],
  extraPackageDirs = [],
  analyzePackageDirsOverride,
  analyzeTimeoutMs = DART_ANALYZE_TIMEOUT_MS,
  allowFullWorkspace = true,
  granularity = GRANULARITY.COARSE,
  io = realIo,
}) {
  const flutterCwd = path.join(repoRoot, 'flutter');
  const tasks = [];
  const fine = granularity === GRANULARITY.FINE;
  const pathBatch = fine ? FINE_DART_BATCH : DART_BATCH;

  const flutterChanged = changedFiles.filter((p) => p.startsWith('flutter/'));
  if (flutterChanged.length === 0) {
    return {
      tasks,
      meta: { workspaceLevel: false, analyzeChunks: 0, packages: [] },
    };
  }

  // Format and lint operate on files that still exist; analyze scoping
  // uses the full changed set so deletions still re-check their package.
  const dartExistingRepoPaths = changedFiles.filter(
    (p) =>
      isLintableDartPath(p) &&
      io.exists(path.join(repoRoot, p)),
  );
  const dartExistingFlutterPaths = dartExistingRepoPaths.map((p) =>
    p.slice('flutter/'.length),
  );

  const workspaceLevel = needsFullFlutterPackageAnalyze(changedFiles, {
    pubspecDiff,
  });
  // Classification and fan-out are separate decisions: the diff really is
  // workspace-level, but a caller under a time cap may decline to act on
  // it and defer whole-tree coverage to the audit.
  const fanOut = workspaceLevel && allowFullWorkspace;

  // ---- dart format --check -------------------------------------------
  // No --line-length: `formatter.page_width` in analysis_options.yaml is
  // the single source, so the precommit `fix` pass and this `--check`
  // gate share one ruleset. Chunked because a large branch can carry
  // hundreds of files and one spawn would exceed the Windows
  // command-line limit (spawn ENAMETOOLONG).
  for (const batch of chunk(dartExistingFlutterPaths, pathBatch)) {
    if (batch.length === 0) continue;
    tasks.push({
      kind: TASK_KIND.FORMAT,
      label: `dart format --check (${batch.length} files)`,
      cmd: 'dart',
      args: ['format', '--output', 'none', '--set-exit-if-changed', ...batch],
      options: { cwd: flutterCwd },
    });
  }

  // ---- dart analyze --fatal-infos ------------------------------------
  // Only analyze-relevant changes map to packages. Native platform code,
  // assets and docs map to NOTHING: they cannot change analyzer output,
  // and the old "no owning package -> analyze everything" fallback turned
  // a one-file AppDelegate.swift push into ~87 analysis servers (observed
  // 2026-07-08, 5+ min freeze).
  const changedPackages = new Set(
    resolveChangedPackageDirs({ repoRoot, changedFiles, io }),
  );

  /** @type {Map<string, string[]>} package -> flutter-relative dart paths */
  const dartFilesByPackage = new Map();
  for (const repoPath of dartExistingRepoPaths) {
    // Generated files are excluded by every package's analysis_options
    // (`exclude: **/*.g.dart`), but `dart analyze` HONOURS `exclude` only when
    // walking a directory — a file named explicitly on the command line is
    // analyzed regardless. So a file-scoped run reports issues the package-
    // scoped run never would, and they are unfixable by hand because the file
    // is regenerated. Observed: regenerating firestore_question.g.dart
    // surfaced a pre-existing `deprecated_member_use` on a field that is
    // deliberately kept for old app versions.
    //
    // Dropping them here keeps analyze honest: if a generated file is the only
    // change in a package, the list goes empty and the code below falls back to
    // analyzing the package directory, where `exclude` applies as intended.
    // Format and lint still see these files — only analyze skips them.
    if (isGeneratedDartPath(repoPath) || !isLintableDartPath(repoPath)) {
      continue;
    }
    const pkg = owningPackage(repoPath, repoRoot, io);
    if (!pkg) continue;
    if (!dartFilesByPackage.has(pkg)) dartFilesByPackage.set(pkg, []);
    dartFilesByPackage.get(pkg).push(repoPath.slice('flutter/'.length));
  }

  // Packages that lost a Dart file (deletion or rename source). Untouched
  // files in the same package may still import the path that is now gone,
  // so the package needs a re-check even when other files in it survive.
  const packagesWithDeletions = new Set();
  for (const repoPath of flutterChanged) {
    if (!repoPath.endsWith('.dart')) continue;
    if (io.exists(path.join(repoRoot, repoPath))) continue;
    const pkg = owningPackage(repoPath, repoRoot, io);
    if (pkg) packagesWithDeletions.add(pkg);
  }

  // Packages needing a full-dir analyze even on a scoped run.
  const forceFullPackage = new Set();
  if (!fanOut) {
    for (const repoPath of flutterChanged) {
      if (!PACKAGE_CONFIG_RE.test(repoPath)) continue;
      const pkg = owningPackage(repoPath, repoRoot, io);
      if (pkg) forceFullPackage.add(pkg);
    }
  }

  const promotionAnalyzeCap =
    analyzePackageDirsOverride !== undefined &&
    analyzePackageDirsOverride.length > 0;

  const analyzePkgDirs = promotionAnalyzeCap
    ? [...analyzePackageDirsOverride].sort()
    : fanOut
      ? io.listAllPackageDirs(flutterCwd)
      : [...changedPackages];

  /** @type {string[][]} */
  const analyzeFileGroups = [];
  /** @type {string[]} */
  const analyzeDirPaths = [];
  if (promotionAnalyzeCap) {
    for (const pkgDir of analyzePkgDirs) {
      analyzeDirPaths.push(packageAnalyzeTarget(flutterCwd, pkgDir, io));
    }
  } else if (fanOut) {
    analyzeDirPaths.push(...analyzePkgDirs);
  } else {
    for (const pkgDir of analyzePkgDirs) {
      const files = dartFilesByPackage.get(pkgDir) ?? [];
      if (files.length === 0) {
        // Config-only, .arb, or deletion-only: nothing file-scoped to
        // analyze, so take the package — via lib/, not the bare dir.
        analyzeDirPaths.push(packageAnalyzeTarget(flutterCwd, pkgDir, io));
      } else if (
        forceFullPackage.has(pkgDir) ||
        packagesWithDeletions.has(pkgDir)
      ) {
        // pubspec/options changed alongside Dart files: analyze the
        // changed files plus lib/ — a superset that catches dangling
        // imports without the full test/ context, which is what
        // regularly hangs full-package analyze at 0% CPU against the IDE
        // server (user_repository, 2026-07-15).
        analyzeFileGroups.push(files);
        const target = packageAnalyzeTarget(flutterCwd, pkgDir, io);
        if (!analyzeDirPaths.includes(target)) analyzeDirPaths.push(target);
      } else {
        analyzeFileGroups.push(files);
      }
    }
  }

  // Merge into a few chunked invocations: one `dart analyze` process
  // resolves every package context in a single analysis server, instead
  // of paying a VM + server cold start per package (18 serialized spawns
  // was ~8 min of mostly startup, observed 2026-07-15).
  // Representative packages supplied by a fan-out-capped caller, scoped
  // to lib/ for the same reason the forceFullPackage branch above is:
  // pulling test/ into a full-package analyze is what hangs the analysis
  // server at 0% CPU (user_repository, 2026-07-15). Feeding whole package
  // roots here would reintroduce that hang surface for up to a dozen
  // high-blast-radius packages on every workspace-level PR.
  for (const dir of extraPackageDirs) {
    const target = packageAnalyzeTarget(flutterCwd, dir, io);
    if (!analyzeDirPaths.includes(target)) analyzeDirPaths.push(target);
  }

  // Fine granularity: one analyze per package (a fix-worker owns exactly
  // one package's diagnostics) instead of cross-package merged chunks.
  // Weight is still declared so `run-gate-task` can throttle analyzers
  // machine-wide when many subagents run their tasks at once.
  const analyzeChunks = fine
    ? [
        ...analyzeFileGroups.map((files) => ({
          paths: files,
          fileCount: files.length,
          dirCount: 0,
        })),
        ...analyzeDirPaths.map((dir) => ({
          paths: [dir],
          fileCount: 0,
          dirCount: 1,
        })),
      ]
    : buildMergedAnalyzeChunks({
        fileGroups: analyzeFileGroups,
        dirPaths: analyzeDirPaths,
      });
  analyzeChunks.forEach((c, i) => {
    tasks.push({
      kind: TASK_KIND.ANALYZE,
      label:
        `dart analyze --fatal-infos (chunk ${i + 1}/${analyzeChunks.length}: ` +
        `${c.fileCount} file(s), ${c.dirCount} package dir(s))`,
      cmd: 'dart',
      args: ['analyze', '--fatal-infos', ...c.paths],
      options: { cwd: flutterCwd },
      timeoutMs: analyzeTimeoutMs,
      weight: analyzeWeight(),
    });
  });

  // ---- sea-trials-lint check -----------------------------------------
  // Takes ABSOLUTE paths, unlike format/analyze above.
  if (lintCmd && dartExistingFlutterPaths.length > 0) {
    const absDartPaths = dartExistingFlutterPaths.map((p) =>
      path.join(flutterCwd, p),
    );
    for (const batch of chunk(absDartPaths, pathBatch)) {
      if (batch.length === 0) continue;
      tasks.push({
        kind: TASK_KIND.LINT,
        label: `sea-trials-lint check (${batch.length} files)`,
        cmd: lintCmd[0],
        args: [...lintCmd.slice(1), 'check', '--root', flutterCwd, ...batch],
      });
    }
  }

  // ---- very_good test -------------------------------------------------
  // Callers pass the package set (changed packages plus their direct
  // dependents, from `package-graph.mjs`); resolving that graph needs to
  // read 87 pubspecs, which is the caller's business, not the planner's.
  //
  // `very_good test` rather than `flutter test`: it reports per-package
  // results in the form the rest of this repo's tooling expects. No
  // coverage flag is passed and no coverage gate exists yet — do not read
  // this as a coverage contract. No `--fail-fast` either: the lane must
  // report every failing package, not just the first.
  for (const pkgDir of testPackageDirs) {
    if (!io.exists(path.join(flutterCwd, pkgDir, 'test'))) continue;
    tasks.push({
      kind: TASK_KIND.TEST,
      label: `very_good test (${pkgDir})`,
      // Not --recursive: package dirs are iterated explicitly above, and
      // recursing would run nested workspace packages (app_ui/gallery)
      // twice.
      cmd: 'very_good',
      // `-x presubmit-only` matches what client_app's own workflow and
      // tool/coverage.sh have always passed. The tag marks tests that
      // cannot pass here by construction — `ensure_build` shells out to
      // `build_runner` and asserts the tree is clean afterwards, so it
      // fails on any working tree with edits in it. Harmless for the
      // other packages: excluding a tag they never declare is a no-op.
      args: ['test', '-j', '4', '-x', 'presubmit-only'],
      options: { cwd: path.join(flutterCwd, pkgDir) },
    });
  }

  return {
    tasks,
    meta: {
      workspaceLevel,
      // True when the diff was workspace-level but the caller capped the
      // fan-out; the whole-tree audit covers what this run skipped.
      fanOutSuppressed: workspaceLevel && !allowFullWorkspace,
      promotionAnalyzeCap,
      analyzeChunks: analyzeChunks.length,
      packages: [...changedPackages].sort(),
      analyzePackageDirs: [
        ...new Set([...analyzePkgDirs, ...extraPackageDirs]),
      ].sort(),
    },
  };
}

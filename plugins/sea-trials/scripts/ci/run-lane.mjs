/**
 * Run one CI lane of the shared Flutter check plan.
 *
 * Ships in the sea-trials plugin (`$ST_PLUGIN_ROOT/scripts/ci/`), not in
 * the app repo. Workflows call it as
 * `node "$ST_PLUGIN_ROOT/scripts/ci/run-lane.mjs" --lane … --base …`
 * with the checkout as cwd (or `ST_REPO_ROOT` set).
 *
 * Deliberately does NOT import `prepush.mjs`. That module acquires an
 * exclusive lockfile at import time; two lanes sharing a runner would see
 * the second die with "Another pre-push is already running", which is
 * nonsense in CI and reads as a real gate failure.
 *
 * It also does not use `ensureSeaTrialsLint`, which falls back to
 * downloading a GitHub *release* binary before building from source. In a
 * PR lane that would silently check the diff with a different linter
 * version than the PR contains — the same version-coupling hazard that
 * made the whole-tree audit untrustworthy. Lane mode consumes the binary
 * built earlier in its own job, or fails loudly.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveRepoRoot as resolveCheckoutRoot } from '../hooks/lib/plugin-paths.mjs';

/**
 * Git checkout root — `ST_REPO_ROOT` when st-run set it, else the git
 * toplevel of `cwd`. Never bare process.cwd(): CI steps often set
 * working-directory to flutter/ or a package subdir.
 *
 * @param {string} [cwd]
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  return resolveCheckoutRoot(cwd);
}

import { runParallelLimited } from '../hooks/lib/parallel.mjs';
import { getSeaTrialsLintCmd } from '../hooks/lib/resolve-sea-trials-lint.mjs';
import { needsFullFlutterPackageAnalyze } from '../hooks/lib/flutter-packages.mjs';
import {
  LANES,
  TASK_KIND,
  buildFlutterCheckPlan,
  resolveChangedPackageDirs,
  resolvePromotionBaseRef,
  selectTasksForLane,
} from '../hooks/lib/check-plan.mjs';
import {
  boundPackageSet,
  buildPackageGraph,
  withDirectDependents,
} from '../hooks/lib/package-graph.mjs';
import {
  emptyPassCache,
  parsePassCache,
} from './pass-cache.mjs';
import { changedFilesForCiPush } from './pr-push-changed-files.mjs';
import {
  hashPackagesFromLsFiles,
  nextPassCache,
  splitCached,
} from './test-shards.mjs';

/**
 * Concurrency weight for `dart analyze` in CI.
 *
 * The pre-push hook serializes analyze so it never fights the developer's
 * IDE analysis server. CI has no IDE, so full serialization would waste
 * the runner; each analysis server still uses several cores and up to
 * ~2 GB, so a weight of 2 keeps two in flight on a 4-vCPU runner rather
 * than four.
 */
const CI_ANALYZE_WEIGHT = 2;

/**
 * Concurrency weight for `very_good test` in CI.
 *
 * Each suite already passes `-j 4`. A default weight of 1 would run
 * several suites at once and oversubscribe the 4-vCPU runner. Pin 4
 * (not `os.cpus()`) so tests stay machine-independent, matching
 * `CI_ANALYZE_WEIGHT`.
 */
export const CI_TEST_WEIGHT = 4;

/**
 * @param {string[]} argv
 * @returns {{
 *   lane: string,
 *   base: string,
 *   packages?: string,
 *   planOnly: boolean,
 *   listAnalyzePackages: boolean,
 *   recordAnalyzePassCache: boolean,
 * }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string> & {
 *   planOnly?: boolean,
 *   listAnalyzePackages?: boolean,
 *   recordAnalyzePassCache?: boolean,
 * }} */
  const out = {
    planOnly: false,
    listAnalyzePackages: false,
    recordAnalyzePassCache: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--plan-only') {
      out.planOnly = true;
    } else if (arg === '--list-analyze-packages') {
      out.listAnalyzePackages = true;
    } else if (arg === '--record-analyze-pass-cache') {
      out.recordAnalyzePassCache = true;
    } else if (arg === '--lane' || arg === '--base' || arg === '--packages') {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      out[arg.slice(2)] = value;
      i += 1;
    } else {
      throw new Error(`Unknown argument '${arg}'`);
    }
  }
  if (!out.lane) throw new Error('--lane is required');
  if (!out.base) {
    // Never fall back to the local heuristic: it resolves through
    // `origin/main` while pull requests target `dev`, so the diff would
    // span the whole dev/main gap.
    throw new Error(
      '--base is required (pass origin/$GITHUB_BASE_REF); refusing to ' +
        'guess a base ref',
    );
  }
  if (!LANES[out.lane]) {
    throw new Error(
      `Unknown lane '${out.lane}'. Known lanes: ${Object.keys(LANES).join(', ')}.`,
    );
  }
  if (out.planOnly && out.lane !== 'analyze') {
    throw new Error('--plan-only is only supported for the analyze lane');
  }
  if (
    (out.listAnalyzePackages || out.recordAnalyzePassCache) &&
    out.lane !== 'analyze'
  ) {
    throw new Error(
      '--list-analyze-packages and --record-analyze-pass-cache are only ' +
        'supported for the analyze lane',
    );
  }
  /** @type {ReturnType<typeof parseArgs>} */
  const parsed = {
    lane: out.lane,
    base: out.base,
    planOnly: out.planOnly,
    listAnalyzePackages: out.listAnalyzePackages,
    recordAnalyzePassCache: out.recordAnalyzePassCache,
  };
  if (out.packages !== undefined) parsed.packages = out.packages;
  return parsed;
}

/**
 * A lane that verified nothing must say so loudly rather than reporting
 * green. An empty changed-file set means the base ref did not resolve to
 * what we think it did — a pull request always changes something.
 *
 * A non-empty diff that yields no tasks IS legitimate (a docs-only or
 * native-only PR), so that case passes with an explicit message.
 *
 * @param {{changedFiles: string[], base: string}} opts
 */
export function assertDiffIsPlausible({ changedFiles, base }) {
  if (changedFiles.length === 0) {
    throw new Error(
      `No changed files against '${base}'. A pull request always changes ` +
        'something, so this means the base ref did not resolve as expected. ' +
        'Refusing to report a green lane that verified nothing.',
    );
  }
}

/**
 * `dart format` reads its `formatter:` block from the nearest
 * analysis_options.yaml, and every package here reaches
 * `trailing_commas: preserve` through
 * `package:sea_trials_lints/...` -> `package:very_good_analysis/...`.
 * Resolving those `include:` URIs needs
 * flutter/.dart_tool/package_config.json. Without it the formatter does
 * not fail — it warns and falls back to `trailing_commas: automate`, so
 * the lane cheerfully demands collapsed lines that no developer's
 * pre-commit hook would produce, and the diff it prints looks like a real
 * formatting error. Refuse to run the check on a premise we know is wrong.
 *
 * @param {{repoRoot: string, exists?: (p: string) => boolean}} opts
 */
export function assertFormatterConfigResolvable({
  repoRoot,
  exists = (p) => fs.existsSync(p),
}) {
  const packageConfig = path.join(
    repoRoot,
    'flutter',
    '.dart_tool',
    'package_config.json',
  );
  if (!exists(packageConfig)) {
    throw new Error(
      `Missing ${packageConfig}. \`dart format\` would silently ignore ` +
        '`trailing_commas: preserve` and check the diff against a style ' +
        'nobody formats with. Run `flutter pub get` in flutter/ first.',
    );
  }
}

/**
 * Resolve the merge base once. Everything downstream must diff against
 * this, not the base tip: a change present on both branches cancels out
 * in a tip diff, so a shared `flutter/pubspec.yaml` edit would look like
 * no change at all and silently skip the workspace-level full analyze.
 *
 * @param {{base: string, git?: (args: string[]) => string}} opts
 */
export function resolveMergeBase({ base, git = defaultGit }) {
  const mergeBase = git(['merge-base', base, 'HEAD']).trim();
  if (!mergeBase) {
    throw new Error(`Could not compute merge-base against '${base}'`);
  }
  return mergeBase;
}

/**
 * @param {{
 *   base: string,
 *   git?: (args: string[]) => string,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {string[]} repo-relative paths, including deletions
 */
export function computeChangedFiles({
  base,
  git = defaultGit,
  env = process.env,
}) {
  if (resolvePromotionBaseRef({ base, env })) {
    return [...new Set(changedFilesForCiPush({ git, env }))].sort();
  }

  // Deletions and rename sources are included: when a public Dart API
  // moves or disappears, an untouched consumer is left with a dangling
  // import, and only its owning package re-check catches that.
  const mergeBase = resolveMergeBase({ base, git });
  const names = git([
    'diff',
    '--name-only',
    '--diff-filter=ACMRD',
    `${mergeBase}..HEAD`,
  ]);
  const renamed = git([
    'diff',
    '--name-status',
    '--find-renames',
    '--diff-filter=R',
    `${mergeBase}..HEAD`,
  ])
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter(Boolean);

  return [
    ...new Set(
      [...names.split('\n'), ...renamed].map((s) => s.trim()).filter(Boolean),
    ),
  ].sort();
}

function defaultGit(args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    // `git ls-files -s` on this monorepo is ~1.07MB, over Node's 1MB default.
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || '').trim();
    throw new Error(`git ${args.join(' ')} failed: ${detail}`);
  }
  return result.stdout ?? '';
}

/** Default on-disk path for dart-analyze layer-2 sentinels. */
export const ANALYZE_PASS_CACHE_PATH = '.cache/dart-analyze-pass.json';

/**
 * Keep only flutter paths owned by the bounded analyze sample.
 *
 * @param {string[]} changedFiles
 * @param {string[]} boundedPackageDirs flutter-relative package dirs
 */
export function filterChangedFilesForPromotionAnalyze(
  changedFiles,
  boundedPackageDirs,
) {
  if (boundedPackageDirs.length === 0) return changedFiles;
  const bounded = new Set(boundedPackageDirs);
  return changedFiles.filter((repoPath) => {
    if (!repoPath.startsWith('flutter/')) return true;
    const rel = repoPath.slice('flutter/'.length);
    for (const dir of bounded) {
      if (rel === dir || rel.startsWith(`${dir}/`)) return true;
    }
    return false;
  });
}

/**
 * @param {{
 *   repoRoot: string,
 *   changedFiles: string[],
 *   base: string,
 *   lane: string,
 *   graph: object | null,
 *   env?: NodeJS.ProcessEnv,
 *   io?: object,
 * }} opts
 * @returns {string[] | undefined}
 */
export function resolvePromotionAnalyzeDirs({
  repoRoot,
  changedFiles,
  base,
  lane,
  graph,
  env = process.env,
  io,
}) {
  if (
    !resolvePromotionBaseRef({ base, env }) ||
    !LANES[lane]?.includes(TASK_KIND.ANALYZE) ||
    !graph
  ) {
    return undefined;
  }
  const changed = resolveChangedPackageDirs({
    repoRoot,
    changedFiles,
    ...(io ? { io } : {}),
  });
  return boundPackageSet({ graph, packageDirs: changed });
}

/**
 * Union of changed packages and representative extras for analyze skip.
 *
 * @param {{
 *   repoRoot: string,
 *   changedFiles: string[],
 *   extraPackageDirs: string[],
 *   io?: object,
 * }} opts
 * @returns {string[]}
 */
export function analyzeCandidateDirs({
  repoRoot,
  changedFiles,
  extraPackageDirs,
  io,
}) {
  const changed = resolveChangedPackageDirs({
    repoRoot,
    changedFiles,
    ...(io ? { io } : {}),
  });
  return [...new Set([...changed, ...extraPackageDirs])].sort();
}

/**
 * Drop analyze work for packages whose content hash already passed.
 *
 * Files that do not live under a skipped package stay in the diff so
 * docs/native-only paths still drive "no applicable checks" correctly.
 *
 * @param {{
 *   changedFiles: string[],
 *   extraPackageDirs: string[],
 *   skippedDirs: string[],
 * }} opts
 */
export function dropCachedAnalyzeWork({
  changedFiles,
  extraPackageDirs,
  skippedDirs,
}) {
  const skipped = new Set(skippedDirs);
  return {
    changedFiles: changedFiles.filter((repoPath) => {
      if (!repoPath.startsWith('flutter/')) return true;
      const rel = repoPath.slice('flutter/'.length);
      for (const dir of skipped) {
        if (rel === dir || rel.startsWith(`${dir}/`)) return false;
      }
      return true;
    }),
    extraPackageDirs: extraPackageDirs.filter((d) => !skipped.has(d)),
  };
}

/**
 * @param {{
 *   repoRoot: string,
 *   changedFiles: string[],
 *   extraPackageDirs: string[],
 *   graph: object,
 *   git?: (args: string[]) => string,
 *   readFile?: (p: string) => string,
 *   io?: object,
 *   cachePath?: string,
 * }} opts
 */
export function applyAnalyzePassCache({
  repoRoot,
  changedFiles,
  extraPackageDirs,
  graph,
  git = defaultGit,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
  io,
  cachePath = path.join(repoRoot, ANALYZE_PASS_CACHE_PATH),
}) {
  let cache = emptyPassCache();
  try {
    cache = parsePassCache(readFile(cachePath));
  } catch {
    cache = emptyPassCache();
  }
  const candidateDirs = analyzeCandidateDirs({
    repoRoot,
    changedFiles,
    extraPackageDirs,
    io,
  });
  if (candidateDirs.length === 0) {
    return {
      changedFiles,
      extraPackageDirs,
      skipped: [],
      cache,
      hashes: {},
      candidateDirs,
    };
  }
  const hashes = hashPackagesFromLsFiles({
    lsFilesS: git(['ls-files', '-s']),
    packageDirs: candidateDirs,
    graph,
  });
  const { skipped } = splitCached(candidateDirs, { hashes, cache });
  const filtered = dropCachedAnalyzeWork({
    changedFiles,
    extraPackageDirs,
    skippedDirs: skipped,
  });
  return {
    ...filtered,
    skipped,
    cache,
    hashes,
    candidateDirs,
  };
}

/** Apply CI concurrency policy to planner output. */
export function applyCiWeights(tasks) {
  return tasks.map((task) => {
    if (task.kind === TASK_KIND.ANALYZE) {
      return { ...task, weight: CI_ANALYZE_WEIGHT };
    }
    if (task.kind === TASK_KIND.TEST) {
      return { ...task, weight: CI_TEST_WEIGHT };
    }
    return task;
  });
}

/**
 * Parse `--packages` into flutter-relative dirs.
 *
 * Present → that list is the entire test set (shard mode). Absent →
 * callers use `resolveTestPackageDirs`. Empty tokens are dropped.
 *
 * @param {string} packagesFlag
 * @returns {string[]}
 */
export function parsePackagesFlag(packagesFlag) {
  return [
    ...new Set(
      packagesFlag
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
}

/**
 * Test package dirs for this invocation.
 *
 * `--packages` **replaces** dependent expansion. It must not call
 * `withDirectDependents` / `resolveTestPackageDirs`.
 *
 * @param {{packages?: string, repoRoot: string, changedFiles: string[],
 *   workspaceLevel: boolean, graph: object, io?: object,
 *   allowFullWorkspace?: boolean}} opts
 * @returns {string[]}
 */
export function selectTestPackageDirs(opts) {
  if (opts.packages !== undefined) {
    return parsePackagesFlag(opts.packages);
  }
  return resolveTestPackageDirs(opts);
}

/**
 * Package dirs whose tests must run: changed packages plus their direct
 * in-workspace dependents, or every package on a workspace-level change.
 *
 * Scoped by *test* relevance, not analyze relevance. A changed golden
 * image, JSON fixture or test asset cannot alter analyzer output but can
 * absolutely break that package's suite, so filtering these out would
 * silently skip the suite the change most likely affects.
 *
 * @param {{repoRoot: string, changedFiles: string[], workspaceLevel: boolean,
 *   graph: object, io?: object}} opts
 * @returns {string[]}
 */
export function resolveTestPackageDirs({
  repoRoot,
  changedFiles,
  workspaceLevel,
  graph,
  io,
  allowFullWorkspace = true,
}) {
  if (workspaceLevel && allowFullWorkspace) {
    return [...graph.nameByDir.keys()].sort();
  }

  const changed = resolveChangedPackageDirs({
    repoRoot,
    changedFiles,
    relevantOnly: false,
    ...(io ? { io } : {}),
  });

  // A suppressed workspace-level diff gets the whole-workspace sample
  // PLUS whatever it actually touched.
  //
  // Sampling only the touched packages' dependents would be wrong: a
  // typical `pubspec.lock` bump alongside one call-site fix would then
  // test just that leaf, while the analyze lane samples across the
  // workspace — so dependency-upgrade breakage in untouched packages
  // slips past `dart-test` while `dart-analyze` looks for it. The two
  // lanes must sample the same way.
  if (workspaceLevel) {
    const sample = boundPackageSet({
      graph,
      packageDirs: [...graph.nameByDir.keys()],
    });
    // Union, not replace: what changed is always tested, sample or not.
    return [...new Set([...changed, ...sample])].sort();
  }

  // Uncapped on purpose. The documented contract is "changed packages
  // plus their direct dependents", and the whole-tree audit runs analyze
  // and lint but NOT tests — so a suite dropped here has no backstop
  // anywhere. Capping this path removed 31 of app_logger's 43 consumer
  // suites with nothing to catch what they would have caught.
  //
  // The cap stays on the workspace-level path above, where the set is the
  // entire workspace by construction rather than a genuine dependent set.
  return withDirectDependents({ graph, changedPackageDirs: changed });
}

/**
 * Shared test-lane snapshot used by `run-lane` and `test-shards --emit-plan`.
 *
 * One implementation so the planner and the executor cannot drift on
 * merge-base, workspace-level detection, or dependent expansion.
 *
 * @param {{base: string, repoRoot: string, git?: (args: string[]) => string,
 *   io?: object}} opts
 */
export function collectTestLaneContext({
  base,
  repoRoot,
  git = defaultGit,
  io,
}) {
  const mergeBase = resolveMergeBase({ base, git });
  const changedFiles = computeChangedFiles({ base, git });
  assertDiffIsPlausible({ changedFiles, base });
  const pubspecDiff = changedFiles.includes('flutter/pubspec.yaml')
    ? git(['diff', mergeBase, '--', 'flutter/pubspec.yaml'])
    : '';
  const workspaceLevel = needsFullFlutterPackageAnalyze(changedFiles, {
    pubspecDiff,
  });
  const graph = buildPackageGraph({
    flutterRoot: path.join(repoRoot, 'flutter'),
  });
  const testPackageDirs = resolveTestPackageDirs({
    repoRoot,
    changedFiles,
    workspaceLevel,
    graph,
    allowFullWorkspace: false,
    ...(io ? { io } : {}),
  });
  return {
    changedFiles,
    workspaceLevel,
    graph,
    testPackageDirs,
  };
}

/**
 * Build the task list for one lane without executing it.
 *
 * @param {{
 *   lane: string,
 *   base: string,
 *   repoRoot: string,
 *   packages?: string,
 *   git?: (args: string[]) => string,
 *   readFile?: (p: string) => string,
 * }} opts
 */
export function buildLanePlan({
  lane,
  base,
  repoRoot,
  packages,
  git = defaultGit,
  readFile = (p) => fs.readFileSync(p, 'utf8'),
}) {
  const mergeBase = resolveMergeBase({ base, git });
  const changedFiles = computeChangedFiles({ base, git });
  assertDiffIsPlausible({ changedFiles, base });

  const pubspecDiff = changedFiles.includes('flutter/pubspec.yaml')
    ? git(['diff', mergeBase, '--', 'flutter/pubspec.yaml'])
    : '';

  let lintCmd;
  if (LANES[lane].includes(TASK_KIND.LINT)) {
    lintCmd = getSeaTrialsLintCmd(repoRoot);
  }

  const workspaceLevel = needsFullFlutterPackageAnalyze(changedFiles, {
    pubspecDiff,
  });
  const needsGraph =
    LANES[lane].includes(TASK_KIND.TEST) ||
    LANES[lane].includes(TASK_KIND.ANALYZE);
  const graph = needsGraph
    ? buildPackageGraph({ flutterRoot: path.join(repoRoot, 'flutter') })
    : null;

  let testPackageDirs = [];
  if (LANES[lane].includes(TASK_KIND.TEST)) {
    testPackageDirs = selectTestPackageDirs({
      packages,
      repoRoot,
      changedFiles,
      workspaceLevel,
      graph,
      allowFullWorkspace: false,
    });
  }

  let analyzePackageDirsOverride;
  if (needsGraph) {
    analyzePackageDirsOverride = resolvePromotionAnalyzeDirs({
      repoRoot,
      changedFiles,
      base,
      lane,
      graph,
    });
  }

  let extraPackageDirs =
    workspaceLevel && LANES[lane].includes(TASK_KIND.ANALYZE)
      ? boundPackageSet({
          graph,
          packageDirs: [...graph.nameByDir.keys()],
        })
      : [];

  let analyzePass = null;
  let plannedFiles = changedFiles;
  if (LANES[lane].includes(TASK_KIND.ANALYZE) && graph) {
    const analyzeChangedFiles = analyzePackageDirsOverride
      ? filterChangedFilesForPromotionAnalyze(
          changedFiles,
          analyzePackageDirsOverride,
        )
      : changedFiles;
    analyzePass = applyAnalyzePassCache({
      repoRoot,
      changedFiles: analyzeChangedFiles,
      extraPackageDirs,
      graph,
      git,
      readFile,
    });
    plannedFiles = analyzePass.changedFiles;
    extraPackageDirs = analyzePass.extraPackageDirs;
  }

  const { tasks, meta } = buildFlutterCheckPlan({
    repoRoot,
    changedFiles: plannedFiles,
    pubspecDiff,
    lintCmd,
    testPackageDirs,
    extraPackageDirs,
    analyzePackageDirsOverride,
    allowFullWorkspace: false,
  });

  const laneTasks = applyCiWeights(selectTasksForLane(tasks, lane));

  return {
    lane,
    base,
    changedFiles,
    laneTasks,
    meta,
    analyzePass,
    graph,
    testPackageDirs,
  };
}

/**
 * @param {{base: string, repoRoot: string}} opts
 * @returns {{hasWork: boolean, taskCount: number, skippedCount: number}}
 */
export function emitAnalyzePlan({ base, repoRoot }) {
  const plan = buildLanePlan({ lane: 'analyze', base, repoRoot });
  const skipped = plan.analyzePass?.skipped ?? [];

  if (skipped.length > 0) {
    process.stdout.write(
      `dart-analyze-plan: skipping ${skipped.length} cached package(s): ` +
        `${skipped.join(', ')}\n`,
    );
  }

  if (plan.meta.fanOutSuppressed) {
    process.stdout.write(
      'dart-analyze-plan: workspace-level diff; bounded sample only\n',
    );
  }

  if (plan.meta.promotionAnalyzeCap) {
    process.stdout.write(
      `dart-analyze-plan: promotion PR (base ${resolvePromotionBaseRef({ base })}); ` +
        'bounded analyze sample\n',
    );
  }

  const hasWork = plan.laneTasks.length > 0;
  process.stdout.write(
    `dart-analyze-plan: ${plan.changedFiles.length} changed file(s) vs ` +
      `${base}; ${plan.laneTasks.length} analyze task(s)\n`,
  );

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    fs.appendFileSync(outputFile, `has_work=${hasWork}\n`);
  }

  return {
    hasWork,
    taskCount: plan.laneTasks.length,
    skippedCount: skipped.length,
  };
}

/* c8 ignore start -- CLI wrapper; the exported logic above is tested. */
async function main() {
  const {
    lane,
    base,
    packages,
    planOnly,
    listAnalyzePackages,
    recordAnalyzePassCache,
  } = parseArgs(process.argv.slice(2));
  const repoRoot = resolveRepoRoot();

  if (planOnly) {
    emitAnalyzePlan({ base, repoRoot });
    return;
  }

  if (listAnalyzePackages || recordAnalyzePassCache) {
    const plan = buildLanePlan({ lane, base, repoRoot, packages });
    if (listAnalyzePackages) {
      const dirs = plan.meta.analyzePackageDirs ?? [];
      process.stdout.write(dirs.join(','));
      return;
    }
    writeAnalyzePassCache(plan.analyzePass, repoRoot);
    process.stdout.write(
      `dart-analyze: recorded pass-cache for ` +
        `${plan.meta.analyzePackageDirs?.length ?? 0} package(s)\n`,
    );
    return;
  }

  const plan = buildLanePlan({ lane, base, repoRoot, packages });
  const { changedFiles, laneTasks, meta, analyzePass } = plan;

  if (laneTasks.some((t) => t.kind === TASK_KIND.FORMAT)) {
    assertFormatterConfigResolvable({ repoRoot });
  }

  process.stdout.write(
    `Lane '${lane}': ${changedFiles.length} changed file(s) vs ${base}; ` +
      `${laneTasks.length} task(s)\n`,
  );

  if (analyzePass?.skipped.length) {
    process.stdout.write(
      `Lane '${lane}': skipping ${analyzePass.skipped.length} ` +
        `cached package(s): ${analyzePass.skipped.join(', ')}\n`,
    );
  }

  if (meta.fanOutSuppressed) {
    // Say so loudly: this run deliberately did not cover every package,
    // and the reader needs to know where that coverage actually comes from.
    process.stdout.write(
      `Lane '${lane}': the diff is workspace-level. PR lanes check a ` +
        'bounded representative sample instead of all 87 packages — a ' +
        'whole-workspace sweep cannot fit the lane budget. This is a ' +
        'sample, not proof: unchanged consumers are covered by the ' +
        'whole-tree audit in Main Guardrails.\n',
    );
  }

  if (meta.promotionAnalyzeCap) {
    process.stdout.write(
      `Lane '${lane}': promotion PR (base ${resolvePromotionBaseRef({ base })}). ` +
        'Analyze is capped to a bounded representative sample instead of ' +
        'file-scoping every changed Dart file across the release gap. ' +
        'This is a sample, not proof: whole-workspace assurance stays ' +
        'with the post-merge audit.\n',
    );
  }

  if (laneTasks.length === 0) {
    // Legitimate: the diff touched nothing this lane checks.
    process.stdout.write(
      `Lane '${lane}': no applicable checks for this diff.\n`,
    );
    writeAnalyzePassCache(analyzePass, repoRoot);
    return;
  }

  const { failures, results } = await runParallelLimited(laneTasks);
  if (failures.length > 0) {
    process.stderr.write(`\n❌ Lane '${lane}' failed.\n`);
    process.exitCode = 1;
    return;
  }

  if (lane === 'test') {
    writeTestTimingPartial({
      results,
      repoRoot,
      graph: plan.graph,
      testPackageDirs: plan.testPackageDirs,
    });
  }

  writeAnalyzePassCache(analyzePass, repoRoot);
}

/**
 * Record per-package wall times for the shard timing cache.
 *
 * OPT-IN, AND DELIBERATELY NOT WIRED INTO pr-checks.yml. Set
 * DART_TEST_TIMING_PARTIAL to a writable path to collect timings, then
 * merge them with `test-shards.mjs --merge-timing --dir <d>` to produce
 * .cache/dart-test-timing.json. No workflow does this, which is a choice
 * rather than an oversight: `FAT_BASELINE_SECONDS` in test-shard-timing.mjs
 * predicts the three heavy packages to within 6% (client_app 290 vs 274
 * actual, admin_app 245 vs 252, powersync 240 vs 242), and the resulting
 * heavy-shard spread is 242-274s — 13% skew. Closing the loop in CI would
 * cost one artifact upload per shard plus a download, a merge job and a
 * cache round-trip, to improve on a 13% imbalance that hand-tuned
 * constants already deliver. Re-measure the baselines instead when they
 * drift; wire this up only if the spread grows enough to matter.
 *
 * @param {{results: {label: string, code: number, durationMs?: number}[],
 *   repoRoot: string, graph?: object|null,
 *   testPackageDirs?: string[]}} opts
 */
function writeTestTimingPartial({ results, repoRoot, graph, testPackageDirs }) {
  const outPath = process.env.DART_TEST_TIMING_PARTIAL;
  if (!outPath) return;

  /** @type {Record<string, string>} */
  let packageHashes = {};
  if (graph && testPackageDirs?.length) {
    packageHashes = hashPackagesFromLsFiles({
      lsFilesS: defaultGit(['ls-files', '-s', '--', 'flutter']),
      packageDirs: testPackageDirs,
      graph,
    });
  }

  /** @type {Record<string, {seconds: number, hash?: string}>} */
  const packages = {};
  for (const result of results) {
    const match = /^very_good test \((.+)\)$/.exec(result.label);
    if (!match || result.code !== 0 || !result.durationMs) continue;
    const dir = match[1];
    packages[dir] = {
      seconds: Math.round(result.durationMs / 1000),
      ...(packageHashes[dir] ? { hash: packageHashes[dir] } : {}),
    };
  }
  if (Object.keys(packages).length === 0) return;

  const resolved = path.isAbsolute(outPath)
    ? outPath
    : path.join(repoRoot, outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify({ packages }, null, 2)}\n`);
  process.stdout.write(
    `Lane 'test': recorded timing for ${Object.keys(packages).length} package(s)\n`,
  );
}

/**
 * Persist analyze sentinels only after the lane succeeded (including
 * the empty-task case, where every candidate was already cached).
 *
 * @param {ReturnType<typeof applyAnalyzePassCache> | null} analyzePass
 * @param {string} repoRoot
 */
function writeAnalyzePassCache(analyzePass, repoRoot) {
  if (!analyzePass) return;
  const next = nextPassCache({
    cache: analyzePass.cache,
    packageDirs: analyzePass.candidateDirs,
    hashes: analyzePass.hashes,
  });
  const cachePath = path.join(repoRoot, ANALYZE_PASS_CACHE_PATH);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(next, null, 2)}\n`);
}

// argv[1] is undefined under `node -e` / REPL imports, where
// pathToFileURL would throw rather than simply not match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    process.stderr.write(`run-lane: ${err.message}\n`);
    process.exit(2);
  });
}
/* c8 ignore stop */

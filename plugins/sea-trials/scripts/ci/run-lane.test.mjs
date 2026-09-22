import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TASK_KIND } from '../hooks/lib/check-plan.mjs';
import {
  CI_TEST_WEIGHT,
  applyAnalyzePassCache,
  applyCiWeights,
  assertDiffIsPlausible,
  assertFormatterConfigResolvable,
  computeChangedFiles,
  dropCachedAnalyzeWork,
  filterChangedFilesForPromotionAnalyze,
  parseArgs,
  parsePackagesFlag,
  resolvePromotionAnalyzeDirs,
  resolveRepoRoot,
  resolveTestPackageDirs,
  selectTestPackageDirs,
} from './run-lane.mjs';
import { resolvePromotionBaseRef } from '../hooks/lib/check-plan.mjs';
import { recordPassed, emptyPassCache } from './pass-cache.mjs';

// ---------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------

test('resolveRepoRoot finds git toplevel from flutter/ cwd', () => {
  // CI steps often set working-directory to flutter/ or a package
  // subdir; the lane must still find the checkout root. Built in a
  // scratch repo because this test ships in the plugin, not the app.
  const scratch = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'run-lane-root-')),
  );
  const savedRepoRoot = process.env.ST_REPO_ROOT;
  delete process.env.ST_REPO_ROOT;
  try {
    spawnSync('git', ['init', '-q'], { cwd: scratch });
    fs.mkdirSync(path.join(scratch, 'flutter'));
    fs.writeFileSync(path.join(scratch, 'flutter/pubspec.yaml'), 'name: ws\n');
    const fromFlutter = resolveRepoRoot(path.join(scratch, 'flutter'));
    assert.equal(fs.realpathSync(fromFlutter), scratch);

    // ST_REPO_ROOT (set by st-run) wins over cwd.
    process.env.ST_REPO_ROOT = path.join(scratch, 'flutter');
    assert.equal(
      resolveRepoRoot(scratch),
      path.resolve(scratch, 'flutter'),
    );
  } finally {
    if (savedRepoRoot === undefined) delete process.env.ST_REPO_ROOT;
    else process.env.ST_REPO_ROOT = savedRepoRoot;
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});

test('parses a lane and an explicit base', () => {
  assert.deepEqual(parseArgs(['--lane', 'static', '--base', 'origin/dev']), {
    lane: 'static',
    base: 'origin/dev',
    planOnly: false,
    listAnalyzePackages: false,
    recordAnalyzePassCache: false,
  });
});

test('refuses to guess a base ref', () => {
  // The local heuristic resolves through origin/main while PRs target
  // dev, so a guessed base would diff the whole dev/main gap.
  assert.throws(() => parseArgs(['--lane', 'static']), /--base is required/);
});

test('rejects an unknown lane rather than selecting nothing', () => {
  assert.throws(
    () => parseArgs(['--lane', 'typo', '--base', 'origin/dev']),
    /Unknown lane 'typo'/,
  );
});

test('rejects a flag with a missing value', () => {
  assert.throws(
    () => parseArgs(['--lane', '--base', 'origin/dev']),
    /--lane requires a value/,
  );
});

test('rejects unknown arguments', () => {
  assert.throws(
    () => parseArgs(['--lane', 'static', '--base', 'origin/dev', '--wat']),
    /Unknown argument '--wat'/,
  );
});

test('parses --packages as an explicit dir list', () => {
  assert.deepEqual(
    parseArgs([
      '--lane',
      'test',
      '--base',
      'origin/dev',
      '--packages',
      'apps/client_app,packages/app_ui',
    ]),
    {
      lane: 'test',
      base: 'origin/dev',
      packages: 'apps/client_app,packages/app_ui',
      planOnly: false,
      listAnalyzePackages: false,
      recordAnalyzePassCache: false,
    },
  );
});

test('omits packages when the flag is absent', () => {
  assert.equal(
    Object.hasOwn(
      parseArgs(['--lane', 'test', '--base', 'origin/dev']),
      'packages',
    ),
    false,
  );
});

// ---------------------------------------------------------------------
// Empty-diff guard
// ---------------------------------------------------------------------

test('an empty diff fails loudly instead of reporting green', () => {
  // This is the failure this guard exists for: a base ref that does not
  // resolve as expected yields no changed files, every lane finds no
  // work, and CI goes green having verified nothing.
  assert.throws(
    () => assertDiffIsPlausible({ changedFiles: [], base: 'origin/dev' }),
    /verified nothing/,
  );
});

test('a non-empty diff passes the plausibility check', () => {
  assert.doesNotThrow(() =>
    assertDiffIsPlausible({ changedFiles: ['README.md'], base: 'origin/dev' }),
  );
});

// ---------------------------------------------------------------------
// Formatter config resolution
// ---------------------------------------------------------------------

test('an unresolved workspace fails before dart format runs', () => {
  // Silent fallback is the hazard: `dart format` warns about the
  // unresolvable include and then checks against
  // `trailing_commas: automate`, which reads as a genuine formatting
  // failure on a correctly formatted branch.
  assert.throws(
    () =>
      assertFormatterConfigResolvable({
        repoRoot: '/repo',
        exists: () => false,
      }),
    /flutter pub get/,
  );
});

test('a resolved workspace passes the formatter config check', () => {
  const seen = [];
  assert.doesNotThrow(() =>
    assertFormatterConfigResolvable({
      repoRoot: '/repo',
      exists: (p) => {
        seen.push(p);
        return true;
      },
    }),
  );
  assert.deepEqual(seen, ['/repo/flutter/.dart_tool/package_config.json']);
});

// ---------------------------------------------------------------------
// Changed-file computation
// ---------------------------------------------------------------------

function makeGit(responses) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    for (const [match, value] of Object.entries(responses)) {
      if (args.join(' ').includes(match)) return value;
    }
    return '';
  };
  return { git, calls };
}

test('diffs against the merge-base, not the base tip', () => {
  // Diffing the base tip directly would attribute other people's merges
  // to this pull request.
  const { git, calls } = makeGit({
    'merge-base': 'abc123\n',
    '--name-only': 'flutter/a.dart\nREADME.md\n',
  });

  const files = computeChangedFiles({ base: 'origin/dev', git });

  assert.ok(calls.some((c) => c.startsWith('merge-base origin/dev HEAD')));
  assert.ok(calls.some((c) => c.includes('abc123..HEAD')));
  assert.deepEqual(files, ['README.md', 'flutter/a.dart']);
});

test('includes deletions and rename sources', () => {
  // A deleted or moved public API leaves untouched consumers with a
  // dangling import; only re-checking the owning package catches it.
  const { git } = makeGit({
    'merge-base': 'abc123\n',
    '--name-only': 'flutter/new.dart\n',
    '--name-status': 'R100\tflutter/old.dart\tflutter/new.dart\n',
  });

  const files = computeChangedFiles({ base: 'origin/dev', git });

  assert.deepEqual(files, ['flutter/new.dart', 'flutter/old.dart']);
});

test('deduplicates paths appearing in both diff passes', () => {
  const { git } = makeGit({
    'merge-base': 'abc123\n',
    '--name-only': 'flutter/a.dart\n',
    '--name-status': 'R100\tflutter/a.dart\tflutter/b.dart\n',
  });

  assert.deepEqual(computeChangedFiles({ base: 'origin/dev', git }), [
    'flutter/a.dart',
  ]);
});

test('a missing merge-base fails rather than diffing against nothing', () => {
  const { git } = makeGit({ 'merge-base': '\n' });
  assert.throws(
    () => computeChangedFiles({ base: 'origin/nope', git }),
    /Could not compute merge-base/,
  );
});

// ---------------------------------------------------------------------
// CI concurrency policy
// ---------------------------------------------------------------------

test('CI weights analyze tasks but leaves the rest at the default', () => {
  const tasks = [
    { kind: TASK_KIND.ANALYZE, label: 'a' },
    { kind: TASK_KIND.FORMAT, label: 'f' },
    { kind: TASK_KIND.LINT, label: 'l' },
  ];

  const weighted = applyCiWeights(tasks);

  assert.equal(weighted[0].weight, 2);
  assert.equal(Object.hasOwn(weighted[1], 'weight'), false);
  assert.equal(Object.hasOwn(weighted[2], 'weight'), false);
});

test('CI serializes very_good test at weight 4', () => {
  const [testTask] = applyCiWeights([{ kind: TASK_KIND.TEST, label: 't' }]);
  assert.equal(testTask.weight, CI_TEST_WEIGHT);
  assert.equal(CI_TEST_WEIGHT, 4);
});

test('CI does not inherit the hook full serialization', () => {
  // The hook sets weight = max(cores, 2) so it never runs two analysis
  // servers against the developer's IDE. CI has no IDE, and
  // runParallelLimited budgets on core count, so inheriting that weight
  // would leave a 4-vCPU runner executing one analyze at a time.
  const GITHUB_RUNNER_CORES = 4;
  const [analyze] = applyCiWeights([{ kind: TASK_KIND.ANALYZE }]);

  assert.ok(
    analyze.weight < GITHUB_RUNNER_CORES,
    `weight ${analyze.weight} would serialize a ${GITHUB_RUNNER_CORES}-core runner`,
  );
  assert.ok(analyze.weight > 1, 'analyze is heavy enough to deserve a weight');
});

test('applyCiWeights does not mutate the planner output', () => {
  const tasks = [{ kind: TASK_KIND.ANALYZE, label: 'a' }];
  applyCiWeights(tasks);
  assert.equal(Object.hasOwn(tasks[0], 'weight'), false);
});

// ---------------------------------------------------------------------
// Test-lane package selection
// ---------------------------------------------------------------------

/** Minimal package graph double. */
function makeGraph(pkgs, dependents = {}) {
  return {
    nameByDir: new Map(pkgs.map((d) => [d, d.split('/').pop()])),
    dirByName: new Map(pkgs.map((d) => [d.split('/').pop(), d])),
    dependentsByName: new Map(
      Object.entries(dependents).map(([k, v]) => [k, new Set(v)]),
    ),
  };
}

/** Filesystem double resolving flutter/<pkg>/... to its package. */
function makePkgIo(pkgs) {
  return {
    exists: () => true,
    listAllPackageDirs: () => pkgs,
    findNearestPubspec: (abs) => {
      const rel = abs.slice('/repo/flutter/'.length);
      const hit = [...pkgs]
        .sort((a, b) => b.length - a.length)
        .find((p) => rel === p || rel.startsWith(`${p}/`));
      return hit ? `/repo/flutter/${hit}/pubspec.yaml` : null;
    },
  };
}

const PKGS = ['packages/app_ui', 'packages/l10n', 'apps/client_app'];

test('a workspace-level change selects every package', () => {
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/pubspec.lock'],
    workspaceLevel: true,
    graph: makeGraph(PKGS),
    io: makePkgIo(PKGS),
  });
  assert.deepEqual(dirs, [...PKGS].sort());
});

test('a scoped change selects the package plus its direct dependents', () => {
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/packages/l10n/lib/a.dart'],
    workspaceLevel: false,
    graph: makeGraph(PKGS, { l10n: ['app_ui'] }),
    io: makePkgIo(PKGS),
  });
  assert.deepEqual(dirs, ['packages/app_ui', 'packages/l10n']);
});

test('a non-analyze-relevant asset still selects its package', () => {
  // THE reason this is scoped by test relevance rather than analyze
  // relevance: a golden image or JSON fixture cannot change analyzer
  // output but absolutely can break that package's suite.
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/packages/app_ui/test/goldens/button.png'],
    workspaceLevel: false,
    graph: makeGraph(PKGS),
    io: makePkgIo(PKGS),
  });
  assert.deepEqual(dirs, ['packages/app_ui']);
});

test('a change owning no package selects nothing', () => {
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['docs/README.md'],
    workspaceLevel: false,
    graph: makeGraph(PKGS),
    io: makePkgIo(PKGS),
  });
  assert.deepEqual(dirs, []);
});

test('a workspace-level diff that also touches a package still gets the sample', () => {
  // Regression guard: bounding only the touched package's dependents made
  // a `pubspec.lock` bump plus one call-site fix test just that leaf,
  // while the analyze lane sampled across the workspace. Dependency
  // breakage in untouched packages slipped past dart-test.
  const pkgs = ['packages/app_ui', 'packages/l10n', 'apps/client_app'];
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/pubspec.lock', 'flutter/packages/app_ui/lib/a.dart'],
    workspaceLevel: true,
    graph: makeGraph(pkgs, { app_ui: ['client_app'] }),
    io: makePkgIo(pkgs),
    allowFullWorkspace: false,
  });

  // Every package in this small fixture is under the limit, so the sample
  // is the whole workspace — the point is that it is NOT just app_ui.
  assert.ok(dirs.length > 1, 'must not collapse to the touched leaf');
  assert.ok(dirs.includes('packages/l10n'), 'untouched package must be sampled');
  assert.ok(dirs.includes('packages/app_ui'), 'touched package always tested');
});

test('the touched package survives even when the sample is capped', () => {
  const pkgs = Array.from({ length: 30 }, (_, i) => `packages/p${i}`);
  pkgs.push('packages/touched');
  const dirs = resolveTestPackageDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/pubspec.lock', 'flutter/packages/touched/lib/a.dart'],
    workspaceLevel: true,
    graph: makeGraph(pkgs),
    io: makePkgIo(pkgs),
    allowFullWorkspace: false,
  });

  assert.ok(dirs.includes('packages/touched'), 'union, not replace');
  assert.ok(dirs.length <= 13, `bounded, got ${dirs.length}`);
});

// ---------------------------------------------------------------------
// --packages replaces dependent expansion
// ---------------------------------------------------------------------

test('parsePackagesFlag splits, trims, and sorts unique dirs', () => {
  assert.deepEqual(
    parsePackagesFlag('packages/app_ui, apps/client_app,packages/app_ui'),
    ['apps/client_app', 'packages/app_ui'],
  );
});

test('--packages replaces resolveTestPackageDirs', () => {
  // A change to l10n would pull app_ui via dependents. The flag must
  // not expand: shards pass an already-planned slice.
  const dirs = selectTestPackageDirs({
    packages: 'packages/l10n',
    repoRoot: '/repo',
    changedFiles: ['flutter/packages/l10n/lib/a.dart'],
    workspaceLevel: false,
    graph: makeGraph(PKGS, { l10n: ['app_ui'] }),
    io: makePkgIo(PKGS),
  });
  assert.deepEqual(dirs, ['packages/l10n']);
});

test('dropCachedAnalyzeWork removes skipped package files only', () => {
  const out = dropCachedAnalyzeWork({
    changedFiles: [
      'docs/plan.md',
      'flutter/packages/app_ui/lib/a.dart',
      'flutter/packages/l10n/lib/b.dart',
    ],
    extraPackageDirs: ['packages/app_ui', 'packages/l10n'],
    skippedDirs: ['packages/app_ui'],
  });
  assert.deepEqual(out.changedFiles, [
    'docs/plan.md',
    'flutter/packages/l10n/lib/b.dart',
  ]);
  assert.deepEqual(out.extraPackageDirs, ['packages/l10n']);
});

test('applyAnalyzePassCache skips a package whose hash already passed', () => {
  const pkgs = ['packages/app_ui', 'packages/l10n'];
  const ls = [
    '100644 abc app_ui.dart\tflutter/packages/app_ui/lib/a.dart',
    '100644 def l10n.dart\tflutter/packages/l10n/lib/b.dart',
    '100644 lock lock\tflutter/pubspec.lock',
  ].join('\n');
  const graph = makeGraph(pkgs);
  // First run records hashes; second run with that sentinel must skip
  // app_ui and keep l10n.
  const first = applyAnalyzePassCache({
    repoRoot: '/repo',
    changedFiles: [
      'flutter/packages/app_ui/lib/a.dart',
      'flutter/packages/l10n/lib/b.dart',
    ],
    extraPackageDirs: [],
    graph,
    git: (args) => {
      if (args[0] === 'ls-files') return ls;
      throw new Error(args.join(' '));
    },
    readFile: () => {
      throw new Error('ENOENT');
    },
    io: makePkgIo(pkgs),
  });
  assert.deepEqual(first.skipped, []);

  const cache = recordPassed(
    emptyPassCache(),
    'packages/app_ui',
    first.hashes['packages/app_ui'],
  );
  const second = applyAnalyzePassCache({
    repoRoot: '/repo',
    changedFiles: [
      'flutter/packages/app_ui/lib/a.dart',
      'flutter/packages/l10n/lib/b.dart',
    ],
    extraPackageDirs: [],
    graph,
    git: (args) => {
      if (args[0] === 'ls-files') return ls;
      throw new Error(args.join(' '));
    },
    readFile: () => JSON.stringify(cache),
    io: makePkgIo(pkgs),
  });
  assert.deepEqual(second.skipped, ['packages/app_ui']);
  assert.ok(
    !second.changedFiles.includes('flutter/packages/app_ui/lib/a.dart'),
  );
  assert.ok(
    second.changedFiles.includes('flutter/packages/l10n/lib/b.dart'),
  );
});

test('rejects --plan-only on non-analyze lanes', () => {
  assert.throws(
    () =>
      parseArgs(['--lane', 'static', '--base', 'origin/dev', '--plan-only']),
    /--plan-only is only supported for the analyze lane/,
  );
});

test('parses --plan-only on the analyze lane', () => {
  assert.deepEqual(
    parseArgs(['--lane', 'analyze', '--base', 'origin/dev', '--plan-only']),
    {
      lane: 'analyze',
      base: 'origin/dev',
      planOnly: true,
      listAnalyzePackages: false,
      recordAnalyzePassCache: false,
    },
  );
});

// ---------------------------------------------------------------------
// Promotion PR analyze scoping
// ---------------------------------------------------------------------

test('resolvePromotionAnalyzeDirs caps analyze on stg/main targets', () => {
  const pkgs = Array.from({ length: 20 }, (_, i) => `packages/p${i}`);
  const changedFiles = pkgs.map(
    (pkg) => `flutter/${pkg}/lib/a.dart`,
  );
  const dirs = resolvePromotionAnalyzeDirs({
    repoRoot: '/repo',
    changedFiles,
    base: 'origin/stg',
    lane: 'analyze',
    graph: makeGraph(pkgs),
    env: {},
    io: makePkgIo(pkgs),
  });

  assert.ok(dirs);
  assert.equal(dirs.length, 12);
});

test('resolvePromotionAnalyzeDirs is absent for dev PRs', () => {
  const dirs = resolvePromotionAnalyzeDirs({
    repoRoot: '/repo',
    changedFiles: ['flutter/packages/app_ui/lib/a.dart'],
    base: 'origin/dev',
    lane: 'analyze',
    graph: makeGraph(PKGS),
    env: { GITHUB_BASE_REF: 'dev' },
    io: makePkgIo(PKGS),
  });
  assert.equal(dirs, undefined);
});

test('filterChangedFilesForPromotionAnalyze keeps only bounded packages', () => {
  const out = filterChangedFilesForPromotionAnalyze(
    [
      'docs/plan.md',
      'flutter/packages/app_ui/lib/a.dart',
      'flutter/packages/l10n/lib/b.dart',
    ],
    ['packages/app_ui'],
  );
  assert.deepEqual(out, [
    'docs/plan.md',
    'flutter/packages/app_ui/lib/a.dart',
  ]);
});

test('resolvePromotionBaseRef detects stg from env on analyze lane', () => {
  assert.equal(
    resolvePromotionBaseRef({
      base: 'origin/stg',
      env: { GITHUB_BASE_REF: 'stg' },
    }),
    'stg',
  );
});

test('computeChangedFiles uses push range on promotion PRs', () => {
  const git = (args) => {
    assert.deepEqual(args.slice(0, 4), [
      'diff',
      '--name-only',
      '--no-renames',
      'before123',
    ]);
    return 'scripts/ci/foo.mjs\n';
  };
  assert.deepEqual(
    computeChangedFiles({
      base: 'origin/stg',
      git,
      env: {
        GITHUB_BASE_REF: 'stg',
        GITHUB_EVENT_BEFORE: 'before123',
        GITHUB_EVENT_AFTER: 'after456',
      },
    }),
    ['scripts/ci/foo.mjs'],
  );
});

test('computeChangedFiles keeps merge-base diff on dev PRs', () => {
  const calls = [];
  const git = (args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return 'mb\n';
    if (args[0] === 'diff' && args.includes('--name-status')) return '';
    if (args[0] === 'diff') return 'flutter/packages/app_ui/lib/a.dart\n';
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  assert.deepEqual(
    computeChangedFiles({
      base: 'origin/dev',
      git,
      env: { GITHUB_BASE_REF: 'dev' },
    }),
    ['flutter/packages/app_ui/lib/a.dart'],
  );
  assert.equal(calls[0][0], 'merge-base');
});

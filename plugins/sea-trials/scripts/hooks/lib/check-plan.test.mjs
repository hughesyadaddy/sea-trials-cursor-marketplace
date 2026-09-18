import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DART_ANALYZE_TIMEOUT_MS,
  LANES,
  TASK_KIND,
  buildFlutterCheckPlan,
  isPromotionBaseRef,
  resolvePromotionBaseRef,
  selectTasksForLane,
} from './check-plan.mjs';

const REPO = '/repo';
const LINT = ['/repo/tools/sea-trials-lint/bin/sea-trials-lint'];

/** Packages the fake workspace knows about, longest-first for nesting. */
const PACKAGES = [
  'packages/app_ui/gallery',
  'packages/app_ui',
  'packages/api_client',
  'apps/client_app',
].sort((a, b) => b.length - a.length);

/**
 * Filesystem double. `missing` lists repo-relative paths that should
 * report as deleted so deletion handling can be exercised.
 */
function makeIo({ missing = [] } = {}) {
  const gone = new Set(missing.map((p) => `${REPO}/${p}`));
  return {
    exists: (absPath) => !gone.has(absPath),
    findNearestPubspec: (absPath) => {
      const rel = absPath.slice(`${REPO}/flutter/`.length);
      const pkg = PACKAGES.find(
        (p) => rel === p || rel.startsWith(`${p}/`),
      );
      return pkg ? `${REPO}/flutter/${pkg}/pubspec.yaml` : null;
    },
    listAllPackageDirs: () => [...PACKAGES].sort(),
  };
}

const plan = (changedFiles, opts = {}) =>
  buildFlutterCheckPlan({
    repoRoot: REPO,
    changedFiles,
    lintCmd: LINT,
    io: makeIo(opts),
    ...opts,
  });

const byKind = (tasks, kind) => tasks.filter((t) => t.kind === kind);

// ---------------------------------------------------------------------
// Concurrency weight
// ---------------------------------------------------------------------

test('planner never assigns concurrency weight', () => {
  // Weight is a caller decision. The hook serializes dart analyze so it
  // never runs two analysis servers against the IDE at once (that hung
  // full-package question_card for 18 min); CI has no IDE and should
  // parallelize. Baking a weight here would force one policy on both.
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  assert.ok(tasks.length > 0);
  for (const task of tasks) {
    assert.equal(
      Object.hasOwn(task, 'weight'),
      false,
      `${task.label} must not carry a weight`,
    );
  }
});

// ---------------------------------------------------------------------
// Timeout
// ---------------------------------------------------------------------

test('analyze tasks carry the 8-minute timeout by default', () => {
  // A dropped timeoutMs is invisible until a real analysis-server hang.
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  const analyze = byKind(tasks, TASK_KIND.ANALYZE);
  assert.ok(analyze.length > 0);
  assert.equal(DART_ANALYZE_TIMEOUT_MS, 8 * 60 * 1000);
  for (const task of analyze) {
    assert.equal(task.timeoutMs, DART_ANALYZE_TIMEOUT_MS);
  }
});

test('analyze timeout is overridable for callers with no IDE contention', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart'], {
    analyzeTimeoutMs: 120000,
  });
  assert.equal(byKind(tasks, TASK_KIND.ANALYZE)[0].timeoutMs, 120000);
});

// ---------------------------------------------------------------------
// Analyze scoping: the four branches
// ---------------------------------------------------------------------

test('branch 1: workspace-level change analyzes every package dir', () => {
  // A lock-only change can bump every resolved package version.
  const { tasks, meta } = plan(['flutter/pubspec.lock']);
  assert.equal(meta.workspaceLevel, true);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  for (const pkg of PACKAGES) assert.ok(paths.includes(pkg), `missing ${pkg}`);
});

test('branch 2: config-only change with no Dart files analyzes the package', () => {
  // Via lib/ rather than the bare dir: the bare dir pulls in test/, the
  // documented hang surface.
  const { tasks } = plan(['flutter/packages/app_ui/pubspec.yaml']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, ['packages/app_ui/lib']);
});

test('branch 3: config plus Dart files analyzes those files AND the package lib/', () => {
  // The lib/ superset catches dangling imports without pulling in the
  // full test/ context, which is what hung full-package analyze at 0%
  // CPU against the IDE server (user_repository, 2026-07-15).
  const { tasks } = plan([
    'flutter/packages/app_ui/pubspec.yaml',
    'flutter/packages/app_ui/lib/a.dart',
  ]);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.ok(paths.includes('packages/app_ui/lib/a.dart'));
  assert.ok(paths.includes('packages/app_ui/lib'));
  assert.equal(paths.includes('packages/app_ui'), false);
});

test('generated Dart is excluded from file-scoped analyze', () => {
  // Every package's analysis_options has `exclude: **/*.g.dart`, but
  // `dart analyze` honours exclude only when walking a DIRECTORY — a file
  // named explicitly on the command line is analyzed regardless. A file-scoped
  // run therefore reported issues the package-scoped run never would, and they
  // were unfixable by hand because the file is regenerated. Observed when
  // regenerating firestore_question.g.dart surfaced a pre-existing
  // deprecated_member_use on a field deliberately kept for old app versions.
  const { tasks } = plan([
    'flutter/packages/app_ui/lib/a.dart',
    'flutter/packages/app_ui/lib/a.g.dart',
    'flutter/packages/app_ui/lib/b.freezed.dart',
  ]);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, ['packages/app_ui/lib/a.dart']);
});

test('a package whose ONLY change is generated falls back to the package dir', () => {
  // Not "analyze nothing": the package is still taken, via lib/, where
  // `exclude` applies as intended. Dropping the file must not drop coverage.
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.g.dart']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, ['packages/app_ui/lib']);
});

test('branch 4: Dart-only change analyzes just the changed files', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, ['packages/app_ui/lib/a.dart']);
});

test('a deleted Dart file still queues its owning package', () => {
  // The old import path is gone, so unchanged consumers must be
  // re-checked or a dangling import slips through.
  const { tasks, meta } = plan(['flutter/packages/app_ui/lib/gone.dart'], {
    missing: ['flutter/packages/app_ui/lib/gone.dart'],
  });
  assert.deepEqual(meta.packages, ['packages/app_ui']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, ['packages/app_ui/lib']);
  // A deleted file cannot be formatted or linted.
  assert.equal(byKind(tasks, TASK_KIND.FORMAT).length, 0);
  assert.equal(byKind(tasks, TASK_KIND.LINT).length, 0);
});

// ---------------------------------------------------------------------
// Negative cases
// ---------------------------------------------------------------------

test('native platform code produces no analyze tasks', () => {
  // The old "no owning package -> analyze everything" fallback turned a
  // one-file AppDelegate.swift push into ~87 analysis servers
  // (2026-07-08, 5+ min freeze).
  const { tasks, meta } = plan([
    'flutter/apps/client_app/ios/Runner/AppDelegate.swift',
  ]);
  assert.equal(byKind(tasks, TASK_KIND.ANALYZE).length, 0);
  assert.deepEqual(meta.packages, []);
});

test('a docs-only change produces an empty plan', () => {
  const { tasks } = plan(['docs/runbooks/LINT_STAGES.md', 'README.md']);
  assert.deepEqual(tasks, []);
});

test('assets and SQL under flutter/ produce no analyze tasks', () => {
  const { tasks } = plan(['flutter/packages/app_ui/assets/logo.png']);
  assert.equal(byKind(tasks, TASK_KIND.ANALYZE).length, 0);
});

test('no lint tasks when no lint binary was resolved', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart'], {
    lintCmd: undefined,
  });
  assert.equal(byKind(tasks, TASK_KIND.LINT).length, 0);
  assert.ok(byKind(tasks, TASK_KIND.ANALYZE).length > 0);
});

// ---------------------------------------------------------------------
// Fail-closed
// ---------------------------------------------------------------------

test('an unavailable pubspec diff fails closed to a full analyze', () => {
  // null means `git diff` failed; guessing "tooling-only" there would
  // silently skip the whole workspace.
  const { meta } = plan(['flutter/pubspec.yaml'], { pubspecDiff: null });
  assert.equal(meta.workspaceLevel, true);
});

test('a tooling-only pubspec edit stays scoped', () => {
  // Context lines carry a leading space in a unified diff; the section
  // tracker relies on that to know which block a change sits in.
  const diff = [
    '@@ -1,3 +1,3 @@',
    ' dev_dependencies:',
    '-  melos: ^6.0.0',
    '+  melos: ^6.1.0',
  ].join('\n');
  const { meta } = plan(['flutter/pubspec.yaml'], { pubspecDiff: diff });
  assert.equal(meta.workspaceLevel, false);
});

// ---------------------------------------------------------------------
// Batching and path shape
// ---------------------------------------------------------------------

test('format and lint batch at 50 paths per invocation', () => {
  // One spawn with hundreds of paths exceeds the Windows command-line
  // limit (spawn ENAMETOOLONG).
  const files = Array.from(
    { length: 51 },
    (_, i) => `flutter/packages/app_ui/lib/f${i}.dart`,
  );
  const { tasks } = plan(files);
  const format = byKind(tasks, TASK_KIND.FORMAT);
  const lint = byKind(tasks, TASK_KIND.LINT);
  assert.equal(format.length, 2);
  assert.equal(lint.length, 2);
  // 4 fixed leading args on format: --output none --set-exit-if-changed
  assert.equal(format[0].args.length - 4, 50);
  assert.equal(format[1].args.length - 4, 1);
});

test('path shape differs per command family', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);

  // dart format: flutter-relative, run from flutter/
  const format = byKind(tasks, TASK_KIND.FORMAT)[0];
  assert.equal(format.options.cwd, '/repo/flutter');
  assert.ok(format.args.includes('packages/app_ui/lib/a.dart'));

  // dart analyze: flutter-relative, run from flutter/
  const analyze = byKind(tasks, TASK_KIND.ANALYZE)[0];
  assert.equal(analyze.options.cwd, '/repo/flutter');
  assert.ok(analyze.args.includes('packages/app_ui/lib/a.dart'));

  // sea-trials-lint: ABSOLUTE paths, with an explicit --root
  const lint = byKind(tasks, TASK_KIND.LINT)[0];
  assert.equal(lint.cmd, LINT[0]);
  assert.deepEqual(lint.args.slice(0, 3), ['check', '--root', '/repo/flutter']);
  assert.ok(lint.args.includes('/repo/flutter/packages/app_ui/lib/a.dart'));
});

test('nested workspace packages resolve to the innermost package', () => {
  const { meta } = plan(['flutter/packages/app_ui/gallery/lib/g.dart']);
  assert.deepEqual(meta.packages, ['packages/app_ui/gallery']);
});

// ---------------------------------------------------------------------
// Lane selection
// ---------------------------------------------------------------------

test('lanes partition the plan with no task left behind', () => {
  const { tasks } = plan([
    'flutter/packages/app_ui/pubspec.yaml',
    'flutter/packages/app_ui/lib/a.dart',
    'flutter/packages/api_client/lib/b.dart',
  ]);
  assert.ok(tasks.length > 0);

  const selected = Object.keys(LANES).flatMap((lane) =>
    selectTasksForLane(tasks, lane),
  );
  assert.equal(
    selected.length,
    tasks.length,
    'every task must belong to exactly one lane',
  );
  assert.deepEqual(new Set(selected), new Set(tasks));
});

test('every task kind is covered by some lane', () => {
  const covered = new Set(Object.values(LANES).flat());
  for (const kind of Object.values(TASK_KIND)) {
    assert.ok(covered.has(kind), `no lane runs '${kind}' tasks`);
  }
});

test('an unknown lane throws instead of silently selecting nothing', () => {
  // A silently empty lane is a green check that verified nothing.
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  assert.throws(
    () => selectTasksForLane(tasks, 'typo-lane'),
    /Unknown lane 'typo-lane'/,
  );
});

// ---------------------------------------------------------------------
// Test tasks
// ---------------------------------------------------------------------

test('emits one very_good test task per package that has tests', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart'], {
    testPackageDirs: ['packages/app_ui', 'packages/api_client'],
  });
  const tests = byKind(tasks, TASK_KIND.TEST);
  assert.equal(tests.length, 2);
  assert.equal(tests[0].cmd, 'very_good');
  // No --fail-fast: the lane must name every failing package, not just
  // the first one to break. `-x presubmit-only` mirrors what client_app's
  // workflow and tool/coverage.sh already pass, so the lane cannot run
  // tests that are excluded everywhere else.
  assert.deepEqual(tests[0].args, [
    'test',
    '-j',
    '4',
    '-x',
    'presubmit-only',
  ]);
  assert.ok(
    !tests[0].args.includes('--fail-fast'),
    'lane must name every failing package',
  );
  assert.equal(tests[0].options.cwd, '/repo/flutter/packages/app_ui');
});

test('skips packages that have no test directory', () => {
  const io = makeIo();
  const base = io.exists;
  io.exists = (p) => (p.endsWith('/packages/api_client/test') ? false : base(p));

  const { tasks } = buildFlutterCheckPlan({
    repoRoot: REPO,
    changedFiles: ['flutter/packages/app_ui/lib/a.dart'],
    testPackageDirs: ['packages/app_ui', 'packages/api_client'],
    io,
  });

  const tests = byKind(tasks, TASK_KIND.TEST);
  assert.equal(tests.length, 1);
  assert.match(tests[0].label, /packages\/app_ui/);
});

test('emits no test tasks when no package set is supplied', () => {
  // The other lanes must not accidentally spawn the test suite.
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  assert.equal(byKind(tasks, TASK_KIND.TEST).length, 0);
});

test('the test lane selects only test tasks', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart'], {
    testPackageDirs: ['packages/app_ui'],
  });
  const kinds = new Set(selectTasksForLane(tasks, 'test').map((t) => t.kind));
  assert.deepEqual(kinds, new Set([TASK_KIND.TEST]));
});

test('the static lane carries format and lint but never analyze', () => {
  const { tasks } = plan(['flutter/packages/app_ui/lib/a.dart']);
  const kinds = new Set(
    selectTasksForLane(tasks, 'static').map((t) => t.kind),
  );
  assert.deepEqual(kinds, new Set([TASK_KIND.FORMAT, TASK_KIND.LINT]));
});

// ---------------------------------------------------------------------
// Workspace fan-out cap
// ---------------------------------------------------------------------

test('the hook still fans out to every package on a workspace-level change', () => {
  // A developer's machine has no lane cap and wants the full blast radius.
  const { tasks, meta } = plan(['flutter/pubspec.lock']);
  assert.equal(meta.workspaceLevel, true);
  assert.equal(meta.fanOutSuppressed, false);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  for (const pkg of PACKAGES) assert.ok(paths.includes(pkg), `missing ${pkg}`);
});

test('CI caps the fan-out and says so in the metadata', () => {
  // A shared-dependency PR would otherwise queue ~11 full-package analyze
  // chunks plus ~80 test processes inside a 30/45-minute lane cap. The
  // whole-tree audit owns whole-workspace assurance instead.
  const { tasks, meta } = plan(['flutter/pubspec.lock'], {
    allowFullWorkspace: false,
  });
  assert.equal(meta.workspaceLevel, true, 'classification is unchanged');
  assert.equal(meta.fanOutSuppressed, true, 'but the fan-out is capped');
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.equal(
    paths.length,
    0,
    'a lock-only diff owns no package, so nothing to analyze',
  );
});

test('capping the fan-out still analyzes the packages that did change', () => {
  const { tasks, meta } = plan(
    ['flutter/pubspec.lock', 'flutter/packages/app_ui/lib/a.dart'],
    { allowFullWorkspace: false },
  );
  assert.equal(meta.fanOutSuppressed, true);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.deepEqual(paths, ['packages/app_ui/lib/a.dart']);
  // Emphatically not the whole workspace.
  assert.equal(paths.includes('packages/api_client'), false);
});

test('fanOutSuppressed is false when the diff was never workspace-level', () => {
  const { meta } = plan(['flutter/packages/app_ui/lib/a.dart'], {
    allowFullWorkspace: false,
  });
  assert.equal(meta.workspaceLevel, false);
  assert.equal(meta.fanOutSuppressed, false);
});

test('an omitted pubspec diff fails closed, like an explicit null', () => {
  // The default used to be '', which reads as "no graph-affecting change"
  // and let a caller that simply forgot the diff skip workspace analysis.
  const { meta } = buildFlutterCheckPlan({
    repoRoot: REPO,
    changedFiles: ['flutter/pubspec.yaml'],
    io: makeIo(),
  });
  assert.equal(meta.workspaceLevel, true);
});

test("an explicit '' still asserts there was no graph change", () => {
  const { meta } = plan(['flutter/pubspec.yaml'], { pubspecDiff: '' });
  assert.equal(meta.workspaceLevel, false);
});

test('the representative sample analyzes lib/, not the package root', () => {
  // Pulling test/ into a full-package analyze is what hangs the analysis
  // server at 0% CPU (user_repository, 2026-07-15). The sample must not
  // reintroduce that surface for a dozen packages at once.
  const { tasks } = plan(['flutter/pubspec.lock'], {
    allowFullWorkspace: false,
    extraPackageDirs: ['packages/app_ui', 'packages/api_client'],
  });
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.ok(paths.includes('packages/app_ui/lib'));
  assert.ok(paths.includes('packages/api_client/lib'));
  assert.equal(paths.includes('packages/app_ui'), false, 'no bare root');
});

test('a sampled package without lib/ falls back to the package dir', () => {
  const io = makeIo();
  const base = io.exists;
  io.exists = (p) => (p.endsWith('/packages/api_client/lib') ? false : base(p));

  const { tasks } = buildFlutterCheckPlan({
    repoRoot: REPO,
    changedFiles: ['flutter/pubspec.lock'],
    allowFullWorkspace: false,
    extraPackageDirs: ['packages/api_client'],
    io,
  });

  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.ok(paths.includes('packages/api_client'));
});

// ---------------------------------------------------------------------
// Package-level analyze targets
// ---------------------------------------------------------------------

test('a config-only change analyzes lib/, not the bare package dir', () => {
  // The bare dir pulls in test/ — the surface that hung full-package
  // analyze at 0% CPU (user_repository, 2026-07-15). The .arb case is
  // exactly what this redesign set out to unblock, so it must not take
  // the hang-prone path.
  const { tasks } = plan(['flutter/packages/app_ui/lib/src/arb/app_en.arb']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.deepEqual(paths, ['packages/app_ui/lib']);
});

test('a deletion paired with an edit still re-checks the package', () => {
  // The file-scoped branch analyzed only the surviving file, so an
  // untouched sibling still importing the removed path went unchecked —
  // contradicting this module's own deletion contract, which held only
  // for deletion-only diffs.
  const { tasks } = plan(
    [
      'flutter/packages/app_ui/lib/gone.dart',
      'flutter/packages/app_ui/lib/kept.dart',
    ],
    { missing: ['flutter/packages/app_ui/lib/gone.dart'] },
  );
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.ok(paths.includes('packages/app_ui/lib/kept.dart'));
  assert.ok(paths.includes('packages/app_ui/lib'), 'package must be re-checked');
});

test('an ordinary edit stays file-scoped', () => {
  // The deletion fix must not turn every edit into a package analyze —
  // file-scoping is what keeps the lane bounded.
  const { tasks } = plan(['flutter/packages/app_ui/lib/kept.dart']);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.deepEqual(paths, ['packages/app_ui/lib/kept.dart']);
});

test('a package without lib/ falls back to the package dir', () => {
  const io = makeIo();
  const base = io.exists;
  io.exists = (p) => (p.endsWith('/packages/app_ui/lib') ? false : base(p));

  const { tasks } = buildFlutterCheckPlan({
    repoRoot: REPO,
    changedFiles: ['flutter/packages/app_ui/pubspec.yaml'],
    io,
  });

  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) => t.args.slice(2));
  assert.deepEqual(paths, ['packages/app_ui']);
});

test('artifact paths are excluded from format, lint, and analyze', () => {
  const artifact =
    'flutter/packages/ai_assistant/b/native_assets/macos/foo.dart';
  const { tasks } = plan([artifact, 'flutter/packages/app_ui/lib/a.dart']);

  assert.equal(byKind(tasks, TASK_KIND.FORMAT).length, 1);
  assert.equal(byKind(tasks, TASK_KIND.LINT).length, 1);
  assert.equal(byKind(tasks, TASK_KIND.ANALYZE).length, 1);

  const formatPaths = byKind(tasks, TASK_KIND.FORMAT).flatMap((t) => t.args.slice(4));
  assert.deepEqual(formatPaths, ['packages/app_ui/lib/a.dart']);

  const lintPaths = byKind(tasks, TASK_KIND.LINT).flatMap((t) => t.args.slice(3));
  assert.equal(lintPaths.length, 1);
  assert.ok(lintPaths[0].endsWith('packages/app_ui/lib/a.dart'));
});

// ---------------------------------------------------------------------
// Promotion PR analyze cap
// ---------------------------------------------------------------------

test('isPromotionBaseRef accepts origin-prefixed and bare trunk refs', () => {
  assert.equal(isPromotionBaseRef('origin/stg'), true);
  assert.equal(isPromotionBaseRef('stg'), true);
  assert.equal(isPromotionBaseRef('origin/main'), true);
  assert.equal(isPromotionBaseRef('main'), true);
  assert.equal(isPromotionBaseRef('origin/dev'), false);
  assert.equal(isPromotionBaseRef('dev'), false);
});

test('resolvePromotionBaseRef prefers explicit --base over env', () => {
  assert.equal(
    resolvePromotionBaseRef({
      base: 'origin/dev',
      env: { GITHUB_BASE_REF: 'stg' },
    }),
    null,
  );
  assert.equal(
    resolvePromotionBaseRef({
      base: 'origin/stg',
      env: { GITHUB_BASE_REF: 'dev' },
    }),
    'stg',
  );
  assert.equal(
    resolvePromotionBaseRef({
      env: { GITHUB_BASE_REF: 'stg' },
    }),
    'stg',
  );
  assert.equal(
    resolvePromotionBaseRef({
      base: 'origin/dev',
      env: {},
    }),
    null,
  );
});

test('promotion override analyzes lib/ only, not every changed file', () => {
  const changed = [
    'flutter/packages/app_ui/lib/a.dart',
    'flutter/packages/app_ui/lib/b.dart',
    'flutter/packages/api_client/lib/c.dart',
    'flutter/packages/api_client/lib/d.dart',
  ];
  const { tasks, meta } = plan(changed, {
    analyzePackageDirsOverride: ['packages/app_ui', 'packages/api_client'],
  });

  assert.equal(meta.promotionAnalyzeCap, true);
  const paths = byKind(tasks, TASK_KIND.ANALYZE).flatMap((t) =>
    t.args.slice(2),
  );
  assert.deepEqual(paths, [
    'packages/api_client/lib',
    'packages/app_ui/lib',
  ]);
  assert.equal(paths.includes('packages/app_ui/lib/a.dart'), false);
  assert.equal(byKind(tasks, TASK_KIND.FORMAT).length, 1);
});

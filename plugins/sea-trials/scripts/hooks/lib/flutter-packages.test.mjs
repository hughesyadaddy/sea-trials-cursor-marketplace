import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isFlutterWorkspaceLevelChange,
  isDartAnalyzeRelevant,
  needsFullFlutterPackageAnalyze,
  pubspecDiffAffectsPackageGraph,
  buildMergedAnalyzeChunks,
} from './flutter-packages.mjs';

// ===========================================================================
// isFlutterWorkspaceLevelChange — files whose change can alter analyzer
// output for packages nobody touched.
// ===========================================================================

test('workspace-level: a CI workflow edit does NOT trigger a full sweep', () => {
  // It used to, mirroring a `dart-analyze` job's paths: filter. That job
  // is gone and pr-checks.yml declares no paths: filters, so the only
  // remaining effect was an 87-package sweep on every CI-config edit —
  // inside a PR budget that cannot hold one.
  assert.equal(
    isFlutterWorkspaceLevelChange('.github/workflows/pr-checks.yml'),
    false,
  );
});

test('workspace-level: root pubspec/lock/melos trigger', () => {
  for (const p of [
    'flutter/pubspec.yaml',
    'flutter/pubspec.lock',
    'flutter/melos.yaml',
  ]) {
    assert.equal(isFlutterWorkspaceLevelChange(p), true, p);
  }
});

test('workspace-level: root analysis_options does NOT trigger', () => {
  // Package analyze never loads the workspace-root options file.
  assert.equal(
    isFlutterWorkspaceLevelChange('flutter/analysis_options.yaml'),
    false,
  );
});

test('workspace-level: shared_deps and sea_trials_lints trigger', () => {
  assert.equal(
    isFlutterWorkspaceLevelChange(
      'flutter/packages/shared_deps/pubspec.yaml',
    ),
    true,
  );
  assert.equal(
    isFlutterWorkspaceLevelChange(
      'flutter/packages/sea_trials_lints/lib/src/rules.dart',
    ),
    true,
  );
});

test('workspace-level: ordinary package files do NOT trigger', () => {
  for (const p of [
    'flutter/packages/app_ui/lib/src/widgets/app_button.dart',
    'flutter/apps/client_app/pubspec.yaml',
    'flutter/apps/client_app/lib/main/run_client_app.dart',
  ]) {
    assert.equal(isFlutterWorkspaceLevelChange(p), false, p);
  }
});

// Regression (2026-07-08): a one-file AppDelegate.swift push queued
// ~87 dart analyze servers because native files mapped to no package
// and the old fallback treated an empty package set as a
// workspace-level change. Native code must never fan out.
test('workspace-level: native platform files do NOT trigger', () => {
  assert.equal(
    isFlutterWorkspaceLevelChange(
      'flutter/apps/client_app/ios/Runner/AppDelegate.swift',
    ),
    false,
  );
});

// ===========================================================================
// isDartAnalyzeRelevant — only files that can change analyzer output.
// ===========================================================================

test('analyze-relevant: dart, pubspec, arb, analysis/build config', () => {
  for (const p of [
    'flutter/packages/app_ui/lib/src/widgets/app_button.dart',
    'flutter/apps/client_app/pubspec.yaml',
    'flutter/packages/l10n/lib/src/arb/app_en.arb',
    'flutter/packages/app_ui/analysis_options.yaml',
    'flutter/packages/cache_client/build.yaml',
    'flutter/packages/l10n/l10n.yaml',
  ]) {
    assert.equal(isDartAnalyzeRelevant(p), true, p);
  }
});

test('analyze-relevant: native, assets, and docs are NOT', () => {
  for (const p of [
    'flutter/apps/client_app/ios/Runner/AppDelegate.swift',
    'flutter/apps/client_app/ios/Podfile',
    'flutter/apps/client_app/android/app/src/main/AndroidManifest.xml',
    'flutter/apps/client_app/assets/images/logo.png',
    'flutter/packages/app_ui/README.md',
    'flutter/apps/client_app/ios/Runner/Info.plist',
  ]) {
    assert.equal(isDartAnalyzeRelevant(p), false, p);
  }
});

// ===========================================================================
// needsFullFlutterPackageAnalyze / pubspecDiffAffectsPackageGraph
// ===========================================================================

test('pubspecDiffAffectsPackageGraph: tooling-only is false', () => {
  const diff = `
diff --git a/flutter/pubspec.yaml b/flutter/pubspec.yaml
--- a/flutter/pubspec.yaml
+++ b/flutter/pubspec.yaml
@@ -98,6 +98,7 @@ workspace:
   - apps/client_app
 
 dev_dependencies:
+  ft_patch_package: ^1.0.1
   melos: ^7.1.0
`;
  assert.equal(pubspecDiffAffectsPackageGraph(diff), false);
});

test('pubspecDiffAffectsPackageGraph: workspace member change is true', () => {
  const diff = `
--- a/flutter/pubspec.yaml
+++ b/flutter/pubspec.yaml
@@ -10,6 +10,7 @@
 workspace:
   - packages/app_ui
+  - packages/new_pkg
`;
  assert.equal(pubspecDiffAffectsPackageGraph(diff), true);
});

test('pubspecDiffAffectsPackageGraph: item-only hunk fails closed', () => {
  // No section header in the hunk — typical for mid-list workspace
  // or dependency_overrides edits far below their keys.
  const diff = `
--- a/flutter/pubspec.yaml
+++ b/flutter/pubspec.yaml
@@ -80,6 +80,7 @@
   - packages/app_ui
   - packages/api_client
+  - packages/new_pkg
   - packages/l10n
`;
  assert.equal(pubspecDiffAffectsPackageGraph(diff), true);
});

test('needsFull: tooling-only pubspec+lock stays scoped', () => {
  // Context lines use a leading space (unified-diff marker).
  const toolingOnlyDiff = [
    'diff --git a/flutter/pubspec.yaml b/flutter/pubspec.yaml',
    '--- a/flutter/pubspec.yaml',
    '+++ b/flutter/pubspec.yaml',
    '@@ -98,4 +98,5 @@',
    ' dev_dependencies:',
    '+  ft_patch_package: ^1.0.1',
    ' melos: ^7.1.0',
  ].join('\n');

  assert.equal(
    needsFullFlutterPackageAnalyze(
      [
        'flutter/pubspec.yaml',
        'flutter/pubspec.lock',
        'flutter/packages/api_client/api_client/lib/src/foo.dart',
      ],
      { pubspecDiff: toolingOnlyDiff },
    ),
    false,
  );
});

test('needsFull: missing pubspecDiff fails closed', () => {
  assert.equal(
    needsFullFlutterPackageAnalyze(['flutter/pubspec.yaml'], {
      pubspecDiff: null,
    }),
    true,
  );
});

test('needsFull: shared_deps always full', () => {
  assert.equal(
    needsFullFlutterPackageAnalyze([
      'flutter/packages/shared_deps/pubspec.yaml',
    ]),
    true,
  );
});

test('needsFull: lock-only is full', () => {
  assert.equal(
    needsFullFlutterPackageAnalyze(['flutter/pubspec.lock']),
    true,
  );
});

// ===========================================================================
// buildMergedAnalyzeChunks — one dart analyze process for many
// packages instead of one cold VM + analysis server per package
// (18 serialized spawns ≈ 8 min of startup, observed 2026-07-15).
// ===========================================================================

test('mergedChunks: many small packages collapse into one chunk', () => {
  const chunks = buildMergedAnalyzeChunks({
    fileGroups: [
      ['packages/a/lib/a.dart', 'packages/a/lib/b.dart'],
      ['packages/b/lib/c.dart'],
      ['packages/c/lib/d.dart', 'packages/c/test/d_test.dart'],
    ],
  });
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].fileCount, 5);
  assert.equal(chunks[0].dirCount, 0);
  assert.deepEqual(chunks[0].paths, [
    'packages/a/lib/a.dart',
    'packages/a/lib/b.dart',
    'packages/b/lib/c.dart',
    'packages/c/lib/d.dart',
    'packages/c/test/d_test.dart',
  ]);
});

test('mergedChunks: package dirs cost more than files', () => {
  // 8 dirs * cost 5 = 40 → exactly one chunk; a 9th dir spills.
  const dirs = Array.from({ length: 9 }, (_, i) => `packages/p${i}`);
  const chunks = buildMergedAnalyzeChunks({ dirPaths: dirs });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].dirCount, 8);
  assert.equal(chunks[1].dirCount, 1);
});

test('mergedChunks: files spill into a second chunk at chunkSize', () => {
  const files = Array.from({ length: 45 }, (_, i) => [`p/lib/f${i}.dart`]);
  const chunks = buildMergedAnalyzeChunks({ fileGroups: files });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].fileCount, 40);
  assert.equal(chunks[1].fileCount, 5);
});

test('mergedChunks: empty input produces no chunks', () => {
  assert.deepEqual(buildMergedAnalyzeChunks({}), []);
});

test('mergedChunks: single over-budget dir still gets a chunk', () => {
  const chunks = buildMergedAnalyzeChunks({
    dirPaths: ['packages/huge'],
    chunkSize: 2,
    dirCost: 5,
  });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0].paths, ['packages/huge']);
});

test('pubspec diff: a later graph-affecting hunk is not masked by an earlier one', () => {
  // Section state used to carry across `@@` boundaries, so a tooling-only
  // dev_dependencies bump in hunk 1 classified hunk 2's changes as
  // tooling-only too. With the root pubspec owning no package, that let
  // both lanes schedule zero validation for a real graph change.
  const diff = [
    '@@ -40,7 +40,7 @@',
    ' dev_dependencies:',
    '-  melos: ^6.0.0',
    '+  melos: ^6.1.0',
    '@@ -90,7 +90,7 @@',
    '   some_nested_key: value',
    '-  xml: ^6.5.0',
    '+  xml: ^6.6.0',
  ].join('\n');
  assert.equal(pubspecDiffAffectsPackageGraph(diff), true);
});

test('pubspec diff: a single tooling-only hunk still stays scoped', () => {
  // The reset must not make everything fail closed — that would restore
  // the 87-package storm on every melos bump.
  const diff = [
    '@@ -40,7 +40,7 @@',
    ' dev_dependencies:',
    '-  melos: ^6.0.0',
    '+  melos: ^6.1.0',
  ].join('\n');
  assert.equal(pubspecDiffAffectsPackageGraph(diff), false);
});

test('pubspec diff: consecutive tooling-only hunks stay scoped', () => {
  const diff = [
    '@@ -40,6 +40,6 @@',
    ' dev_dependencies:',
    '-  melos: ^6.0.0',
    '+  melos: ^6.1.0',
    '@@ -60,6 +60,6 @@',
    ' dev_dependencies:',
    '-  ft_patch_package: ^1.0.0',
    '+  ft_patch_package: ^1.1.0',
  ].join('\n');
  assert.equal(pubspecDiffAffectsPackageGraph(diff), false);
});

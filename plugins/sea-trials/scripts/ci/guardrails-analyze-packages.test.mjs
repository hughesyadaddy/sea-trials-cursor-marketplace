import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildMergedAnalyzeChunks } from '../hooks/lib/flutter-packages.mjs';
import {
  GUARDRAILS_ANALYZE_CHUNK_SIZE,
  GUARDRAILS_ANALYZE_CONCURRENCY,
  GUARDRAILS_ANALYZE_WEIGHT,
  guardrailsAnalyzeTargets,
  packageDirOfTarget,
  parseShardArgs,
  resolveDartExecutable,
  resolveFlutterRoot,
  shardSlice,
} from './guardrails-analyze-packages.mjs';

test('the whole tree packs into few chunks, not one spawn per package', () => {
  // 88 per-package `dart analyze` spawns cost ~346s in CI and gained
  // nothing from `xargs -P` — the cost is analysis-server cold starts,
  // so the fix is fewer servers, not more concurrency.
  const targets = Array.from({ length: 171 }, (_, i) => `packages/p${i}/lib`);
  const chunks = buildMergedAnalyzeChunks({
    dirPaths: targets,
    chunkSize: GUARDRAILS_ANALYZE_CHUNK_SIZE,
  });
  assert.ok(
    chunks.length <= 6,
    `expected <=6 chunks for 171 targets, got ${chunks.length}`,
  );
  assert.equal(
    chunks.reduce((sum, c) => sum + c.dirCount, 0),
    171,
    'every target must land in exactly one chunk',
  );
});

/**
 * A throwaway Flutter-workspace layout. The plugin's tests never read
 * the app repo, so the shape under test is built here.
 *
 * @param {string[]} dirs workspace-relative directories to create
 */
function fixtureWorkspace(dirs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-'));
  fs.mkdirSync(path.join(root, 'flutter'));
  fs.writeFileSync(
    path.join(root, 'flutter/pubspec.yaml'),
    'name: workspace\nworkspace:\n  - packages/app_ui\n',
  );
  for (const dir of dirs) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  return root;
}

test('audit targets cover test/ and tool/, not just lib/', () => {
  // The audit is the whole-tree backstop. Narrowing to `lib/` (what the
  // PR lanes do) would stop auditing every test/ and tool/ file in the
  // workspace while still reporting green.
  const root = fixtureWorkspace([
    'flutter/packages/app_ui/lib',
    'flutter/packages/app_ui/test',
    'flutter/packages/app_ui/tool',
  ]);
  try {
    const targets = guardrailsAnalyzeTargets(root, 'flutter/packages/app_ui');
    assert.ok(targets.includes('flutter/packages/app_ui/lib'));
    assert.ok(
      targets.includes('flutter/packages/app_ui/test'),
      `expected test/ in targets, got ${targets.join(', ')}`,
    );
    assert.ok(
      targets.includes('flutter/packages/app_ui/tool'),
      `expected tool/ in targets, got ${targets.join(', ')}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failures are reported against the package, not the subdir', () => {
  // report-audit-failure.mjs lists these verbatim in the tracking issue.
  assert.equal(packageDirOfTarget('packages/foo/test'), 'packages/foo');
  assert.equal(packageDirOfTarget('packages/foo/lib'), 'packages/foo');
  assert.equal(packageDirOfTarget('packages/foo/tool'), 'packages/foo');
  assert.equal(packageDirOfTarget('packages/foo'), 'packages/foo');
});

test('dart resolves via FLUTTER_ROOT, falling back to PATH', () => {
  // Node's spawn does not find `dart` on PATH in the audit job, and a
  // workflow-level `PATH:` override truncated PATH so badly that node,
  // git and xargs all vanished. Resolve the SDK path instead.
  const prev = process.env.FLUTTER_ROOT;

  delete process.env.FLUTTER_ROOT;
  assert.equal(resolveDartExecutable(), 'dart');

  process.env.FLUTTER_ROOT = '/nonexistent/flutter';
  assert.equal(resolveDartExecutable(), 'dart');

  if (prev === undefined) delete process.env.FLUTTER_ROOT;
  else process.env.FLUTTER_ROOT = prev;
});

test('resolveFlutterRoot rejects a path that is not the workspace root', () => {
  // `spawn` reports ENOENT for a nonexistent cwd, which reads as a
  // missing `dart`; and every subdir probe misses silently, collapsing
  // 171 targets to 88 bare package roots while still reporting green.
  const root = fixtureWorkspace(['flutter/flutter']);
  try {
    assert.throws(
      () => resolveFlutterRoot(path.join(root, 'flutter/flutter')),
      /not the Flutter workspace root/,
    );
    assert.equal(
      resolveFlutterRoot(path.join(root, 'flutter')),
      path.join(root, 'flutter'),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the concurrency budget admits more than one analyzer', () => {
  // The private-repo runner reports 2 vCPUs, so the usual
  // `max(os.cpus().length, 2)` budget against weight 2 admitted exactly
  // one task and the audit ran strictly sequentially (255s, run
  // 33027001586). Deriving the budget from os.cpus() reintroduces that.
  const budget = GUARDRAILS_ANALYZE_WEIGHT * GUARDRAILS_ANALYZE_CONCURRENCY;
  assert.ok(
    GUARDRAILS_ANALYZE_CONCURRENCY >= 2,
    'audit must keep at least two analysis servers in flight',
  );
  assert.ok(
    budget >= GUARDRAILS_ANALYZE_WEIGHT * 2,
    `budget ${budget} serializes weight-${GUARDRAILS_ANALYZE_WEIGHT} tasks`,
  );
});

test('shards partition the package list exactly once each', () => {
  const pkgs = Array.from({ length: 88 }, (_, i) => `packages/p${i}`);
  const total = 4;
  const slices = [1, 2, 3, 4].map((s) => shardSlice(pkgs, s, total));

  const seen = slices.flat();
  assert.equal(seen.length, pkgs.length, 'every package audited once');
  assert.deepEqual(
    [...new Set(seen)].sort(),
    [...pkgs].sort(),
    'no package dropped or double-audited',
  );
  for (const slice of slices) {
    assert.ok(slice.length >= 22 && slice.length <= 23, 'balanced');
  }
});

test('shardSlice rejects an out-of-range shard', () => {
  assert.throws(() => shardSlice([1, 2, 3], 0, 2), /invalid shard/);
  assert.throws(() => shardSlice([1, 2, 3], 3, 2), /invalid shard/);
  assert.throws(() => shardSlice([1, 2, 3], 1.5, 2), /must be integers/);
});

test('shard args parse, defaulting to the whole tree', () => {
  assert.deepEqual(parseShardArgs([]), {
    shard: 1,
    shardTotal: 1,
    packageDirs: undefined,
  });
  assert.deepEqual(parseShardArgs(['--shard', '3', '--shard-total', '4']), {
    shard: 3,
    shardTotal: 4,
    packageDirs: undefined,
  });
  assert.deepEqual(
    parseShardArgs([
      '--shard',
      '2',
      '--shard-total',
      '4',
      '--packages',
      'packages/foo,apps/client_app',
    ]),
    {
      shard: 2,
      shardTotal: 4,
      packageDirs: ['packages/foo', 'apps/client_app'],
    },
  );
});

test('an empty shard slice exits cleanly for PR analyze', async () => {
  const { runGuardrailsAnalyzePackages } = await import(
    './guardrails-analyze-packages.mjs'
  );
  const pkgs = Array.from({ length: 3 }, (_, i) => `packages/p${i}`);
  const root = fixtureWorkspace([]);
  try {
    const result = await runGuardrailsAnalyzePackages({
      flutterCwd: path.join(root, 'flutter'),
      packageDirsOverride: pkgs,
      shard: 4,
      shardTotal: 4,
    });
    assert.equal(result.packageCount, 0);
    assert.equal(result.chunkCount, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { emptyPassCache, recordPassed } from './pass-cache.mjs';
import {
  BOOTSTRAP_RESERVE_SECONDS,
  FAT_BASELINE_SECONDS,
  FAT_PACKAGE_DIRS,
  MAX_SHARD_SECONDS,
  MAX_SHARD_TEST_SECONDS,
  maxShardEstimatedSeconds,
} from './test-shard-timing.mjs';
import {
  GIT_STDOUT_MAX_BUFFER,
  MAX_SHARDS,
  aggregateDartTestResult,
  assignTestShards,
  filterPackagesWithTests,
  githubMatrix,
  hashPackagesFromLsFiles,
  nextPassCache,
  parseAggregateArgs,
  planTestShards,
} from './test-shards.mjs';

const alwaysTest = () => true;

/** Uniform small-package estimate for count-style fixtures. */
const smallEstimate = () => 45;

/** @param {string} dir */
function defaultEstimate(dir) {
  if (FAT_PACKAGE_DIRS.includes(dir)) {
    return FAT_BASELINE_SECONDS[dir];
  }
  return smallEstimate();
}

/** @param {string[][]} shards */
function assertWithinBudget(shards, estimateSeconds = defaultEstimate) {
  for (const shard of shards) {
    const total = shard.reduce((sum, dir) => sum + estimateSeconds(dir), 0);
    const fatOnly =
      shard.length === 1 && FAT_PACKAGE_DIRS.includes(shard[0]);
    const limit = fatOnly ? MAX_SHARD_SECONDS : MAX_SHARD_TEST_SECONDS;
    assert.ok(
      total <= limit,
      `shard [${shard.join(', ')}] estimated ${total}s exceeds ${limit}s`,
    );
  }
}

test('1–3 non-fat packages assign to exactly 1 shard', () => {
  const opts = { estimateSeconds: smallEstimate };
  const one = assignTestShards(['packages/a'], opts);
  assert.equal(one.shards.length, 1);
  assert.deepEqual(one.shards[0], ['packages/a']);

  const three = assignTestShards(['packages/c', 'packages/a', 'packages/b'], opts);
  assert.equal(three.shards.length, 1);
  assert.deepEqual(three.shards[0].sort(), ['packages/a', 'packages/b', 'packages/c']);
});

test('5 non-fat packages bin-pack by estimated duration', () => {
  const dirs = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const estimateSeconds = () => 90;
  const { shards } = assignTestShards(dirs, { estimateSeconds });
  assert.ok(shards.length >= 2);
  assert.deepEqual(shards.flat().sort(), [...dirs].sort());
  assertWithinBudget(shards, estimateSeconds);
  const seen = new Set();
  for (const dir of shards.flat()) {
    assert.equal(seen.has(dir), false, `duplicate ${dir}`);
    seen.add(dir);
  }
});

test('heavy small packages spread across multiple shards', () => {
  const estimateSeconds = (dir) => (dir === 'packages/heavy' ? 200 : 30);
  const { shards } = assignTestShards(
    ['packages/heavy', 'packages/a', 'packages/b', 'packages/c'],
    { estimateSeconds },
  );
  assert.equal(shards.find((s) => s.includes('packages/heavy'))?.length, 1);
  assert.ok(shards.length >= 2);
  assertWithinBudget(shards, estimateSeconds);
});

test('tiny PR stays on one shard when total time fits', () => {
  const { shards } = assignTestShards(['packages/a', 'packages/b'], {
    estimateSeconds: () => 60,
  });
  assert.equal(shards.length, 1);
});

test('2 small + 1 fat → fat isolated on its own shard', () => {
  const { shards } = assignTestShards(
    ['packages/a', 'packages/b', 'apps/client_app'],
    { estimateSeconds: defaultEstimate },
  );
  assert.equal(shards.length, 2);
  const fat = shards.find((s) => s.includes('apps/client_app'));
  assert.deepEqual(fat, ['apps/client_app']);
  assert.deepEqual(shards.flat().sort(), ['apps/client_app', 'packages/a', 'packages/b']);
});

test('1 fat only uses a single shard', () => {
  const { shards } = assignTestShards(['apps/client_app'], {
    estimateSeconds: defaultEstimate,
  });
  assert.equal(shards.length, 1);
  assert.deepEqual(shards[0], ['apps/client_app']);
});

test('1 fat + 40 small → fat isolated; union is the input', () => {
  const small = Array.from({ length: 40 }, (_, i) => `packages/p${i}`);
  const dirs = ['apps/client_app', ...small];
  const { shards } = assignTestShards(dirs, { estimateSeconds: defaultEstimate });
  const fat = shards.find((s) => s.includes('apps/client_app'));
  assert.deepEqual(fat, ['apps/client_app']);
  assert.deepEqual(shards.flat().sort(), [...dirs].sort());
  assertWithinBudget(shards);
  const seen = new Set();
  for (const dir of shards.flat()) {
    assert.equal(seen.has(dir), false);
    seen.add(dir);
  }
});

test('3 fat + 73 small → fat isolated; duration budget respected', () => {
  const small = Array.from({ length: 73 }, (_, i) => `packages/p${i}`);
  const dirs = [...FAT_PACKAGE_DIRS, ...small];
  const { shards } = assignTestShards(dirs, { estimateSeconds: defaultEstimate });
  assert.ok(shards.length >= FAT_PACKAGE_DIRS.length);
  assert.ok(shards.length <= MAX_SHARDS);
  for (const fatDir of FAT_PACKAGE_DIRS) {
    const fatShard = shards.find((s) => s.includes(fatDir));
    assert.deepEqual(fatShard, [fatDir]);
  }
  assertWithinBudget(shards);
  assert.deepEqual(shards.flat().sort(), [...dirs].sort());
});

test('fat dirs are derived from baseline map', () => {
  assert.equal(FAT_PACKAGE_DIRS.length, 3);
  assert.ok(FAT_PACKAGE_DIRS.includes('apps/client_app'));
  assert.ok(FAT_PACKAGE_DIRS.includes('apps/admin_app'));
  assert.ok(
    FAT_PACKAGE_DIRS.includes('packages/api_client/powersync_api_client'),
  );
});

test('0 packages → nothing_to_test and empty include', () => {
  const planned = planTestShards({
    candidateDirs: ['packages/no_tests'],
    hasTestDir: () => false,
    hashes: {},
    cache: emptyPassCache(),
  });
  assert.equal(planned.hasWork, false);
  assert.equal(planned.skipLog, 'nothing_to_test');
  assert.deepEqual(planned.matrix, { include: [] });
});

test('hash hit skips a package; a miss still runs', () => {
  const cache = recordPassed(emptyPassCache(), 'packages/a', 'hash-a');
  const planned = planTestShards({
    candidateDirs: ['packages/a', 'packages/b'],
    hasTestDir: alwaysTest,
    hashes: { 'packages/a': 'hash-a', 'packages/b': 'hash-b' },
    cache,
  });
  assert.deepEqual(planned.skipped, ['packages/a']);
  assert.deepEqual(planned.toRun, ['packages/b']);
  assert.equal(planned.hasWork, true);
});

test('changing a package hash forces a miss', () => {
  const cache = recordPassed(emptyPassCache(), 'packages/a', 'old');
  const planned = planTestShards({
    candidateDirs: ['packages/a'],
    hasTestDir: alwaysTest,
    hashes: { 'packages/a': 'new' },
    cache,
  });
  assert.deepEqual(planned.toRun, ['packages/a']);
  assert.deepEqual(planned.skipped, []);
});

test('all hashes cached → has_work false and include []', () => {
  let cache = emptyPassCache();
  cache = recordPassed(cache, 'packages/a', 'ha');
  cache = recordPassed(cache, 'packages/b', 'hb');
  const planned = planTestShards({
    candidateDirs: ['packages/a', 'packages/b'],
    hasTestDir: alwaysTest,
    hashes: { 'packages/a': 'ha', 'packages/b': 'hb' },
    cache,
  });
  assert.equal(planned.hasWork, false);
  assert.equal(planned.skipLog, 'all_cached');
  assert.deepEqual(planned.matrix, { include: [] });
  assert.deepEqual(planned.skipped, ['packages/a', 'packages/b']);
});

test('filterPackagesWithTests drops dirs without test/', () => {
  assert.deepEqual(
    filterPackagesWithTests(['a', 'b'], (d) => d === 'a'),
    ['a'],
  );
});

test('githubMatrix encodes shard id, packages, and melos scopes', () => {
  const nameByDir = new Map([['apps/client_app', 'client_app']]);
  assert.deepEqual(githubMatrix([['apps/client_app'], ['packages/a']], { nameByDir }), {
    include: [
      {
        shard: '0',
        packages: 'apps/client_app',
        scopes: 'client_app',
      },
      { shard: '1', packages: 'packages/a', scopes: 'a' },
    ],
  });
});

test('aggregator: docs-only skipped shards pass', () => {
  assert.deepEqual(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'skipped',
      hasWork: false,
    }),
    { ok: true, reason: 'skipped' },
  );
});

test('aggregator: all_cached skipped shards pass', () => {
  assert.equal(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'skipped',
      hasWork: 'false',
    }).ok,
    true,
  );
});

test('aggregator: has_work true + shards skipped fails', () => {
  assert.deepEqual(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'skipped',
      hasWork: true,
    }),
    { ok: false, reason: 'matrix' },
  );
});

test('aggregator: plan failure fails', () => {
  assert.equal(
    aggregateDartTestResult({
      plan: 'failure',
      shards: 'skipped',
      hasWork: false,
    }).ok,
    false,
  );
});

test('aggregator: shard failure fails', () => {
  assert.equal(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'failure',
      hasWork: true,
    }).ok,
    false,
  );
});

test('aggregator: cancelled fails', () => {
  assert.equal(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'cancelled',
      hasWork: true,
    }).ok,
    false,
  );
  assert.equal(
    aggregateDartTestResult({
      plan: 'cancelled',
      shards: 'skipped',
      hasWork: false,
    }).ok,
    false,
  );
});

test('aggregator: claimed skip but shards ran fails', () => {
  assert.deepEqual(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'success',
      hasWork: false,
    }),
    { ok: false, reason: 'claimed-skip' },
  );
});

test('aggregator: success + has_work passes', () => {
  assert.deepEqual(
    aggregateDartTestResult({
      plan: 'success',
      shards: 'success',
      hasWork: true,
    }),
    { ok: true, reason: 'ran' },
  );
});

test('hashPackagesFromLsFiles strips the flutter/ prefix', () => {
  const graph = {
    nameByDir: new Map([['packages/app_ui', 'app_ui']]),
    dirByName: new Map([['app_ui', 'packages/app_ui']]),
    dependentsByName: new Map(),
  };
  const lsFilesS = [
    '100644 aaa 0\tflutter/packages/app_ui/lib/a.dart',
    '100644 lock 0\tflutter/pubspec.lock',
    '',
  ].join('\n');
  const hashes = hashPackagesFromLsFiles({
    lsFilesS,
    packageDirs: ['packages/app_ui'],
    graph,
  });
  assert.equal(typeof hashes['packages/app_ui'], 'string');
  assert.equal(hashes['packages/app_ui'].length, 64);
});

test('nextPassCache records every candidate hash', () => {
  const cache = emptyPassCache();
  const next = nextPassCache({
    cache,
    packageDirs: ['packages/a'],
    hashes: { 'packages/a': 'abc' },
  });
  assert.equal(next.passed['packages/a:abc'], true);
});

test('GIT_STDOUT_MAX_BUFFER holds this repo\u2019s real file list, with room', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const result = spawnSync('git', ['-C', repoRoot, 'ls-files', '-s'], {
    encoding: 'utf8',
    maxBuffer: GIT_STDOUT_MAX_BUFFER,
  });
  assert.equal(result.error, undefined, 'ENOBUFS here is the lane failure, reproduced');
  assert.equal(result.status, 0);
  assert.ok(
    result.stdout.length * 4 < GIT_STDOUT_MAX_BUFFER,
    `file list is ${result.stdout.length} bytes against a ` +
      `${GIT_STDOUT_MAX_BUFFER} ceiling — raise it`,
  );
});

test('parseAggregateArgs reads the three fields', () => {
  assert.deepEqual(
    parseAggregateArgs([
      '--aggregate',
      '--plan',
      'success',
      '--shards',
      'skipped',
      '--has-work',
      'false',
    ]),
    { plan: 'success', shards: 'skipped', hasWork: 'false' },
  );
});

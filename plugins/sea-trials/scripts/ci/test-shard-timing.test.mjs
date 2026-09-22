import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FAT_BASELINE_SECONDS,
  FAT_PACKAGE_DIRS,
  emptyTimingCache,
  estimatePackageSeconds,
  formatDuration,
  mergeTimingPartials,
  recordTimingSample,
} from './test-shard-timing.mjs';

test('formatDuration renders minutes and seconds', () => {
  assert.equal(formatDuration(45), '45s');
  assert.equal(formatDuration(125), '2m 5s');
});

test('recordTimingSample resets when package hash changes', () => {
  let cache = recordTimingSample(emptyTimingCache(), 'packages/a', 30, 'hash1');
  cache = recordTimingSample(cache, 'packages/a', 200, 'hash2');
  assert.equal(cache.packages['packages/a'].seconds, 200);
  assert.equal(cache.packages['packages/a'].samples, 1);
  assert.equal(cache.packages['packages/a'].hash, 'hash2');
});

test('estimatePackageSeconds ignores stale hash entries', () => {
  const cache = recordTimingSample(emptyTimingCache(), 'packages/a', 300, 'old');
  assert.equal(
    estimatePackageSeconds('packages/a', { timingCache: cache, contentHash: 'new' }),
    35,
  );
});

test('estimatePackageSeconds ignores hashless entries when contentHash set', () => {
  const cache = recordTimingSample(emptyTimingCache(), 'packages/a', 300);
  assert.equal(
    estimatePackageSeconds('packages/a', { timingCache: cache, contentHash: 'abc' }),
    35,
  );
});

test('mergeTimingPartials reads hashed partial entries', () => {
  const merged = mergeTimingPartials(emptyTimingCache(), [
    { packages: { 'packages/a': { seconds: 90, hash: 'h1' } } },
  ]);
  assert.equal(merged.packages['packages/a'].hash, 'h1');
  assert.equal(merged.packages['packages/a'].seconds, 90);
});

test('recordTimingSample running-averages wall times', () => {
  let cache = emptyTimingCache();
  cache = recordTimingSample(cache, 'packages/a', 100);
  cache = recordTimingSample(cache, 'packages/a', 200);
  assert.equal(cache.packages['packages/a'].samples, 2);
  assert.equal(cache.packages['packages/a'].seconds, 150);
});

test('mergeTimingPartials folds shard samples into cache', () => {
  const merged = mergeTimingPartials(emptyTimingCache(), [
    { packages: { 'packages/a': 90 } },
    { packages: { 'packages/b': 120, 'packages/a': 110 } },
  ]);
  assert.equal(merged.packages['packages/a'].seconds, 100);
  assert.equal(merged.packages['packages/b'].seconds, 120);
});

test('fat baselines are used when no cache or tree', () => {
  assert.equal(
    estimatePackageSeconds('apps/client_app', {}),
    FAT_BASELINE_SECONDS['apps/client_app'],
  );
});

test('MIN_PACKAGE_SECONDS floors tiny packages', () => {
  assert.equal(estimatePackageSeconds('packages/tiny', {}), 35);
});

test('FAT_PACKAGE_DIRS matches baseline keys', () => {
  assert.deepEqual(FAT_PACKAGE_DIRS, Object.keys(FAT_BASELINE_SECONDS));
  assert.equal(FAT_PACKAGE_DIRS.length, 3);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseMatrixShardCount,
  parseShardTotal,
} from './assert-audit-shards.mjs';

// The live-workflow assertions (shard total vs matrix in the app repo's
// main-guardrails.yml / pr-checks.yml) are config parity and live in the
// app repo's scripts/ci/assert-audit-shards.test.mjs, importing this
// module through scripts/ci/st-plugin.mjs.

test('a mismatch is rejected rather than silently under-auditing', () => {
  // The dangerous direction: too low an env var leaves packages that no
  // shard ever analyzes, and every shard still exits green.
  const yaml = [
    'env:',
    '  AUDIT_SHARD_TOTAL: 3',
    'jobs:',
    '  dart-full-audit:',
    '    strategy:',
    '      matrix:',
    '        shard: [1, 2, 3, 4]',
  ].join('\n');
  assert.equal(parseShardTotal(yaml), 3);
  assert.equal(parseMatrixShardCount(yaml), 4);
});

test('a missing declaration fails loudly instead of defaulting', () => {
  assert.throws(() => parseShardTotal('env:\n  OTHER: 1\n'), /not found/);
  assert.throws(() => parseMatrixShardCount('jobs: {}\n'), /not found/);
});

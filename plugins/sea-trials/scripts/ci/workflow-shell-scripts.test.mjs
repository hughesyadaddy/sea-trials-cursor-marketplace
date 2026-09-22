import assert from 'node:assert/strict';
import test from 'node:test';

import {
  nodeScriptsFromRun,
  pluginScriptsFromJob,
  pluginScriptsFromRun,
  shellScriptsFromJob,
} from './workflow-shell-scripts.mjs';

test('pluginScriptsFromRun collects $ST_PLUGIN_ROOT scripts via node or bash', () => {
  const run = `
    node "$ST_PLUGIN_ROOT/scripts/ci/resolve-flutter-channel-head.mjs" >> "$GITHUB_OUTPUT"
    KEY=$(node "$ST_PLUGIN_ROOT/scripts/ci/lint-source-key.mjs")
    bash "$ST_PLUGIN_ROOT/scripts/ci/run-dart-analyze-extras-local.sh"
    OUT=$(node "$ST_PLUGIN_ROOT"/scripts/ci/pr-lane-paths.mjs --match)
    node \${ST_PLUGIN_ROOT}/scripts/ci/run-lane.mjs --lane static
    node scripts/ci/pr-lane-registry.mjs
  `;
  assert.deepEqual(pluginScriptsFromRun(run), [
    'scripts/ci/lint-source-key.mjs',
    'scripts/ci/pr-lane-paths.mjs',
    'scripts/ci/resolve-flutter-channel-head.mjs',
    'scripts/ci/run-dart-analyze-extras-local.sh',
    'scripts/ci/run-lane.mjs',
  ]);
  assert.deepEqual(nodeScriptsFromRun(run), ['scripts/ci/pr-lane-registry.mjs']);
});

test('pluginScriptsFromJob unions plugin scripts across steps', () => {
  const job = {
    steps: [
      { run: 'node "$ST_PLUGIN_ROOT/scripts/ci/run-lane.mjs" --lane test' },
      { run: 'node "$ST_PLUGIN_ROOT/scripts/ci/test-shards.mjs" --aggregate' },
      { uses: 'actions/checkout@v7' },
    ],
  };
  assert.deepEqual(pluginScriptsFromJob(job), [
    'scripts/ci/run-lane.mjs',
    'scripts/ci/test-shards.mjs',
  ]);
});

test('nodeScriptsFromRun collects repo-relative script paths only', () => {
  const run = `
    node scripts/ci/resolve-flutter-channel-head.mjs >> "$GITHUB_OUTPUT"
    KEY=$(node scripts/ci/lint-source-key.mjs)
    node ../scripts/ci/guardrails-analyze-packages.mjs --shard 1
  `;
  assert.deepEqual(nodeScriptsFromRun(run), [
    'scripts/ci/lint-source-key.mjs',
    'scripts/ci/resolve-flutter-channel-head.mjs',
  ]);
});

test('shellScriptsFromJob unions scripts across steps', () => {
  const job = {
    steps: [
      { run: 'node scripts/ci/resolve-flutter-channel-head.mjs' },
      { run: 'KEY=$(node scripts/ci/lint-source-key.mjs)' },
    ],
  };
  assert.deepEqual(shellScriptsFromJob(job), [
    'scripts/ci/lint-source-key.mjs',
    'scripts/ci/resolve-flutter-channel-head.mjs',
  ]);
});

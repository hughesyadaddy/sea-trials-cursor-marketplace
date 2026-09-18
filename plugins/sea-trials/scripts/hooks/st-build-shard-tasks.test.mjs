import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'st-build-shard-tasks.mjs',
);

test('st-build-shard-tasks emits one wave when --wave omitted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-'));
  const manifest = path.join(dir, 'shards.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      shards: [
        { id: 'a', paths: ['a/'] },
        { id: 'b', paths: ['b/'], dependsOn: ['a'] },
      ],
    }),
  );
  const res = spawnSync(
    process.execPath,
    [script, '--manifest', manifest, '--root', dir],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).taskId, 'a');
});

test('st-build-shard-tasks advances with --done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-done-'));
  const manifest = path.join(dir, 'shards.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      shards: [
        { id: 'a', paths: ['a/'] },
        { id: 'b', paths: ['b/'], dependsOn: ['a'] },
      ],
    }),
  );
  const res = spawnSync(
    process.execPath,
    [
      script,
      '--manifest',
      manifest,
      '--root',
      dir,
      '--done',
      'a',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(res.status, 0, res.stderr);
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).taskId, 'b');
});

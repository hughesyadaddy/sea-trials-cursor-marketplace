import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { runScopedPerCommitValidate } from './scoped-per-commit-validate.mjs';
import { partitionRepoPaths, isDocsOnlySet } from './per-commit-paths.mjs';
import { writeCommitValidateRecord } from './commit-validate-record.mjs';

function git(repo, ...args) {
  return spawnSync('git', args, { cwd: repo, encoding: 'utf8' }).stdout?.trim();
}

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-scoped-val-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
  return tmp;
}

test('partition: docs-only vs nondart vs dart', () => {
  const p = partitionRepoPaths([
    'README.md',
    'plugins/sea-trials/scripts/hooks/lib/foo.mjs',
    'flutter/packages/x/lib/a.dart',
  ]);
  assert.deepEqual(p.docs, ['README.md']);
  assert.equal(p.nondart.length, 1);
  assert.deepEqual(p.dart, ['flutter/packages/x/lib/a.dart']);
  assert.equal(isDocsOnlySet(['docs/a.md', 'README.md']), true);
});

test('docs-only scope passes without dart', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# hi\n');
  const r = runScopedPerCommitValidate(repo, ['README.md'], {
    reuseCommitRecord: false,
    writeRecord: false,
  });
  assert.equal(r.ok, true);
});

test('js-only runs node --check not dart', () => {
  const repo = initRepo();
  const js = 'plugins/sea-trials/scripts/hooks/lib/sample-only.test-target.mjs';
  const abs = path.join(repo, js);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'export const x = 1;\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: repo });

  const r = runScopedPerCommitValidate(repo, [js], {
    reuseCommitRecord: false,
    writeRecord: false,
  });
  assert.equal(r.ok, true);
  assert.ok(r.steps.some((s) => s.name === 'non-dart'));
});

test('mixed docs + invalid dart package fails dart leg', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'README.md'), '# x\n');
  const dart = 'flutter/packages/p/lib/x.dart';
  fs.mkdirSync(path.join(repo, path.dirname(dart)), { recursive: true });
  fs.writeFileSync(path.join(repo, dart), '// x\n');
  const r = runScopedPerCommitValidate(repo, ['README.md', dart], {
    reuseCommitRecord: false,
    writeRecord: false,
  });
  assert.equal(r.ok, false);
  assert.ok(r.steps.some((s) => s.name === 'dart' && s.ok === false));
});

test('push reuses commit validation record on clean tree', () => {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/note.md'), 'a\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  const paths = ['docs/note.md'];
  writeCommitValidateRecord(repo, {
    ok: true,
    validateFingerprint: 'abc',
    scopePaths: paths,
    mode: 'full',
    testsExecuted: false,
    hadLibChanges: false,
  });
  const r = runScopedPerCommitValidate(repo, paths, {
    reuseCommitRecord: true,
    writeRecord: false,
  });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

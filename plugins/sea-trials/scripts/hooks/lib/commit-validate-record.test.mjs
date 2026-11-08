import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  commitValidateIsTrusted,
  writeCommitValidateRecord,
} from './commit-validate-record.mjs';

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-record-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
  return tmp;
}

test('analyze-only record never authorizes full reuse', () => {
  const repo = initRepo();
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs/a.md'), 'x\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  const scope = ['docs/a.md'];
  writeCommitValidateRecord(repo, {
    ok: true,
    validateFingerprint: 'fp-analyze-only',
    scopePaths: scope,
    mode: 'analyze-only',
    testsExecuted: false,
    hadLibChanges: true,
  });
  const trust = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    validateFingerprint: 'fp-analyze-only',
    requireMode: 'full',
  });
  assert.equal(trust.ok, false);
  assert.match(trust.reason, /mode/);
});

test('full record requires matching validateFingerprint', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'f.txt'), 'z\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  const scope = ['f.txt'];
  writeCommitValidateRecord(repo, {
    ok: true,
    validateFingerprint: 'correct-fp',
    scopePaths: scope,
    mode: 'full',
    testsExecuted: false,
    hadLibChanges: false,
  });
  const bad = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    validateFingerprint: 'wrong-fp',
    requireMode: 'full',
  });
  assert.equal(bad.ok, false);
  const good = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    validateFingerprint: 'correct-fp',
    requireMode: 'full',
  });
  assert.equal(good.ok, true);
});

test('lib changes without testsExecuted blocks reuse', () => {
  const repo = initRepo();
  fs.writeFileSync(path.join(repo, 'f.txt'), 'z\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  const scope = ['f.txt'];
  writeCommitValidateRecord(repo, {
    ok: true,
    validateFingerprint: 'fp',
    scopePaths: scope,
    mode: 'full',
    testsExecuted: false,
    hadLibChanges: true,
  });
  const trust = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    validateFingerprint: 'fp',
    requireMode: 'full',
  });
  assert.equal(trust.ok, false);
  assert.match(trust.reason, /tests were not executed/);
});

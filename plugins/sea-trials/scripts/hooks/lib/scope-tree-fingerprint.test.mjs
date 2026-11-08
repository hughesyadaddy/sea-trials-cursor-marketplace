import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  assertNoPartialStaging,
  scopePathsByteFingerprint,
} from './scope-tree-fingerprint.mjs';

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-fp-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
  return tmp;
}

test('byte fingerprint changes when file content changes (same path)', () => {
  const repo = initRepo();
  const rel = 'data.txt';
  fs.writeFileSync(path.join(repo, rel), 'v1\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  fs.writeFileSync(path.join(repo, rel), 'v2\n');
  const fp1 = scopePathsByteFingerprint(repo, [rel]);
  fs.writeFileSync(path.join(repo, rel), 'v3\n');
  const fp2 = scopePathsByteFingerprint(repo, [rel]);
  assert.notEqual(fp1, fp2);
});

test('partial staging (MM) fails assertNoPartialStaging', () => {
  const repo = initRepo();
  const rel = 'partial.dart';
  fs.writeFileSync(path.join(repo, rel), 'a\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  fs.writeFileSync(path.join(repo, rel), 'b\n');
  spawnSync('git', ['add', rel], { cwd: repo });
  fs.writeFileSync(path.join(repo, rel), 'c\n');
  const result = assertNoPartialStaging(repo, [rel]);
  assert.equal(result.ok, false);
  assert.match(result.message, /Partial staging/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  evaluateGatePassToken,
  writeGatePassToken,
  workingTreeFingerprint,
} from './gate-pass-token.mjs';

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gate-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
  return tmp;
}

test('gate token fails when worktree bytes change but size unchanged', () => {
  const repo = initRepo();
  const rel = 'same-len.txt';
  fs.writeFileSync(path.join(repo, rel), 'aaaaaaaaaa\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'c'], { cwd: repo });
  const head = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repo,
    encoding: 'utf8',
  }).stdout.trim();
  const treeAtWrite = workingTreeFingerprint(repo);
  fs.writeFileSync(path.join(repo, rel), 'bbbbbbbbbb\n');
  const token = writeGatePassToken(repo, {
    headOid: head,
    phases: ['scoped'],
  });
  token.tree = treeAtWrite;
  const now = Date.now();
  const okStale = evaluateGatePassToken({
    token,
    headOid: head,
    tree: workingTreeFingerprint(repo),
    requiredPhase: 'scoped',
    env: { ST_REVIEW_PUSH: head },
    now,
  });
  assert.equal(okStale.ok, false);
  assert.match(okStale.reason, /working tree changed/);
});

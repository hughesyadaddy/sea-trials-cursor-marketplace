import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { lintSourceCacheKey, lintSourceFingerprint } from './lint-source-key.mjs';
import {
  changedFilesInHeadCommit,
  headTouchesLint,
  resolveLintGateCommitRef,
  shouldBuildLintMatrix,
} from './head-touches-lint.mjs';

test('lint source fingerprint is stable for unchanged lint tree', () => {
  const a = lintSourceFingerprint();
  const b = lintSourceFingerprint();
  assert.equal(a, b);
  assert.match(lintSourceCacheKey(), /^[0-9a-f]{64}$/);
});

test('headTouchesLint matches lint paths only', () => {
  assert.equal(
    headTouchesLint(['tools/sea-trials-lint/src/config.rs']),
    true,
  );
  assert.equal(
    headTouchesLint(['flutter/packages/app_ui/lib/a.dart']),
    false,
  );
});

test('shouldBuildLintMatrix uses HEAD commit files', () => {
  const files = changedFilesInHeadCommit();
  assert.equal(shouldBuildLintMatrix(), headTouchesLint(files));
});

test('resolveLintGateCommitRef returns a non-empty git ref', () => {
  const ref = resolveLintGateCommitRef();
  assert.ok(ref.length > 0);
});

test('changedFilesInHeadCommit handles merge commit as PR head', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-gate-'));
  const originalCwd = process.cwd();
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    git('add', '-A');
  };

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    write('base.txt', 'base\n');
    git('commit', '-qm', 'base');

    git('checkout', '-q', '-b', 'feature');
    write('tools/sea-trials-lint/src/lib.rs', 'v1\n');
    git('commit', '-qm', 'lint on feature');

    git('checkout', '-q', 'main');
    write('tools/sea-trials-lint/src/lib.rs', 'v2main\n');
    git('commit', '-qm', 'lint on main');

    git('checkout', '-q', 'feature');
    const mergeResult = spawnSync('git', ['merge', '--no-edit', 'main'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.notEqual(mergeResult.status, 0, 'expected merge conflict');
    write('tools/sea-trials-lint/src/lib.rs', 'resolved\n');
    git('commit', '-qm', 'resolve merge');

    const featureTip = git('rev-parse', 'HEAD');
    const featureParents = git('rev-list', '--parents', '-n', '1', featureTip)
      .split(/\s+/);
    assert.ok(featureParents.length > 2, 'PR head must be a merge commit');

    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '--no-edit', 'feature');

    process.chdir(dir);
    const gateRef = resolveLintGateCommitRef();
    assert.equal(gateRef, featureTip);

    const files = changedFilesInHeadCommit();
    assert.ok(
      files.some((f) => f.startsWith('tools/sea-trials-lint/')),
      `expected lint path in ${JSON.stringify(files)}`,
    );
    assert.equal(shouldBuildLintMatrix(), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('changedFilesInHeadCommit uses first parent on merge heads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lint-gate-merge-'));
  const originalCwd = process.cwd();
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    git('add', '-A');
  };

  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    write('base.txt', 'base\n');
    git('commit', '-qm', 'base');

    git('checkout', '-q', '-b', 'feature');
    write('feature.txt', 'feature\n');
    git('commit', '-qm', 'feature only');

    git('checkout', '-q', '-b', 'lint-branch');
    write('tools/sea-trials-lint/src/lib.rs', 'lint\n');
    git('commit', '-qm', 'lint on branch');

    git('checkout', '-q', 'feature');
    git('merge', '--no-ff', '--no-edit', 'lint-branch');

    const featureTip = git('rev-parse', 'HEAD');
    const featureParents = git('rev-list', '--parents', '-n', '1', featureTip)
      .split(/\s+/);
    assert.ok(featureParents.length > 2, 'PR head must be a merge commit');

    git('checkout', '-q', 'main');
    git('merge', '--no-ff', '--no-edit', 'feature');

    process.chdir(dir);
    const gateRef = resolveLintGateCommitRef();
    assert.equal(gateRef, featureTip);

    const files = changedFilesInHeadCommit();
    assert.ok(
      files.some((f) => f.startsWith('tools/sea-trials-lint/')),
      `expected lint path in ${JSON.stringify(files)}`,
    );
    assert.equal(shouldBuildLintMatrix(), true);
  } finally {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

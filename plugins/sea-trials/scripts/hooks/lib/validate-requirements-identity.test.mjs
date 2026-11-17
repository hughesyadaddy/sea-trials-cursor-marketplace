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
import { enforceDirectTestContract } from './direct-covering-tests.mjs';
import {
  buildRequirementsIdentity,
  buildGroupsFromDartRepoPaths,
  computeExpectedValidateTrust,
} from './validate-requirements-identity.mjs';
import { scheduleDirectCoveringTests } from './direct-covering-tests.mjs';
import { parseExplicitCoveringMap } from './explicit-covering-map.mjs';

function initRepo() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'st-req-id-'));
  spawnSync('git', ['init'], { cwd: tmp });
  spawnSync('git', ['config', 'user.email', 't@t.com'], { cwd: tmp });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: tmp });
  return tmp;
}

function seedFlutterPkg(repo) {
  const libRepo = 'flutter/packages/pkg/lib/widget.dart';
  const testRepo = 'flutter/packages/pkg/test/widget_test.dart';
  const pkgCwd = path.join(repo, 'flutter/packages/pkg');
  fs.mkdirSync(path.join(pkgCwd, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(pkgCwd, 'test'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgCwd, 'pubspec.yaml'),
    "name: pkg\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
  );
  fs.writeFileSync(path.join(pkgCwd, 'lib', 'widget.dart'), '// w\n');
  fs.writeFileSync(path.join(pkgCwd, 'test', 'widget_test.dart'), 'void main() {}\n');
  spawnSync('git', ['add', '-A'], { cwd: repo });
  spawnSync('git', ['commit', '-m', 'seed'], { cwd: repo });
  return { libRepo, testRepo };
}

test('changing ST_AGENT_VALIDATE_COVERS busts trust without byte changes', () => {
  const repo = initRepo();
  const { libRepo, testRepo } = seedFlutterPkg(repo);
  const scope = [libRepo];
  const envA = {
    ST_AGENT_VALIDATE_COVERS: `${libRepo}=${testRepo}`,
  };
  const expectedA = computeExpectedValidateTrust(repo, scope, {
    requireMode: 'full',
    env: envA,
  });
  writeCommitValidateRecord(repo, {
    ok: true,
    validateFingerprint: expectedA.validateFingerprint,
    requirementsIdentity: expectedA.requirementsIdentity,
    scopePaths: scope,
    mode: 'full',
    testsExecuted: true,
    hadLibChanges: true,
  });
  const envB = {
    ST_AGENT_VALIDATE_COVERS: `${libRepo}=flutter/packages/pkg/test/other_test.dart`,
  };
  const trustB = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    requireMode: 'full',
    env: envB,
  });
  assert.equal(trustB.ok, false);
  assert.match(trustB.reason, /requirements identity|fingerprint/);
  const trustA = commitValidateIsTrusted(repo, {
    scopePaths: scope,
    requireMode: 'full',
    env: envA,
  });
  assert.equal(trustA.ok, true);
});

test('explicit README mapping fails contract (non-runnable test path)', () => {
  const repo = initRepo();
  const flutterRoot = path.join(repo, 'flutter');
  const pkgCwd = path.join(flutterRoot, 'packages', 'pkg');
  fs.mkdirSync(path.join(pkgCwd, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgCwd, 'pubspec.yaml'),
    "name: pkg\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
  );
  fs.writeFileSync(path.join(pkgCwd, 'lib', 'a.dart'), '//\n');
  fs.writeFileSync(path.join(repo, 'README.md'), '# doc\n');
  const libRepo = 'flutter/packages/pkg/lib/a.dart';
  const readme = 'README.md';
  const map = parseExplicitCoveringMap(`${libRepo}=${readme}`);
  const groups = buildGroupsFromDartRepoPaths(repo, [libRepo]);
  scheduleDirectCoveringTests(groups, map);
  const check = enforceDirectTestContract({
    groups,
    explicitRepoRelPaths: new Set([libRepo]),
    explicitCoveringByLibRepoRel: map,
  });
  assert.equal(check.ok, false);
});

test('requirements identity includes scheduled conventional tests', () => {
  const repo = initRepo();
  const libRepo = 'flutter/packages/pkg/lib/foo.dart';
  const groups = buildGroupsFromDartRepoPaths(repo, [libRepo]);
  fs.mkdirSync(path.join(repo, path.dirname(libRepo)), { recursive: true });
  fs.mkdirSync(path.join(repo, 'flutter/packages/pkg/test'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'flutter/packages/pkg/pubspec.yaml'),
    "name: pkg\n",
  );
  fs.writeFileSync(path.join(repo, libRepo), '//\n');
  fs.writeFileSync(path.join(repo, 'flutter/packages/pkg/test/foo_test.dart'), 'void main() {}\n');
  const g2 = buildGroupsFromDartRepoPaths(repo, [libRepo]);
  scheduleDirectCoveringTests(g2, new Map());
  const id = buildRequirementsIdentity({
    explicitCoveringMap: new Map(),
    scheduledTestRepoPaths: ['flutter/packages/pkg/test/foo_test.dart'],
    mode: 'full',
  });
  assert.match(id, /^[a-f0-9]{64}$/);
});

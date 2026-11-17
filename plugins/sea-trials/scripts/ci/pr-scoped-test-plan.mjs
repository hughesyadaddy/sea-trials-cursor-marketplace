/**
 * PR dart-test planner: direct covering tests only, capped shard count.
 *
 * Matches the per-commit contract in agent-validate-changed (changed
 * *_test.dart plus on-disk tests for touched lib files). No dependent
 * package expansion on pull_request.
 */

import { scheduleDirectCoveringTests } from '../hooks/lib/direct-covering-tests.mjs';
import { parseExplicitCoveringMap } from '../hooks/lib/explicit-covering-map.mjs';
import { partitionRepoPaths } from '../hooks/lib/per-commit-paths.mjs';
import {
  buildGroupsFromDartRepoPaths,
  scheduledTestRepoPathsFromGroups,
} from '../hooks/lib/validate-requirements-identity.mjs';
import {
  assignTestShards,
  BASE_PACKAGE_SECONDS,
  SECONDS_PER_TEST_FILE,
} from './test-shard-timing.mjs';

/** Maximum dart-test-shard matrix rows for scoped pull_request plans. */
export const PR_TEST_SHARD_CAP = 4;

/** PR label that opts into the legacy whole-workspace package plan. */
export const CI_FULL_TESTS_LABEL = 'ci:full-tests';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function wantsFullDartTestPlan(env = process.env) {
  if (env.CI_FULL_TESTS === '1') return true;
  if (env.GITHUB_EVENT_NAME === 'schedule') return true;
  if (
    env.GITHUB_EVENT_NAME === 'push' &&
    env.GITHUB_REF === 'refs/heads/main'
  ) {
    return true;
  }
  const labels = (env.GITHUB_PR_LABELS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.includes(CI_FULL_TESTS_LABEL)) return true;
  return false;
}

/**
 * @param {string} testRepoRel e.g. flutter/packages/foo/test/a_test.dart
 * @returns {{ packageDir: string, inPkgTest: string } | null}
 */
export function packageDirFromTestRepoRel(testRepoRel) {
  const norm = testRepoRel.replace(/\\/g, '/');
  if (!norm.startsWith('flutter/')) return null;
  const rest = norm.slice('flutter/'.length);
  const marker = '/test/';
  const idx = rest.indexOf(marker);
  if (idx < 0) return null;
  const packageDir = rest.slice(0, idx);
  const inPkgTest = rest.slice(idx + 1);
  if (!inPkgTest.endsWith('_test.dart')) return null;
  return { packageDir, inPkgTest };
}

/**
 * Direct covering tests for a PR diff (no dependent expansion).
 *
 * @param {{
 *   repoRoot: string,
 *   changedFiles: string[],
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 * @returns {Map<string, string[]>} flutter-relative package dir → test/ rel paths
 */
export function resolvePrScopedTestsByPackage({
  repoRoot,
  changedFiles,
  env = process.env,
}) {
  const { dart } = partitionRepoPaths(changedFiles);
  if (dart.length === 0) return new Map();

  const explicit = parseExplicitCoveringMap(env.ST_AGENT_VALIDATE_COVERS);
  const groups = buildGroupsFromDartRepoPaths(repoRoot, dart);
  scheduleDirectCoveringTests(groups, explicit);

  /** @type {Map<string, Set<string>>} */
  const byPackage = new Map();
  const add = (packageDir, inPkgTest) => {
    if (!byPackage.has(packageDir)) byPackage.set(packageDir, new Set());
    byPackage.get(packageDir).add(inPkgTest);
  };

  for (const testRepo of scheduledTestRepoPathsFromGroups(groups)) {
    const parsed = packageDirFromTestRepoRel(testRepo);
    if (!parsed) continue;
    add(parsed.packageDir, parsed.inPkgTest);
  }

  /** @type {Map<string, string[]>} */
  const out = new Map();
  for (const [dir, rels] of byPackage) {
    out.set(dir, [...rels].sort());
  }
  return out;
}

/**
 * @param {string[]} inPkgTests
 * @returns {number}
 */
export function estimateScopedPackageSeconds(inPkgTests) {
  if (inPkgTests.length === 0) return 0;
  return Math.max(
    BASE_PACKAGE_SECONDS,
    BASE_PACKAGE_SECONDS + inPkgTests.length * SECONDS_PER_TEST_FILE,
  );
}

/**
 * @param {{
 *   testsByPackage: Map<string, string[]>,
 *   nameByDir?: Map<string, string>,
 *   maxShards?: number,
 * }} opts
 * @returns {{
 *   hasWork: boolean,
 *   skipLog: string,
 *   matrix: { include: object[] },
 *   packageDirs: string[],
 * }}
 */
export function planPrScopedTestMatrix({
  testsByPackage,
  nameByDir,
  maxShards = PR_TEST_SHARD_CAP,
}) {
  const packageDirs = [...testsByPackage.keys()].sort();
  if (packageDirs.length === 0) {
    return {
      hasWork: false,
      skipLog: 'nothing_to_test',
      matrix: { include: [] },
      packageDirs: [],
    };
  }

  const estimateSeconds = (dir) =>
    estimateScopedPackageSeconds(testsByPackage.get(dir) ?? []);

  const { shards } = assignTestShards(packageDirs, {
    maxShards,
    estimateSeconds,
  });

  /** @type {object[]} */
  const include = [];
  for (const [shardIndex, bin] of shards.entries()) {
    const packages = [...bin].sort();
    const scopes = packages
      .map((dir) => nameByDir?.get(dir) ?? dir.split('/').pop())
      .join(',');
    const row = {
      shard: String(shardIndex),
      packages: packages.join(','),
      scopes,
    };
    if (packages.length === 1) {
      const testRels = testsByPackage.get(packages[0]) ?? [];
      if (testRels.length > 0) {
        row.test_paths = testRels.join(' ');
      }
    }
    include.push(row);
  }

  return {
    hasWork: true,
    skipLog: '',
    matrix: { include },
    packageDirs,
  };
}
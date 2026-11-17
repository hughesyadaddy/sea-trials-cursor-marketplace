/**
 * Validation requirements identity (explicit covers + scheduled tests + mode).
 * Computed independently of any commit-validate record.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findNearestPubspecYaml } from './flutter-packages.mjs';
import { parseExplicitCoveringMap } from './explicit-covering-map.mjs';
import {
  existingDirectTestsForLib,
  scheduleDirectCoveringTests,
} from './direct-covering-tests.mjs';
import { computeValidateFingerprintForDartScope } from './agent-validate-fingerprint.mjs';
import { partitionRepoPaths } from './per-commit-paths.mjs';

/**
 * @param {Map<string, string[]>} map
 */
export function serializeExplicitCoveringMap(map) {
  const lines = [];
  for (const [lib, tests] of [...map.entries()].sort()) {
    for (const t of [...tests].sort()) {
      lines.push(`${lib}=${t}`);
    }
  }
  return lines.join('\n');
}

/**
 * @param {string} testRepoRel
 */
export function isRunnableCoveringTestRepoRel(testRepoRel) {
  const norm = testRepoRel.replace(/\\/g, '/');
  return (
    norm.startsWith('flutter/')
    && norm.includes('/test/')
    && norm.endsWith('_test.dart')
  );
}

/**
 * @param {string} libRepoRel e.g. flutter/packages/pkg/lib/a.dart
 * @param {string} testRepoRel
 */
export function samePackageLibAndTest(libRepoRel, testRepoRel) {
  const lib = libRepoRel.replace(/\\/g, '/');
  const test = testRepoRel.replace(/\\/g, '/');
  const libMarker = '/lib/';
  const testMarker = '/test/';
  const li = lib.indexOf(libMarker);
  const ti = test.indexOf(testMarker);
  if (li < 0 || ti < 0) return false;
  return lib.slice(0, li) === test.slice(0, ti);
}

/**
 * @param {string} repoRoot
 * @param {string} libRepoRel
 * @param {string[]} explicitTestRepoRels
 */
export function runnableExplicitCoveringTests(
  repoRoot,
  libRepoRel,
  explicitTestRepoRels,
) {
  return explicitTestRepoRels.filter(
    (t) =>
      isRunnableCoveringTestRepoRel(t)
      && samePackageLibAndTest(libRepoRel, t)
      && fs.existsSync(path.join(repoRoot, t)),
  );
}

/**
 * @param {string} repoRoot
 * @param {string[]} dartRepoRelPaths
 */
export function buildGroupsFromDartRepoPaths(repoRoot, dartRepoRelPaths) {
  const flutterRoot = path.join(repoRoot, 'flutter');
  /** @type {Map<string, { pkgRel: string, lib: string[], test: string[], resolved: { repoRoot: string, flutterRoot: string } }>} */
  const groups = new Map();
  for (const repoRel of dartRepoRelPaths) {
    const norm = repoRel.replace(/\\/g, '/');
    const abs = path.join(repoRoot, norm);
    if (!fs.existsSync(abs)) continue;
    const pubspecPath = findNearestPubspecYaml(abs);
    if (!pubspecPath) continue;
    const pkgCwd = path.dirname(pubspecPath);
    let pkgRel = path.relative(flutterRoot, pkgCwd).replace(/\\/g, '/');
    if (pkgRel === '') pkgRel = '.';
    const key = `${flutterRoot}::${pkgRel}`;
    if (!groups.has(key)) {
      groups.set(key, {
        pkgRel,
        lib: [],
        test: [],
        resolved: { repoRoot, flutterRoot },
      });
    }
    const inPkg = path.relative(pkgCwd, abs).replace(/\\/g, '/');
    const group = groups.get(key);
    if (inPkg.startsWith('test/') && inPkg.endsWith('_test.dart')) {
      if (!group.test.includes(inPkg)) group.test.push(inPkg);
    } else if (inPkg.startsWith('lib/')) {
      if (!group.lib.includes(inPkg)) group.lib.push(inPkg);
    }
  }
  return groups;
}

/**
 * @param {Map<string, { pkgRel: string, lib: string[], test: string[] }>} groups
 */
export function scheduledTestRepoPathsFromGroups(groups) {
  /** @type {string[]} */
  const paths = [];
  for (const [, group] of groups) {
    const prefix =
      group.pkgRel === '.' ? 'flutter/' : `flutter/${group.pkgRel}/`;
    for (const t of group.test) paths.push(`${prefix}${t}`);
  }
  return [...new Set(paths)].sort();
}

/**
 * @param {{
 *   explicitCoveringMap: Map<string, string[]>,
 *   scheduledTestRepoPaths: string[],
 *   mode?: string,
 * }} input
 */
export function buildRequirementsIdentity(input) {
  const payload = {
    mode: input.mode ?? 'full',
    covers: serializeExplicitCoveringMap(input.explicitCoveringMap),
    scheduledTests: [...input.scheduledTestRepoPaths].sort(),
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

/**
 * @param {string} repoRoot
 * @param {string[]} scopeRepoRelPaths
 * @param {{ env?: NodeJS.ProcessEnv, requireMode?: string }} [opts]
 */
export function computeExpectedValidateTrust(repoRoot, scopeRepoRelPaths, opts = {}) {
  const env = opts.env ?? process.env;
  const requireMode = opts.requireMode ?? 'full';
  const { dart } = partitionRepoPaths(scopeRepoRelPaths);
  const explicitCovering = parseExplicitCoveringMap(env.ST_AGENT_VALIDATE_COVERS);
  const groups = buildGroupsFromDartRepoPaths(repoRoot, dart);
  scheduleDirectCoveringTests(groups, explicitCovering);
  const scheduledTestRepoPaths = scheduledTestRepoPathsFromGroups(groups);
  const requirementsIdentity = buildRequirementsIdentity({
    explicitCoveringMap: explicitCovering,
    scheduledTestRepoPaths,
    mode: requireMode,
  });
  const validateFingerprint =
    dart.length === 0
      ? ''
      : computeValidateFingerprintForDartScope(repoRoot, dart, {
          env,
          requirementsIdentity,
        });
  const hadLibChanges = [...groups.values()].some((g) => g.lib.length > 0);
  const testsRequired = hadLibChanges && scheduledTestRepoPaths.length > 0;
  return {
    validateFingerprint,
    requirementsIdentity,
    hadLibChanges,
    testsRequired,
    scheduledTestRepoPaths,
  };
}

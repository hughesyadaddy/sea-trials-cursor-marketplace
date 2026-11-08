/**
 * Direct covering-test mapping and scheduling for per-commit validation.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} inPkgLibPath e.g. `lib/src/foo.dart` (package-relative)
 * @returns {string[]} candidate test paths relative to package (most specific first)
 */
export function candidateDirectTestRels(inPkgLibPath) {
  if (!inPkgLibPath.startsWith('lib/') || !inPkgLibPath.endsWith('.dart')) {
    return [];
  }
  const underLib = inPkgLibPath.slice('lib/'.length);
  const base = underLib.replace(/\.dart$/, '');
  const leaf = base.includes('/')
    ? base.slice(base.lastIndexOf('/') + 1)
    : base;
  /** @type {string[]} */
  const candidates = [];
  const seen = new Set();
  const push = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    candidates.push(rel);
  };
  push(`test/${base}_test.dart`);
  if (base !== leaf) {
    push(`test/${leaf}_test.dart`);
  }
  return candidates;
}

/**
 * @param {string} pkgCwd absolute package directory
 * @param {string} inPkgLibPath
 * @returns {string[]} existing direct test paths (package-relative)
 */
export function existingDirectTestsForLib(pkgCwd, inPkgLibPath) {
  return candidateDirectTestRels(inPkgLibPath).filter((rel) =>
    fs.existsSync(path.join(pkgCwd, rel)),
  );
}

/**
 * @param {string} repoRelPrefix e.g. flutter/packages/pkg/
 * @param {string} inPkgLib
 * @param {Map<string, string[]>} explicitCoveringByLibRepoRel
 * @param {string} pkgCwd
 */
function explicitTestsForLib(
  repoRelPrefix,
  inPkgLib,
  explicitCoveringByLibRepoRel,
  pkgCwd,
) {
  const libRepo = `${repoRelPrefix}${inPkgLib}`.replace(/\/+/g, '/');
  const mapped = explicitCoveringByLibRepoRel.get(libRepo) ?? [];
  /** @type {string[]} */
  const inPkg = [];
  for (const testRepo of mapped) {
    if (!testRepo.startsWith(repoRelPrefix)) continue;
    const rel = testRepo.slice(repoRelPrefix.length);
    if (rel.startsWith('test/') && rel.endsWith('_test.dart')) {
      if (fs.existsSync(path.join(pkgCwd, rel))) inPkg.push(rel);
    }
  }
  return inPkg;
}

/**
 * Whether `inPkgTestPath` directly covers `inPkgLibPath`.
 */
export function testDirectlyCoversLib(
  inPkgLibPath,
  inPkgTestPath,
  { repoRelPrefix = '', inPkgLibRepoRel = '', explicitCoveringByLibRepoRel = new Map() } = {},
) {
  if (!inPkgTestPath.startsWith('test/') || !inPkgTestPath.endsWith('_test.dart')) {
    return false;
  }
  const libRepo =
    inPkgLibRepoRel || `${repoRelPrefix}${inPkgLibPath}`.replace(/\/+/g, '/');
  const mapped = explicitCoveringByLibRepoRel.get(libRepo) ?? [];
  const testRepo = `${repoRelPrefix}${inPkgTestPath}`.replace(/\/+/g, '/');
  if (mapped.includes(testRepo)) return true;
  return candidateDirectTestRels(inPkgLibPath).includes(inPkgTestPath);
}

/**
 * Schedule unchanged on-disk direct covering tests for changed lib files.
 *
 * @param {Map<string, { pkgRel: string, lib: string[], test: string[],
 *   resolved: { repoRoot: string, flutterRoot: string } }>} groups
 * @param {Map<string, string[]>} explicitCoveringByLibRepoRel
 */
export function scheduleDirectCoveringTests(groups, explicitCoveringByLibRepoRel = new Map()) {
  for (const [, group] of groups) {
    const pkgCwd =
      group.pkgRel === '.'
        ? group.resolved.flutterRoot
        : path.join(group.resolved.flutterRoot, group.pkgRel);
    const prefix =
      group.pkgRel === '.' ? 'flutter/' : `flutter/${group.pkgRel}/`;

    for (const inPkgLib of group.lib) {
      const fromExplicit = explicitTestsForLib(
        prefix,
        inPkgLib,
        explicitCoveringByLibRepoRel,
        pkgCwd,
      );
      const fromConvention = existingDirectTestsForLib(pkgCwd, inPkgLib);
      for (const rel of [...fromExplicit, ...fromConvention]) {
        if (!group.test.includes(rel)) group.test.push(rel);
      }
    }
  }
}

/**
 * @param {{
 *   groups: Map<string, { pkgRel: string, lib: string[], test: string[],
 *     resolved: { repoRoot: string, flutterRoot: string } }>,
 *   explicitRepoRelPaths: Set<string>,
 *   explicitCoveringByLibRepoRel?: Map<string, string[]>,
 * }} input
 */
export function enforceDirectTestContract({
  groups,
  explicitRepoRelPaths,
  explicitCoveringByLibRepoRel = new Map(),
}) {
  for (const [, group] of groups) {
    const pkgCwd =
      group.pkgRel === '.'
        ? group.resolved.flutterRoot
        : path.join(group.resolved.flutterRoot, group.pkgRel);
    const prefix =
      group.pkgRel === '.' ? 'flutter/' : `flutter/${group.pkgRel}/`;

    for (const inPkgLib of group.lib) {
      const libRepo = `${prefix}${inPkgLib}`;
      const explicit = explicitCoveringByLibRepoRel.get(libRepo) ?? [];
      const conventional = existingDirectTestsForLib(pkgCwd, inPkgLib);
      const explicitOnDisk = explicit.filter((t) =>
        fs.existsSync(path.join(group.resolved.repoRoot, t)),
      );
      if (conventional.length === 0 && explicitOnDisk.length === 0) {
        return {
          ok: false,
          message:
            `No direct covering test file on disk for ${libRepo}. `
            + 'Add test/*_test.dart or ST_AGENT_VALIDATE_COVERS=lib=test mapping.',
        };
      }
    }

    for (const inPkgTest of group.test) {
      const coversAny = group.lib.some((inPkgLib) =>
        testDirectlyCoversLib(inPkgLib, inPkgTest, {
          repoRelPrefix: prefix,
          explicitCoveringByLibRepoRel,
        }),
      );
      if (group.lib.length > 0 && !coversAny) {
        return {
          ok: false,
          message:
            `Supplied test ${prefix}${inPkgTest} is not a registered direct `
            + 'cover for any changed lib file (convention or explicit map).',
        };
      }
    }
  }
  return { ok: true };
}

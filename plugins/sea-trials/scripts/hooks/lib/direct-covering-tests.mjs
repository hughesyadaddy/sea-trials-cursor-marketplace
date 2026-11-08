/**
 * Explicit direct covering-test mapping for per-commit validation.
 * No package-wide or "related" test discovery — only convention-based
 * lib → test pairs and paths the caller supplied.
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
 * Whether `inPkgTestPath` directly covers `inPkgLibPath` per convention.
 *
 * @param {string} inPkgLibPath
 * @param {string} inPkgTestPath e.g. `test/foo_test.dart`
 */
export function testDirectlyCoversLib(inPkgLibPath, inPkgTestPath) {
  if (!inPkgTestPath.startsWith('test/') || !inPkgTestPath.endsWith('_test.dart')) {
    return false;
  }
  return candidateDirectTestRels(inPkgLibPath).includes(inPkgTestPath);
}

/**
 * Enforce explicit direct-test contract before analyze/test phases run.
 *
 * @param {{
 *   groups: Map<string, { pkgRel: string, lib: string[], test: string[],
 *     resolved: { repoRoot: string, flutterRoot: string } }>,
 *   explicitRepoRelPaths: Set<string>,
 * }} input
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function enforceDirectTestContract({ groups, explicitRepoRelPaths }) {
  for (const [, group] of groups) {
    const pkgCwd =
      group.pkgRel === '.'
        ? group.resolved.flutterRoot
        : path.join(group.resolved.flutterRoot, group.pkgRel);
    const prefix =
      group.pkgRel === '.' ? 'flutter/' : `flutter/${group.pkgRel}/`;

    for (const inPkgLib of group.lib) {
      const existing = existingDirectTestsForLib(pkgCwd, inPkgLib);
      if (existing.length === 0) {
        return {
          ok: false,
          message:
            `No direct covering test file on disk for ${prefix}${inPkgLib}. `
            + 'Add test/*_test.dart (convention: lib/foo.dart → test/foo_test.dart) '
            + 'and include it in this commit validation path list.',
        };
      }
    }

    for (const inPkgTest of group.test) {
      const coversAny = group.lib.some((inPkgLib) =>
        testDirectlyCoversLib(inPkgLib, inPkgTest),
      );
      if (group.lib.length > 0 && !coversAny) {
        return {
          ok: false,
          message:
            `Supplied test ${prefix}${inPkgTest} is not a direct cover for any `
            + 'changed lib file in this validation set.',
        };
      }
      if (group.lib.length === 0) {
        const repoRel = `${prefix}${inPkgTest}`;
        if (!explicitRepoRelPaths.has(repoRel)) {
          return {
            ok: false,
            message: `Test-only path ${repoRel} must be listed explicitly.`,
          };
        }
      }
    }
  }
  return { ok: true };
}

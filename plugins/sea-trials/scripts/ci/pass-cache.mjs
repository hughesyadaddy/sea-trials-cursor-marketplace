/**
 * Content-hash pass cache for PR Checks.
 *
 * A green lane records `dir:hash → passed`. A later run skips that
 * suite when the hash of every tracked file in the package plus its
 * direct workspace deps (and the workspace lockfile) still matches.
 * The candidate set stays PR-vs-merge-base; this only skips
 * *execution*. `HEAD~1` is never consulted.
 */

import { createHash } from 'node:crypto';

/** Bump when `very_good` args or the hash algorithm change. */
export const PASS_CACHE_SALT = 'v2-j4-presubmit-only';

/**
 * Salt stored in pass-cache JSON; includes resolved Flutter revision in CI.
 *
 * @returns {string}
 */
export function effectivePassCacheSalt() {
  const rev = process.env.FLUTTER_REVISION?.trim();
  if (!rev) return PASS_CACHE_SALT;
  return `${PASS_CACHE_SALT}:${rev}`;
}

/**
 * @returns {{salt: string, passed: Record<string, boolean>}}
 */
export function emptyPassCache() {
  return { salt: effectivePassCacheSalt(), passed: {} };
}

/**
 * @param {string} text
 * @returns {{salt: string, passed: Record<string, boolean>}}
 */
export function parsePassCache(text) {
  if (!text || !text.trim()) return emptyPassCache();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyPassCache();
  }
  if (
    parsed == null ||
    typeof parsed !== 'object' ||
    typeof parsed.passed !== 'object' ||
    parsed.passed == null
  ) {
    return emptyPassCache();
  }
  return {
    salt: typeof parsed.salt === 'string' ? parsed.salt : '',
    passed: { ...parsed.passed },
  };
}

/**
 * @param {{salt: string, passed: Record<string, boolean>}} cache
 * @param {string} dir
 * @param {string} hash
 * @returns {boolean}
 */
export function hasPassed(cache, dir, hash) {
  if (cache.salt !== effectivePassCacheSalt()) return false;
  return cache.passed[`${dir}:${hash}`] === true;
}

/**
 * @param {{salt: string, passed: Record<string, boolean>}} cache
 * @param {string} dir
 * @param {string} hash
 * @returns {{salt: string, passed: Record<string, boolean>}}
 */
export function recordPassed(cache, dir, hash) {
  return {
    salt: effectivePassCacheSalt(),
    passed: { ...cache.passed, [`${dir}:${hash}`]: true },
  };
}

/**
 * Parse `git ls-files -s` lines into `{path, blob}` entries.
 *
 * @param {string} stdout
 * @returns {{path: string, blob: string}[]}
 */
export function parseGitLsFilesS(stdout) {
  const entries = [];
  for (const line of stdout.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).trim().split(/\s+/);
    const blob = meta[1];
    const filePath = line.slice(tab + 1);
    if (blob && filePath) entries.push({ path: filePath, blob });
  }
  return entries;
}

/**
 * Hash a package plus its direct workspace deps.
 *
 * `entries` are tracked-file `{path, blob}` relative to `flutter/`
 * (or already matching `packageDir` prefixes). Every tracked file
 * under those dirs is included — no lib/test allowlist.
 *
 * @param {{
 *   packageDir: string,
 *   depDirs: string[],
 *   entries: {path: string, blob: string}[],
 *   lockfileBlob: string,
 *   salt?: string,
 * }} opts
 * @returns {string}
 */
export function packageInputHash({
  packageDir,
  depDirs,
  entries,
  lockfileBlob,
  salt = effectivePassCacheSalt(),
}) {
  const roots = [packageDir, ...depDirs];
  const relevant = entries
    .filter((e) =>
      roots.some((root) => e.path === root || e.path.startsWith(`${root}/`)),
    )
    .sort((a, b) => a.path.localeCompare(b.path));
  const payload = [
    salt,
    `lock:${lockfileBlob}`,
    ...relevant.map((e) => `${e.blob} ${e.path}`),
  ].join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

/**
 * Direct workspace dependency dirs of `packageDir`.
 *
 * Inverts `dependentsByName` so this module does not require a
 * `depsByName` field on the graph.
 *
 * @param {{
 *   nameByDir: Map<string, string>,
 *   dirByName: Map<string, string>,
 *   dependentsByName: Map<string, Set<string>>,
 * }} graph
 * @param {string} packageDir
 * @returns {string[]}
 */
export function directDepDirs(graph, packageDir) {
  const name = graph.nameByDir.get(packageDir);
  if (!name) return [];
  const dirs = [];
  for (const [depName, consumers] of graph.dependentsByName) {
    if (!consumers.has(name)) continue;
    const dir = graph.dirByName.get(depName);
    if (dir) dirs.push(dir);
  }
  return dirs.sort();
}

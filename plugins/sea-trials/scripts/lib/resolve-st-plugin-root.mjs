/**
 * Resolve the Sea Trials plugin root (parent of scripts/) on either host.
 *
 * Order:
 * 1. ST_PLUGIN_ROOT env (explicit override; must contain the marker)
 * 2. CLAUDE_PLUGIN_ROOT env (set by Claude Code inside hooks / MCP)
 * 3. tools/sea-trials-cursor-plugin emit tree in the current git repo
 *    (maintainer dev — beats any cache)
 * 4. Host plugin caches, newest marker mtime wins:
 *    - Cursor: ~/.cursor/plugins/cache/<marketplace>/sea-trials/<sha>
 *              ~/.cursor/plugins/local/sea-trials
 *    - Claude: ~/.claude/plugins/installed_plugins.json installPath
 *              ~/.claude/plugins/cache/<marketplace>/sea-trials/<version>
 *              ~/.claude/plugins/marketplaces/<name>/plugins/sea-trials
 * 5. Dev fallback: the plugin tree this module lives in (import.meta.url)
 *
 * Every candidate must contain `scripts/resolve-plugin-root.mjs`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const marker = 'scripts/resolve-plugin-root.mjs';
const pluginId = 'sea-trials';
const maxWalkDepth = 4;

/** Plugin tree containing this module (scripts/lib/ → plugin root). */
const selfRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

/**
 * @typedef {object} ResolveOptions
 * @property {string} [startDir] cwd used for git repo detection
 * @property {NodeJS.ProcessEnv} [env] environment (defaults to process.env)
 * @property {string} [homeDir] home directory (defaults to os.homedir())
 * @property {string | null} [selfRoot] dev fallback root; null disables
 * @property {boolean} [skipRepo] skip git repo emit-tree lookup (tests)
 */

/**
 * @param {string} dir
 * @returns {boolean}
 */
export function hasPluginMarker(dir) {
  return fs.existsSync(path.join(dir, marker));
}

/**
 * @param {string} dir
 * @returns {number}
 */
function markerMtime(dir) {
  try {
    return fs.statSync(path.join(dir, marker)).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Collect every plugin root under `baseDir` (depth-limited walk).
 *
 * @param {string} baseDir
 * @param {number} [depthLimit]
 * @returns {string[]}
 */
export function findPluginRoots(baseDir, depthLimit = maxWalkDepth) {
  if (!fs.existsSync(baseDir)) return [];
  /** @type {string[]} */
  const hits = [];

  /**
   * @param {string} dir
   * @param {number} depth
   */
  function walk(dir, depth) {
    if (hasPluginMarker(dir)) {
      hits.push(dir);
      return;
    }
    if (depth >= depthLimit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      walk(path.join(dir, entry.name), depth + 1);
    }
  }

  walk(baseDir, 0);
  return hits;
}

/**
 * Claude records exact install paths; prefer them over a blind walk.
 *
 * @param {string} homeDir
 * @returns {string[]}
 */
function claudeInstalledPaths(homeDir) {
  const file = path.join(homeDir, '.claude/plugins/installed_plugins.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const plugins = parsed?.plugins ?? {};
  /** @type {string[]} */
  const roots = [];
  for (const [key, installs] of Object.entries(plugins)) {
    if (!key.startsWith(`${pluginId}@`)) continue;
    for (const install of Array.isArray(installs) ? installs : [installs]) {
      const p = install?.installPath;
      if (typeof p === 'string' && hasPluginMarker(p)) roots.push(p);
    }
  }
  return roots;
}

/**
 * Enumerate every cached plugin root on both hosts.
 *
 * @param {string} homeDir
 * @returns {string[]}
 */
export function cacheCandidates(homeDir) {
  /** @type {string[]} */
  const roots = [...claudeInstalledPaths(homeDir)];

  const cursorCache = path.join(homeDir, '.cursor/plugins/cache');
  for (const marketplace of listDirs(cursorCache)) {
    roots.push(...findPluginRoots(path.join(marketplace, pluginId)));
  }
  const cursorLocal = path.join(homeDir, '.cursor/plugins/local', pluginId);
  roots.push(...findPluginRoots(cursorLocal));

  const claudeCache = path.join(homeDir, '.claude/plugins/cache');
  for (const marketplace of listDirs(claudeCache)) {
    roots.push(...findPluginRoots(path.join(marketplace, pluginId)));
  }
  const claudeMarkets = path.join(homeDir, '.claude/plugins/marketplaces');
  for (const marketplace of listDirs(claudeMarkets)) {
    const inMarket = path.join(marketplace, 'plugins', pluginId);
    roots.push(...findPluginRoots(inMarket));
  }

  return [...new Set(roots.map((r) => path.resolve(r)))];
}

/**
 * @param {string} dir
 * @returns {string[]} absolute child directory paths
 */
function listDirs(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => path.join(dir, e.name));
}

/**
 * @param {string[]} roots
 * @returns {string | null} newest root by marker mtime
 */
export function newestRoot(roots) {
  if (roots.length === 0) return null;
  return roots
    .map((root) => ({ root, mtime: markerMtime(root) }))
    .sort((a, b) => b.mtime - a.mtime)[0].root;
}

/**
 * @param {string} startDir
 * @returns {string | null}
 */
function gitRepoRoot(startDir) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
    cwd: startDir,
  });
  if (top.status !== 0) return null;
  return (top.stdout ?? '').trim();
}

/**
 * @param {string} repoRoot
 * @returns {string | null}
 */
function emitTreeInRepo(repoRoot) {
  const emit = path.join(repoRoot, 'tools/sea-trials-cursor-plugin');
  return hasPluginMarker(emit) ? emit : null;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} name
 * @param {boolean} strict throw when set but invalid
 * @returns {string | null}
 */
function envRoot(env, name, strict) {
  const raw = env[name]?.trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  if (hasPluginMarker(resolved)) return resolved;
  if (strict) {
    throw new Error(`${name} is set but missing ${marker}: ${resolved}`);
  }
  return null;
}

/**
 * @param {string | ResolveOptions} [startDirOrOptions]
 * @returns {string} absolute plugin root
 */
export function resolveStPluginRoot(startDirOrOptions) {
  /** @type {ResolveOptions} */
  const options =
    typeof startDirOrOptions === 'string'
      ? { startDir: startDirOrOptions }
      : (startDirOrOptions ?? {});
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const fallback =
    options.selfRoot === undefined ? selfRoot : options.selfRoot;

  const fromSt = envRoot(env, 'ST_PLUGIN_ROOT', true);
  if (fromSt) return fromSt;

  // Claude sets this for hooks/MCP; other plugins' roots are ignored.
  const fromClaude = envRoot(env, 'CLAUDE_PLUGIN_ROOT', false);
  if (fromClaude) return fromClaude;

  if (!options.skipRepo) {
    const repo = gitRepoRoot(options.startDir ?? process.cwd());
    if (repo) {
      const emit = emitTreeInRepo(repo);
      if (emit) return emit;
    }
  }

  const cached = newestRoot(cacheCandidates(homeDir));
  if (cached) return cached;

  if (fallback && hasPluginMarker(fallback)) return fallback;

  throw new Error(
    'Sea Trials plugin not found. Enable the sea-trials plugin '
      + '(Cursor Team Marketplace or Claude `/plugin install`), '
      + 'or set ST_PLUGIN_ROOT.',
  );
}

/**
 * Resolve Sea Trials Cursor plugin root (parent of scripts/).
 *
 * Order (inside a monorepo checkout):
 * 1. ST_PLUGIN_ROOT env
 * 2. tools/sea-trials-cursor-plugin emit tree (maintainer dev — beats cache)
 * 3. Team Marketplace cache
 *
 * Outside any checkout: env → cache only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const marker = 'scripts/resolve-plugin-root.mjs';

/**
 * @param {string} dir
 */
function hasPluginMarker(dir) {
  return fs.existsSync(path.join(dir, marker));
}

/**
 * @param {string} baseDir
 */
function findInCacheTree(baseDir) {
  if (!fs.existsSync(baseDir)) return null;
  /** @type {{ root: string, mtime: number }[]} */
  const hits = [];

  function walk(dir, depth) {
    if (depth > 6) return;
    if (hasPluginMarker(dir)) {
      try {
        const st = fs.statSync(path.join(dir, marker));
        hits.push({ root: dir, mtime: st.mtimeMs });
      } catch {
        hits.push({ root: dir, mtime: 0 });
      }
      return;
    }
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
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.mtime - a.mtime);
  return hits[0].root;
}

/**
 * @param {string} [startDir]
 */
function gitRepoRoot(startDir) {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    shell: isWindows,
    cwd: startDir ?? process.cwd(),
  });
  if (top.status !== 0) return null;
  return (top.stdout ?? '').trim();
}

/**
 * @param {string} repoRoot
 */
function emitTreeInRepo(repoRoot) {
  const emit = path.join(repoRoot, 'tools/sea-trials-cursor-plugin');
  return hasPluginMarker(emit) ? emit : null;
}

/**
 * @param {string} [startDir]
 */
export function resolveStPluginRoot(startDir) {
  if (process.env.ST_PLUGIN_ROOT?.trim()) {
    const envRoot = path.resolve(process.env.ST_PLUGIN_ROOT.trim());
    if (hasPluginMarker(envRoot)) return envRoot;
    throw new Error(
      `ST_PLUGIN_ROOT is set but missing ${marker}: ${envRoot}`,
    );
  }

  const cwd = startDir ?? process.cwd();
  const repo = gitRepoRoot(cwd);
  if (repo) {
    const emit = emitTreeInRepo(repo);
    if (emit) return emit;
  }

  const home = os.homedir();
  const cacheBases = [
    path.join(home, '.cursor/plugins/cache/__DEFAULT__/sea-trials'),
    path.join(home, '.cursor/plugins/cache/sea-trials-cursor-marketplace'),
    path.join(
      home,
      '.cursor/plugins/cache/hughesyadaddy-sea-trials-cursor-marketplace',
    ),
  ];

  for (const base of cacheBases) {
    const hit = findInCacheTree(base);
    if (hit) return hit;
  }

  throw new Error(
    'Sea Trials Cursor plugin not found. Run pnpm sync-sea-trials-plugin, '
      + 'enable the sea-trials Team Marketplace plugin, or set ST_PLUGIN_ROOT.',
  );
}

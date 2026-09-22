/**
 * Where the plugin lives and which checkout it operates on.
 *
 * The plugin is installed outside the app repo (Cursor/Claude plugin
 * cache or a marketplace dev checkout), so nothing here may derive the
 * repo root from `import.meta.url`. `st-run.mjs` sets both env vars;
 * direct `node $ST_PLUGIN_ROOT/scripts/ci/x.mjs` invocations from CI
 * fall back to the git toplevel of the current working directory.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';

/** Absolute path of this plugin's root (the directory holding scripts/). */
export function pluginRoot() {
  if (process.env.ST_PLUGIN_ROOT?.trim()) {
    return path.resolve(process.env.ST_PLUGIN_ROOT.trim());
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}

/**
 * Absolute path of a file inside the plugin.
 *
 * @param {string} rel plugin-relative path, e.g. `scripts/ci/run-lane.mjs`
 */
export function pluginPath(rel) {
  return path.join(pluginRoot(), rel);
}

/**
 * Root of the checkout being gated: `ST_REPO_ROOT`, else the git
 * toplevel of `cwd`, else `cwd` itself.
 *
 * @param {string} [cwd]
 */
export function resolveRepoRoot(cwd = process.cwd()) {
  if (process.env.ST_REPO_ROOT?.trim()) {
    return path.resolve(process.env.ST_REPO_ROOT.trim());
  }
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    cwd,
    shell: isWindows,
  });
  if (top.status === 0 && (top.stdout ?? '').trim()) {
    return (top.stdout ?? '').trim();
  }
  return cwd;
}

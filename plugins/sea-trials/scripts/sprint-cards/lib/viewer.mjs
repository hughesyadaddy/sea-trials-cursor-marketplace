/**
 * Thin wrapper around sprint-plan-viewer
 * (https://github.com/hughesyadaddy/sprint-plan-viewer), which each
 * project adds as a git submodule of its sprint planning repo. This plugin
 * does not ship a viewer of its own.
 *
 * Lookup order: --viewer DIR, $SPRINT_PLAN_VIEWER, then a
 * `sprint-plan-viewer/` folder (with `spv.py`) in the sprint folder or any
 * folder above it, up to the git root.
 *
 * Every viewer command is `python3 sprint-plan-viewer/spv.py <cmd> --plan
 * <sprint folder> ...`, run from the folder that holds the viewer. Its
 * README is the source of truth for its options.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VIEWER_DIR_NAME = 'sprint-plan-viewer';
export const VIEWER_REPO_URL = 'https://github.com/hughesyadaddy/sprint-plan-viewer.git';
export const VIEWER_SETUP = `sprint-plan-viewer not found. In the sprint planning repo run: git submodule add ${VIEWER_REPO_URL} sprint-plan-viewer (or, after a clone, git submodule update --init sprint-plan-viewer). Or pass --viewer DIR / set SPRINT_PLAN_VIEWER.`;

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Python to run the viewer with: $SPV_PYTHON, else python3 (python on Windows). */
export function viewerPython(env = process.env, platform = process.platform) {
  return env.SPV_PYTHON || (platform === 'win32' ? 'python' : 'python3');
}

/**
 * @param {string} sprintDir
 * @param {{ viewer?: string, env?: object }} [o]
 * @returns {{ dir: string, spv: string, python: string } | null}
 */
export function findViewer(sprintDir, o = {}) {
  const env = o.env ?? process.env;
  const candidates = [];
  if (o.viewer) candidates.push(path.resolve(o.viewer));
  if (env.SPRINT_PLAN_VIEWER) candidates.push(path.resolve(env.SPRINT_PLAN_VIEWER));
  let cur = path.resolve(sprintDir);
  for (;;) {
    candidates.push(path.join(cur, VIEWER_DIR_NAME));
    if (fs.existsSync(path.join(cur, '.git'))) break;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  for (const d of candidates) {
    // An uninitialised submodule is an empty folder: skip it.
    if (isDir(d) && fs.existsSync(path.join(d, 'spv.py'))) return { dir: d, spv: path.join(d, 'spv.py'), python: viewerPython(env) };
  }
  return null;
}

/** argv for `spv.py <cmd> --plan <sprint dir> ...extra` (no shell is used). */
export function viewerArgs(v, cmd, sprintDir, extra = []) {
  return [v.spv, cmd, '--plan', path.resolve(sprintDir), ...extra];
}

/** One-line description for logs and dry runs (no secrets, no env). */
export function viewerDisplay(v, cmd, sprintDir, extra = []) {
  return `${v.python} ${path.join(path.basename(v.dir), 'spv.py')} ${cmd} --plan ${path.resolve(sprintDir)} ${extra.join(' ')}`.trim();
}

/**
 * Run a viewer command in the foreground from the folder that holds the
 * viewer; resolves with its exit code. `env` is passed to the child only.
 */
export function runViewer(v, cmd, sprintDir, extra = [], o = {}) {
  return new Promise((resolve) => {
    const child = spawn(v.python, viewerArgs(v, cmd, sprintDir, extra), { cwd: path.dirname(v.dir), stdio: o.stdio ?? 'inherit', env: o.env ?? process.env });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`could not start the viewer (${v.python}): ${err.message}\n`);
      resolve(2);
    });
  });
}

/**
 * Thin wrapper around the sprint-plan-viewer repo, which each project
 * adds as a git submodule of its sprint planning repo. This plugin does
 * not ship a viewer of its own.
 *
 * Lookup order: --viewer DIR, $SPRINT_PLAN_VIEWER, then a
 * `sprint-plan-viewer/` folder in the sprint folder or any folder above
 * it, up to the git root.
 *
 * Launch: the first entry point found in the viewer folder, given the
 * sprint folder as its argument: `bin/sprint-plan-viewer`, the package
 * `bin`, `cli.mjs`, `server.mjs`, `server.py`. The viewer's own README
 * is the source of truth for its options.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const VIEWER_DIR_NAME = 'sprint-plan-viewer';

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** The command that starts the viewer in `dir`, or null. */
export function viewerEntry(dir) {
  const bin = path.join(dir, 'bin', VIEWER_DIR_NAME);
  if (fs.existsSync(bin)) return { cmd: bin, args: [] };
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const b = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin && Object.values(pkg.bin)[0];
    if (b) return { cmd: process.execPath, args: [path.join(dir, b)] };
  } catch {
    // no package.json
  }
  for (const f of ['cli.mjs', 'server.mjs']) {
    if (fs.existsSync(path.join(dir, f))) return { cmd: process.execPath, args: [path.join(dir, f)] };
  }
  if (fs.existsSync(path.join(dir, 'server.py'))) return { cmd: 'python3', args: [path.join(dir, 'server.py')] };
  return null;
}

/**
 * @param {string} sprintDir
 * @param {{ viewer?: string, env?: object }} [o]
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
    if (!isDir(d)) continue;
    const entry = viewerEntry(d);
    if (entry) return { dir: d, ...entry, display: [entry.cmd, ...entry.args].map((x) => path.basename(x)).join(' ') };
  }
  return null;
}

/** Run the viewer in the foreground; resolves with its exit code. */
export function runViewer(v, sprintDir, o = {}) {
  const args = [...v.args, path.resolve(sprintDir), ...(o.port ? ['--port', String(o.port)] : [])];
  return new Promise((resolve) => {
    const child = spawn(v.cmd, args, { cwd: v.dir, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      process.stderr.write(`could not start the viewer: ${err.message}\n`);
      resolve(2);
    });
  });
}

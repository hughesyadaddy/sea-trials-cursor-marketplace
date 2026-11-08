/**
 * Scoped non-Dart checks for per-commit validation (not Dart analyze).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd,
    shell: isWindows,
    stdio: 'pipe',
  });
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/**
 * @param {string} repoRoot
 * @param {string} repoRel
 */
function checkOneNonDartPath(repoRoot, repoRel) {
  const abs = path.join(repoRoot, repoRel);
  const norm = repoRel.replace(/\\/g, '/');

  if (norm.endsWith('.md') || norm.endsWith('.mdx')) {
    return { ok: true, label: `docs ${norm}`, stdout: 'no analyzer for docs' };
  }

  if (norm.endsWith('.test.mjs') && fs.existsSync(abs)) {
    const r = run(process.execPath, ['--test', abs], repoRoot);
    return {
      ok: r.ok,
      label: `node --test ${norm}`,
      stdout: r.stdout,
      stderr: r.stderr,
      status: r.status,
    };
  }

  if (norm.endsWith('.mjs') || norm.endsWith('.js')) {
    const siblingTest = norm.endsWith('.mjs')
      ? norm.replace(/\.mjs$/, '.test.mjs')
      : norm.replace(/\.js$/, '.test.js');
    if (fs.existsSync(path.join(repoRoot, siblingTest))) {
      const r2 = run(process.execPath, ['--test', siblingTest], repoRoot);
      return {
        ok: r2.ok,
        label: `node --test ${siblingTest}`,
        stdout: r2.stdout,
        stderr: r2.stderr,
        status: r2.status,
      };
    }
    if (fs.existsSync(abs)) {
      const r = run(process.execPath, ['--check', abs], repoRoot);
      return {
        ok: r.ok,
        label: `node --check ${norm}`,
        stdout: r.stdout,
        stderr: r.stderr,
        status: r.status,
      };
    }
    return { ok: false, label: norm, stderr: 'missing file', status: 2 };
  }

  if (norm.endsWith('.json')) {
    try {
      JSON.parse(fs.readFileSync(abs, 'utf8'));
      return { ok: true, label: `json parse ${norm}` };
    } catch (err) {
      return { ok: false, label: norm, stderr: String(err), status: 2 };
    }
  }

  if (
    norm.endsWith('.yaml')
    || norm.endsWith('.yml')
    || norm.endsWith('.sh')
  ) {
    if (!fs.existsSync(abs)) {
      return { ok: false, label: norm, stderr: 'missing file', status: 2 };
    }
    return { ok: true, label: `presence ${norm}`, stdout: 'no scoped linter configured' };
  }

  return {
    ok: false,
    label: norm,
    stderr:
      `No scoped validation rule for ${norm}. ` +
      'Run the applicable analyzer for that surface or narrow the path list.',
    status: 2,
  };
}

/**
 * @param {string} repoRoot
 * @param {string[]} nondartPaths repo-relative
 * @returns {{ ok: boolean, steps: Array<Record<string, unknown>> }}
 */
export function runScopedNonDartChecks(repoRoot, nondartPaths) {
  if (nondartPaths.length === 0) {
    return { ok: true, steps: [] };
  }
  /** @type {Array<Record<string, unknown>>} */
  const steps = [];
  let failed = false;
  for (const rel of [...new Set(nondartPaths)]) {
    const step = checkOneNonDartPath(repoRoot, rel);
    steps.push(step);
    if (!step.ok) failed = true;
  }
  return { ok: !failed, steps };
}

/**
 * Push-gate pass token — lets the pre-push hook skip a gate that
 * `pr-review-push` just ran on the very same tree.
 *
 * `pr-review-push` runs dirty + committed-diff + CI lanes, then calls
 * `git push`, which fires the husky pre-push hook, which re-ran the
 * committed-diff gate from scratch: the same `dart analyze` twice in a
 * row, minutes apart, on an unchanged tree. The token records what was
 * verified; the hook honours it only when HEAD, the working-tree
 * fingerprint and `ST_REVIEW_PUSH` all still match and the token is
 * fresh. Anything else falls through to the full gate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/** Tokens older than this are ignored even when everything matches. */
export const GATE_PASS_MAX_AGE_MS = 20 * 60 * 1000;

const TOKEN_FILE = 'st-push-gate-pass.json';

function git(repoRoot, args) {
  const result = spawnSync('git', args, {
    encoding: 'utf8',
    cwd: repoRoot,
    shell: isWindows,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trimEnd();
}

/** @param {string} repoRoot */
export function gatePassTokenPath(repoRoot) {
  const gitPath = git(repoRoot, ['rev-parse', '--git-path', TOKEN_FILE]);
  return gitPath
    ? path.resolve(repoRoot, gitPath)
    : path.join(repoRoot, '.git', TOKEN_FILE);
}

/**
 * Fingerprint of the working tree relative to HEAD: `git status`
 * porcelain plus a hash of the unstaged/staged diff. Changes to any
 * tracked file (or a new untracked one) change it.
 *
 * @param {string} repoRoot
 */
export function workingTreeFingerprint(repoRoot) {
  const status = git(repoRoot, ['status', '--porcelain=v1', '-uall']) ?? '';
  const diff = git(repoRoot, ['diff', 'HEAD', '--stat=200']) ?? '';
  return crypto
    .createHash('sha256')
    .update(status)
    .update('\n--\n')
    .update(diff)
    .digest('hex');
}

/**
 * @param {string} repoRoot
 * @param {{ headOid: string, phases: Iterable<string>, prNumber?: number | null }} info
 */
export function writeGatePassToken(repoRoot, info) {
  const token = {
    headOid: info.headOid,
    tree: workingTreeFingerprint(repoRoot),
    phases: [...info.phases],
    prNumber: info.prNumber ?? null,
    at: new Date().toISOString(),
    pid: process.pid,
  };
  const file = gatePassTokenPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(token, null, 2)}\n`);
  return token;
}

/** @param {string} repoRoot */
export function clearGatePassToken(repoRoot) {
  try {
    fs.unlinkSync(gatePassTokenPath(repoRoot));
  } catch {
    // nothing to clear
  }
}

/**
 * Pure check used by the hook. `now` and `env` are injectable for tests.
 *
 * @param {{
 *   token: unknown,
 *   headOid: string,
 *   tree: string,
 *   requiredPhase: string,
 *   env?: NodeJS.ProcessEnv,
 *   now?: number,
 *   maxAgeMs?: number,
 * }} ctx
 * @returns {{ ok: boolean, reason: string, ageMs?: number }}
 */
export function evaluateGatePassToken({
  token,
  headOid,
  tree,
  requiredPhase,
  env = process.env,
  now = Date.now(),
  maxAgeMs = GATE_PASS_MAX_AGE_MS,
}) {
  if ((env.ST_PREPUSH_FORCE ?? '').trim() === '1') {
    return { ok: false, reason: 'ST_PREPUSH_FORCE=1' };
  }
  if ((env.ST_REVIEW_PUSH ?? '').trim() !== headOid) {
    return { ok: false, reason: 'push not issued by pr-review-push' };
  }
  if (!token || typeof token !== 'object') {
    return { ok: false, reason: 'no gate token' };
  }
  const t = /** @type {Record<string, unknown>} */ (token);
  if (t.headOid !== headOid) {
    return { ok: false, reason: 'gate token is for a different HEAD' };
  }
  if (t.tree !== tree) {
    return { ok: false, reason: 'working tree changed since the gate ran' };
  }
  if (!Array.isArray(t.phases) || !t.phases.includes(requiredPhase)) {
    return { ok: false, reason: `gate token lacks phase ${requiredPhase}` };
  }
  const at = Date.parse(String(t.at ?? ''));
  if (!Number.isFinite(at)) {
    return { ok: false, reason: 'gate token has no timestamp' };
  }
  const ageMs = now - at;
  if (ageMs < 0 || ageMs > maxAgeMs) {
    return { ok: false, reason: 'gate token is stale', ageMs };
  }
  return { ok: true, reason: 'gate already passed for this HEAD', ageMs };
}

/**
 * Read + evaluate the on-disk token for the current tree.
 *
 * @param {string} repoRoot
 * @param {{ requiredPhase: string, env?: NodeJS.ProcessEnv }} opts
 */
export function checkGatePassToken(repoRoot, { requiredPhase, env }) {
  const headOid = git(repoRoot, ['rev-parse', 'HEAD']) ?? '';
  let token = null;
  try {
    token = JSON.parse(fs.readFileSync(gatePassTokenPath(repoRoot), 'utf8'));
  } catch {
    token = null;
  }
  // Cheap checks first: the tree fingerprint shells out to git twice.
  const preliminary = evaluateGatePassToken({
    token,
    headOid,
    tree: token && typeof token === 'object' ? token.tree : '',
    requiredPhase,
    env,
  });
  if (!preliminary.ok) return preliminary;
  return evaluateGatePassToken({
    token,
    headOid,
    tree: workingTreeFingerprint(repoRoot),
    requiredPhase,
    env,
  });
}

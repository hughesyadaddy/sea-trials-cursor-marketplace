/**
 * Persist the last successful per-commit scoped validation so push can
 * reuse it when HEAD and tree are unchanged (not only husky dedupe).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { workingTreeFingerprint } from './gate-pass-token.mjs';

const isWindows = process.platform === 'win32';
const RECORD_FILE = 'st-commit-validate.json';

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
export function commitValidateRecordPath(repoRoot) {
  const gitPath = git(repoRoot, ['rev-parse', '--git-path', RECORD_FILE]);
  return gitPath
    ? path.resolve(repoRoot, gitPath)
    : path.join(repoRoot, '.git', RECORD_FILE);
}

/**
 * @param {string[]} repoRelPaths sorted unique
 */
export function scopeFingerprint(repoRelPaths) {
  const sorted = [...repoRelPaths].map((p) => p.replace(/\\/g, '/')).sort();
  return crypto.createHash('sha256').update(sorted.join('\n')).digest('hex');
}

/**
 * @param {string} repoRoot
 * @param {{
 *   ok: boolean,
 *   validateFingerprint: string,
 *   scopePaths: string[],
 *   headOid?: string,
 * }} payload
 */
export function writeCommitValidateRecord(repoRoot, payload) {
  const headOid = payload.headOid ?? git(repoRoot, ['rev-parse', 'HEAD']) ?? '';
  const record = {
    headOid,
    tree: workingTreeFingerprint(repoRoot),
    ok: payload.ok,
    validateFingerprint: payload.validateFingerprint,
    scopePaths: [...payload.scopePaths].sort(),
    scopeFingerprint: scopeFingerprint(payload.scopePaths),
    at: new Date().toISOString(),
  };
  const file = commitValidateRecordPath(repoRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * @param {string} repoRoot
 * @param {{
 *   scopePaths: string[],
 *   validateFingerprint?: string,
 * }} expected
 */
export function commitValidateIsTrusted(repoRoot, { scopePaths, validateFingerprint }) {
  const file = commitValidateRecordPath(repoRoot);
  let record;
  try {
    record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'no commit-validate record' };
  }
  const headOid = git(repoRoot, ['rev-parse', 'HEAD']) ?? '';
  if (record.headOid !== headOid) {
    return { ok: false, reason: 'HEAD changed since commit validation' };
  }
  if (record.tree !== workingTreeFingerprint(repoRoot)) {
    return { ok: false, reason: 'working tree changed since commit validation' };
  }
  if (!record.ok) {
    return { ok: false, reason: 'last commit validation failed' };
  }
  const wantScope = scopeFingerprint(scopePaths);
  if (record.scopeFingerprint !== wantScope) {
    return { ok: false, reason: 'scope paths differ from commit validation' };
  }
  if (
    validateFingerprint
    && record.validateFingerprint
    && record.validateFingerprint !== validateFingerprint
  ) {
    return { ok: false, reason: 'validate fingerprint mismatch' };
  }
  return { ok: true, reason: 'reusing commit validation', record };
}

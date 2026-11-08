/**
 * Persist scoped validation so push can reuse commit-time results.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  scopePathsByteFingerprint,
  workingTreeByteFingerprint,
} from './scope-tree-fingerprint.mjs';

const isWindows = process.platform === 'win32';
const RECORD_FILE = 'st-commit-validate.json';

/** @typedef {'full' | 'analyze-only' | 'tests-only'} ValidateMode */

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
 *   mode?: ValidateMode,
 *   testsExecuted?: boolean,
 *   analyzeExecuted?: boolean,
 *   hadLibChanges?: boolean,
 * }} payload
 */
export function writeCommitValidateRecord(repoRoot, payload) {
  const headOid = payload.headOid ?? git(repoRoot, ['rev-parse', 'HEAD']) ?? '';
  const scopePaths = [...payload.scopePaths].sort();
  const record = {
    headOid,
    tree: workingTreeByteFingerprint(repoRoot),
    scopeBytes: scopePathsByteFingerprint(repoRoot, scopePaths),
    ok: payload.ok,
    mode: payload.mode ?? 'full',
    testsExecuted: Boolean(payload.testsExecuted),
    analyzeExecuted: payload.analyzeExecuted !== false,
    hadLibChanges: Boolean(payload.hadLibChanges),
    validateFingerprint: payload.validateFingerprint ?? '',
    scopePaths,
    scopeFingerprint: scopeFingerprint(scopePaths),
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
 *   validateFingerprint: string,
 *   requireMode?: ValidateMode,
 * }} expected
 */
export function commitValidateIsTrusted(
  repoRoot,
  { scopePaths, validateFingerprint, requireMode = 'full' },
) {
  if (!validateFingerprint?.trim()) {
    return { ok: false, reason: 'validateFingerprint required' };
  }
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
  if (record.tree !== workingTreeByteFingerprint(repoRoot)) {
    return { ok: false, reason: 'working tree changed since commit validation' };
  }
  const scopePathsNorm = [...scopePaths].map((p) => p.replace(/\\/g, '/')).sort();
  const bytesNow = scopePathsByteFingerprint(repoRoot, scopePathsNorm);
  const bytesStored = record.scopeBytes
    ?? scopePathsByteFingerprint(repoRoot, record.scopePaths ?? []);
  if (bytesNow !== bytesStored) {
    return { ok: false, reason: 'scope file bytes/index changed' };
  }
  if (!record.ok) {
    return { ok: false, reason: 'last commit validation failed' };
  }
  if (record.mode !== requireMode) {
    return { ok: false, reason: `record mode ${record.mode} !== ${requireMode}` };
  }
  if (requireMode === 'full') {
    if (record.mode === 'analyze-only' || record.mode === 'tests-only') {
      return { ok: false, reason: 'partial validation cannot authorize full reuse' };
    }
    if (record.hadLibChanges && !record.testsExecuted) {
      return { ok: false, reason: 'tests were not executed at commit time' };
    }
  }
  const wantScope = scopeFingerprint(scopePaths);
  if (record.scopeFingerprint !== wantScope) {
    return { ok: false, reason: 'scope paths differ from commit validation' };
  }
  if (record.validateFingerprint !== validateFingerprint) {
    return { ok: false, reason: 'validate fingerprint mismatch' };
  }
  return { ok: true, reason: 'reusing commit validation', record };
}

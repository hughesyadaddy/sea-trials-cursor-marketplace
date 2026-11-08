/**
 * Orchestrator: partition paths, run Dart via agent-validate-changed,
 * non-Dart via scoped checks, optional reuse of commit validation record.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  commitValidateIsTrusted,
  writeCommitValidateRecord,
} from './commit-validate-record.mjs';
import {
  isDocsOnlySet,
  partitionRepoPaths,
} from './per-commit-paths.mjs';
import { runScopedNonDartChecks } from './scoped-non-dart-checks.mjs';
import fs from 'node:fs';
import { commitValidateRecordPath } from './commit-validate-record.mjs';

const isWindows = process.platform === 'win32';
const hooksDir = path.dirname(fileURLToPath(import.meta.url));

const validateScript = path.join(hooksDir, '..', 'agent-validate-changed.mjs');

/**
 * @param {string} repoRoot
 * @param {string[]} repoRelPaths
 * @param {{ reuseCommitRecord?: boolean, writeRecord?: boolean }} [opts]
 */
export function runScopedPerCommitValidate(
  repoRoot,
  repoRelPaths,
  opts = {},
) {
  const unique = [...new Set(repoRelPaths.map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean))];
  const reuse = opts.reuseCommitRecord !== false;
  const writeRecord = opts.writeRecord !== false;

  if (unique.length === 0) {
    return {
      ok: true,
      steps: [{ name: 'scoped-validate', ok: true, stdout: 'No paths' }],
      skipped: false,
    };
  }

  if (reuse) {
    let recordFp = '';
    try {
      const raw = fs.readFileSync(commitValidateRecordPath(repoRoot), 'utf8');
      recordFp = JSON.parse(raw).validateFingerprint ?? '';
    } catch {
      // no record
    }
    const trust = commitValidateIsTrusted(repoRoot, {
      scopePaths: unique,
      validateFingerprint: recordFp,
      requireMode: 'full',
    });
    if (trust.ok) {
      return {
        ok: true,
        steps: [{
          name: 'scoped-validate',
          ok: true,
          stdout: `Reused commit validation (${trust.reason})`,
        }],
        skipped: true,
      };
    }
  }

  if (isDocsOnlySet(unique)) {
    return {
      ok: true,
      steps: [{ name: 'scoped-validate', ok: true, stdout: 'Docs only' }],
      skipped: false,
    };
  }

  const { dart, nondart, docs, other } = partitionRepoPaths(unique);
  /** @type {Array<Record<string, unknown>>} */
  const steps = [];

  if (other.length > 0) {
    return {
      ok: false,
      steps: [{
        name: 'scoped-validate',
        ok: false,
        stderr:
          `Unclassified path(s): ${other.join(', ')}. `
          + 'Narrow to Dart, docs, or a surface with a scoped check.',
      }],
      skipped: false,
    };
  }

  if (nondart.length > 0) {
    const nd = runScopedNonDartChecks(repoRoot, nondart);
    steps.push(...nd.steps.map((s) => ({ name: 'non-dart', ...s })));
    if (!nd.ok) {
      return { ok: false, steps, skipped: false };
    }
  }

  for (const doc of docs) {
    steps.push({ name: 'docs', ok: true, stdout: `skipped ${doc}` });
  }

  let validateFingerprint = '';
  if (dart.length > 0) {
    const result = spawnSync(
      process.execPath,
      [validateScript, ...dart],
      {
        cwd: repoRoot,
        stdio: 'pipe',
        shell: isWindows,
        encoding: 'utf8',
        env: {
          ...process.env,
          ST_AGENT_VALIDATE_WRITE_RECORD: writeRecord ? '1' : '0',
        },
      },
    );
    const fpMatch = (result.stdout ?? '').match(/validate-fingerprint=([a-f0-9]+)/);
    if (fpMatch) validateFingerprint = fpMatch[1];
    if (result.status !== 0) {
      const err = [result.stderr, result.stdout].filter(Boolean).join('\n');
      steps.push({ name: 'dart', ok: false, stderr: err });
      return { ok: false, steps, skipped: false };
    }
    steps.push({
      name: 'dart',
      ok: true,
      stdout: (result.stdout ?? '').trim() || 'OK',
    });
  } else if (nondart.length === 0 && docs.length > 0) {
    return { ok: true, steps, skipped: false };
  }

  if (writeRecord) {
    const hadLibChanges = dart.some((p) => p.includes('/lib/'));
    writeCommitValidateRecord(repoRoot, {
      ok: true,
      validateFingerprint,
      scopePaths: unique,
      mode: 'full',
      testsExecuted: dart.length > 0 && Boolean(validateFingerprint),
      analyzeExecuted: dart.length > 0,
      hadLibChanges,
    });
  }

  return { ok: true, steps, skipped: false, validateFingerprint };
}

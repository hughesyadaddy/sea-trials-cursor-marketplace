/**
 * Shared fingerprint inputs for agent-validate (child + trust checks).
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeFingerprint } from './single-flight.mjs';
import { buildRequirementsIdentity } from './validate-requirements-identity.mjs';

const isWindows = process.platform === 'win32';

function capture(cmd, args) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/** @param {{ repoRoot: string, repoRel: string }[]} resolvedFiles */
export function changeSetFiles(resolvedFiles) {
  return resolvedFiles.map((f) => path.join(f.repoRoot, f.repoRel));
}

/**
 * @param {{ repoRoot: string, repoRel: string }[]} resolvedFiles
 */
export function collectFingerprintInputs(resolvedFiles) {
  const repoRoots = [...new Set(resolvedFiles.map((f) => f.repoRoot))].sort();
  const heads = [];
  const dirty = new Set();
  for (const root of repoRoots) {
    const head = capture('git', ['-C', root, 'rev-parse', 'HEAD']) ?? '';
    heads.push(`${root}=${head}`);
    const listings = [
      capture('git', ['-C', root, 'diff', '--name-only']) ?? '',
      capture('git', ['-C', root, 'diff', '--name-only', '--cached']) ?? '',
      capture('git', [
        '-C',
        root,
        'ls-files',
        '--others',
        '--exclude-standard',
      ]) ?? '',
    ];
    for (const out of listings) {
      for (const rel of out
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)) {
        dirty.add(path.join(root, rel));
      }
    }
  }
  const files = [...new Set([...changeSetFiles(resolvedFiles), ...dirty])];
  return { files, heads };
}

/**
 * @param {{
 *   resolvedFiles: { repoRoot: string, repoRel: string }[],
 *   flags?: string[],
 *   requirementsIdentity: string,
 * }} input
 */
export function computeValidateFingerprint(input) {
  const fpInputs = collectFingerprintInputs(input.resolvedFiles);
  return computeFingerprint({
    files: fpInputs.files,
    heads: fpInputs.heads,
    flags: input.flags ?? [],
    identity: input.requirementsIdentity ?? '',
  });
}

/**
 * @param {string} repoRoot
 * @param {string[]} dartRepoRelPaths
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   requirementsIdentity: string,
 * }} opts
 */
export function computeValidateFingerprintForDartScope(
  repoRoot,
  dartRepoRelPaths,
  { env = process.env, requirementsIdentity },
) {
  const resolved = dartRepoRelPaths.map((repoRel) => ({
    repoRoot,
    repoRel: repoRel.replace(/\\/g, '/'),
  }));
  return computeValidateFingerprint({
    resolvedFiles: resolved,
    flags: [],
    requirementsIdentity,
  });
}

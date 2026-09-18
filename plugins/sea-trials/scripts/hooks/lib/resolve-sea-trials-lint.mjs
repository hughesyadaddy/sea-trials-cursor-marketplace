import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {unknown} repoRoot
 * @returns {string}
 */
function normalizeRepoRoot(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    throw new TypeError('repoRoot must be a non-empty string');
  }
  return path.resolve(repoRoot);
}

/**
 * @param {string} root
 * @returns {string[]}
 */
function seaTrialsLintCandidatePaths(root) {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return [
    path.join(root, 'tools', 'sea-trials-lint', 'bin', `sea-trials-lint${ext}`),
    path.join(root, 'tools', 'sea-trials-lint', 'target', 'release', `sea-trials-lint${ext}`),
  ];
}

/**
 * @param {unknown} repoRoot
 * @returns {boolean}
 */
export function hasSeaTrialsLintBinary(repoRoot) {
  const root = normalizeRepoRoot(repoRoot);
  return seaTrialsLintCandidatePaths(root).some((p) => {
    try {
      if (!fs.existsSync(p)) return false;
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * @param {unknown} repoRoot
 * @returns {string[]}
 */
export function getSeaTrialsLintCmd(repoRoot) {
  const root = normalizeRepoRoot(repoRoot);
  for (const binPath of seaTrialsLintCandidatePaths(root)) {
    try {
      if (fs.existsSync(binPath) && fs.statSync(binPath).isFile()) {
        return [binPath];
      }
    } catch {
      continue;
    }
  }

  throw new Error(
    'sea-trials-lint binary not found.\n' +
    'Run: pnpm ensure-lint\n' +
    'Or: cd tools/sea-trials-lint && cargo build --release',
  );
}

/**
 * Fingerprint `tools/sea-trials-lint/**` for binary cache keys.
 *
 * Intentionally excludes lane-infrastructure paths and `flutter/**` so a
 * Dart-only commit reuses the cached `sea-trials-lint` binary in CI.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
  fingerprintFromRevParse,
  revParseSpec,
  treePathsFromGlobs,
} from './pr-lane-paths.mjs';

export const LINT_SOURCE_GLOBS = ['tools/sea-trials-lint/**'];

function gitLines(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`,
    );
  }
  return (result.stdout ?? '').trim();
}

/**
 * @returns {string} stable multi-line tree fingerprint
 */
export function lintSourceFingerprint() {
  const paths = treePathsFromGlobs(LINT_SOURCE_GLOBS);
  const lines = paths.map((p) => {
    try {
      return gitLines(['rev-parse', revParseSpec(p)]);
    } catch {
      return 'missing';
    }
  });
  return fingerprintFromRevParse(lines.join('\n'), paths);
}

/**
 * @returns {string} sha256 hex digest for actions/cache keys
 */
export function lintSourceCacheKey() {
  return createHash('sha256').update(lintSourceFingerprint()).digest('hex');
}

/* c8 ignore start */
function main() {
  process.stdout.write(`${lintSourceCacheKey()}\n`);
}

if (process.argv[1]?.endsWith('lint-source-key.mjs')) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`lint-source-key: ${err.message}\n`);
    process.exit(2);
  }
}
/* c8 ignore stop */

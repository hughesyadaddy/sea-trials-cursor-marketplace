/**
 * Whether the latest commit (or push range) touched lint sources.
 *
 * GitHub `pull_request.paths` matches any commit in the PR, so the
 * standalone `Build sea-trials-lint` workflow can rerun on every sync
 * after a single lint edit. This helper scopes to HEAD only.
 */

import { anyPathMatches } from './pr-lane-paths.mjs';
import { LINT_SOURCE_GLOBS } from './lint-source-key.mjs';
import { changedFilesVsBase } from '../hooks/pr-local-ci.mjs';
import {
  changedFilesForCiPush,
  changedFilesInHeadCommit as headCommitFiles,
  changedFilesInPushRange,
  resolveHeadCommitRef,
} from './pr-push-changed-files.mjs';

export { resolveHeadCommitRef as resolveLintGateCommitRef };
export { headCommitFiles as changedFilesInHeadCommit };
export { changedFilesInPushRange };

/**
 * @param {string[]} changedFiles
 * @returns {boolean}
 */
export function headTouchesLint(changedFiles) {
  return anyPathMatches(changedFiles, LINT_SOURCE_GLOBS);
}

/**
 * @param {string | undefined} before
 * @param {string | undefined} after
 * @returns {string[]}
 */
export function changedFilesForLintGate({ before, after } = {}) {
  if (before !== undefined || after !== undefined) {
    return changedFilesForCiPush({ before, after });
  }
  return headCommitFiles();
}

/**
 * @param {{ before?: string, after?: string }} [range]
 * @returns {boolean}
 */
export function shouldBuildLintMatrix(range = {}) {
  const files = changedFilesForLintGate(range);
  return headTouchesLint(files);
}

/**
 * @param {string} base
 * @param {string} [repoRoot]
 * @returns {boolean}
 */
export function lintTouchedVsBase(base, repoRoot) {
  return headTouchesLint(changedFilesVsBase(base, repoRoot));
}

/* c8 ignore start */
function main() {
  const args = process.argv.slice(2);
  let before;
  let after;
  let base;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--before') {
      before = args[i + 1];
      i += 1;
    } else if (args[i] === '--after') {
      after = args[i + 1];
      i += 1;
    } else if (args[i] === '--base') {
      base = args[i + 1];
      i += 1;
    }
  }
  const touched = base
    ? lintTouchedVsBase(base)
    : shouldBuildLintMatrix({ before, after });
  process.stdout.write(`touched=${touched ? 'true' : 'false'}\n`);
}

if (process.argv[1]?.endsWith('head-touches-lint.mjs')) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`head-touches-lint: ${err.message}\n`);
    process.exit(2);
  }
}
/* c8 ignore stop */

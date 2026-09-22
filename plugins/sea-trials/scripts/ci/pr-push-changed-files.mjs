/**
 * Push-scoped changed-file lists for CI skip gates.
 *
 * Cumulative `base.sha..HEAD` diffs make promotion PRs path-match every
 * lane forever after the first flutter touch. Warm repushes on stg/main
 * should look at the latest push range (or HEAD commit only). Dev PRs
 * keep cumulative diffs so batched pushes cannot false-skip lanes.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

export const ZERO_SHA =
  '0000000000000000000000000000000000000000';

/**
 * @param {(args: string[]) => string} [git]
 */
function defaultGit(args) {
  const result = spawnSync('git', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${(result.stderr ?? '').trim()}`,
    );
  }
  return result.stdout ?? '';
}

/**
 * @param {string[]} args
 * @param {(args: string[]) => string} git
 * @returns {string[]}
 */
function gitLines(args, git = defaultGit) {
  return git(args)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * PR head tip on merge commits (`pull_request` checkout).
 *
 * @param {(args: string[]) => string} [git]
 * @returns {string}
 */
export function resolveHeadCommitRef(git = defaultGit) {
  const parentLine = git(['rev-list', '--parents', '-n', '1', 'HEAD']);
  const parents = parentLine.trim().split(/\s+/).filter(Boolean);
  if (parents.length > 2) {
    return parents[2];
  }
  return 'HEAD';
}

/**
 * @param {(args: string[]) => string} [git]
 * @returns {string[]}
 */
export function changedFilesInHeadCommit(git = defaultGit) {
  const ref = resolveHeadCommitRef(git);
  const parentLine = git(['rev-list', '--parents', '-n', '1', ref]);
  const parents = parentLine.trim().split(/\s+/).filter(Boolean);
  if (parents.length > 2) {
    return gitLines(['diff', '--name-only', '--no-renames', parents[1], ref], git);
  }
  return gitLines([
    'diff-tree',
    '--no-commit-id',
    '--name-only',
    '-r',
    ref,
  ], git);
}

/**
 * @param {string | undefined} before
 * @param {string | undefined} after
 * @param {(args: string[]) => string} [git]
 * @returns {string[]}
 */
export function changedFilesInPushRange(before, after, git = defaultGit) {
  if (before && after && before !== ZERO_SHA) {
    try {
      return gitLines(['diff', '--name-only', '--no-renames', before, after], git);
    } catch (err) {
      const msg = String(err.message ?? err);
      if (!msg.includes('bad object') && !msg.includes('unknown revision')) {
        throw err;
      }
      return changedFilesInHeadCommit(git);
    }
  }
  return changedFilesInHeadCommit(git);
}

/**
 * @param {{
 *   before?: string,
 *   after?: string,
 *   git?: (args: string[]) => string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string[]}
 */
export function changedFilesForCiPush({
  before,
  after,
  git = defaultGit,
  env = process.env,
} = {}) {
  const pushBefore = before ?? env.GITHUB_EVENT_BEFORE ?? '';
  const pushAfter =
    after ?? env.GITHUB_EVENT_AFTER ?? env.GITHUB_SHA ?? 'HEAD';
  return changedFilesInPushRange(pushBefore, pushAfter, git);
}

/**
 * Cumulative PR diff for dev-targeting PRs (safe for batched pushes).
 *
 * @param {{
 *   baseSha?: string,
 *   git?: (args: string[]) => string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string[]}
 */
export function changedFilesForCumulativePr({
  baseSha,
  git = defaultGit,
  env = process.env,
} = {}) {
  const sha = baseSha ?? env.PR_BASE_SHA ?? '';
  if (!sha.trim()) {
    throw new Error('PR_BASE_SHA is required for cumulative path gate');
  }
  return gitLines(['diff', '--name-only', '--no-renames', sha.trim(), 'HEAD'], git);
}

/**
 * Path gate for pr-lane-pass-cache: push-scoped on promotion PRs,
 * cumulative on dev PRs.
 *
 * @param {{
 *   git?: (args: string[]) => string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string[]}
 */
export function changedFilesForPathGate({ git = defaultGit, env = process.env } = {}) {
  const baseRef = (env.GITHUB_BASE_REF ?? '').trim();
  if (baseRef === 'stg' || baseRef === 'main') {
    return changedFilesForCiPush({ git, env });
  }
  return changedFilesForCumulativePr({ git, env });
}

/* c8 ignore start */
function main() {
  const args = process.argv.slice(2);
  let writePath;
  let mode = 'path-gate';
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--write') {
      writePath = args[i + 1];
      i += 1;
    } else if (args[i] === '--push-only') {
      mode = 'push';
    }
  }
  const files =
    mode === 'push' ? changedFilesForCiPush() : changedFilesForPathGate();
  if (writePath) {
    fs.writeFileSync(
      writePath,
      files.length > 0 ? `${files.join('\n')}\n` : '',
    );
    return;
  }
  for (const file of files) {
    process.stdout.write(`${file}\n`);
  }
}

if (process.argv[1]?.endsWith('pr-push-changed-files.mjs')) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`pr-push-changed-files: ${err.message}\n`);
    process.exit(2);
  }
}
/* c8 ignore stop */

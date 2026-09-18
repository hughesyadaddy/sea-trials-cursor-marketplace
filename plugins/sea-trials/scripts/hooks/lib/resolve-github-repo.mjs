import { spawnSync } from 'node:child_process';

const DEFAULT_REPO_NAME = 'sea_trials_universal';

/**
 * @param {string} remoteUrl
 * @returns {{ owner: string, repo: string } | null}
 */
export function parseGithubOwnerRepoFromRemote(remoteUrl) {
  const trimmed = remoteUrl.trim();
  const match = trimmed.match(
    /github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
  );
  if (!match) {
    return null;
  }
  const owner = match[1]?.trim();
  const repo = match[2]?.trim();
  if (!owner || !repo) {
    return null;
  }
  return { owner, repo };
}

/**
 * @returns {string | null}
 */
function readGitOriginRemote() {
  const result = spawnSync(
    'git',
    ['config', '--get', 'remote.origin.url'],
    { encoding: 'utf8' },
  );
  const remote = (result.stdout ?? '').trim();
  if (result.status !== 0 || remote.length === 0) {
    return null;
  }
  return remote;
}

/**
 * Resolves GitHub owner/repo for release downloads and CI overrides.
 *
 * Priority:
 * 1. GITHUB_REPO_OWNER (+ optional GITHUB_REPO_NAME)
 * 2. GITHUB_REPO_REMOTE_URL (parsed owner/repo)
 * 3. git remote.origin.url
 *
 * @returns {{ owner: string, repo: string, source: string }}
 */
export function resolveGithubOwnerRepo() {
  const repoName = process.env.GITHUB_REPO_NAME?.trim() || DEFAULT_REPO_NAME;

  const ownerFromEnv = process.env.GITHUB_REPO_OWNER?.trim();
  if (ownerFromEnv) {
    return {
      owner: ownerFromEnv,
      repo: repoName,
      source: 'GITHUB_REPO_OWNER',
    };
  }

  const remoteFromEnv = process.env.GITHUB_REPO_REMOTE_URL?.trim();
  if (remoteFromEnv) {
    const parsed = parseGithubOwnerRepoFromRemote(remoteFromEnv);
    if (parsed) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        source: 'GITHUB_REPO_REMOTE_URL',
      };
    }
    throw new Error(
      'GITHUB_REPO_REMOTE_URL is set but is not a github.com URL.',
    );
  }

  const origin = readGitOriginRemote();
  if (origin) {
    const parsed = parseGithubOwnerRepoFromRemote(origin);
    if (parsed) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        source: 'git remote.origin',
      };
    }
  }

  throw new Error(
    'Could not resolve GitHub owner/repo.\n' +
      'Set GITHUB_REPO_OWNER in Codemagic, or run inside a git checkout ' +
      'with remote.origin pointing at github.com.',
  );
}

/**
 * @returns {string}
 */
export function buildGithubSshRemoteUrl(owner, repo) {
  return `git@github.com:${owner}/${repo}.git`;
}

/**
 * @returns {string}
 */
export function resolveGithubSshRemoteUrl() {
  const { owner, repo } = resolveGithubOwnerRepo();
  return buildGithubSshRemoteUrl(owner, repo);
}

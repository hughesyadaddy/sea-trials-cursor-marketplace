/**
 * File or update a GitHub issue when the whole-tree audit fails.
 *
 * A red X in the Actions tab is not a notification. The nightly audit
 * was failing unnoticed for long enough that the PR escape hatch it
 * backed was effectively disabled, which is the reason this exists.
 *
 * One issue per branch, reused across failures: a second failure adds a
 * comment rather than opening a duplicate, and the issue is closed
 * automatically once the audit goes green again.
 *
 * All network access is injected so the logic stays unit-testable,
 * mirroring `scripts/hooks/lib/resolve-base-ref.mjs`.
 */

import { pathToFileURL } from 'node:url';

/**
 * Label the lookup filters on. Server-side filtering keeps the result set
 * to audit issues only, so the tracking issue cannot fall off the end of
 * a page once the repo has many open issues (and PRs, which the /issues
 * endpoint also returns).
 */
export const ISSUE_LABEL = 'audit-failure';

/** Informational breadcrumb in the body, so the issue is greppable. */
export const ISSUE_MARKER = '<!-- sea-trials:audit-failure -->';

export function issueTitleFor(branch) {
  return `Whole-tree audit failing on \`${branch}\``;
}

export function buildIssueBody({
  branch,
  sha,
  runUrl,
  lintCommit,
  failingPackages = [],
}) {
  const packageList = failingPackages.length
    ? failingPackages.map((p) => `- \`${p}\``).join('\n')
    : '_No per-package detail was captured; see the run log._';

  return [
    ISSUE_MARKER,
    `The whole-tree audit failed on \`${branch}\`.`,
    '',
    `- **Commit:** ${sha}`,
    `- **Run:** ${runUrl}`,
    // The audit builds sea-trials-lint from the branch under audit, so a
    // branch lagging behind on a linter fix can produce false positives.
    // Naming the linter commit makes that diagnosable at a glance.
    `- **Linter commit:** ${lintCommit || '(unknown)'}`,
    '',
    '**Failing packages**',
    packageList,
    '',
    'This issue is updated on each subsequent failure and closed',
    'automatically when the audit next passes.',
  ].join('\n');
}

/**
 * @param {object} opts
 * @param {(url: string, init?: object) => Promise<Response>} opts.fetchImpl
 * @param {string} opts.repo   'owner/name'
 * @param {string} opts.token
 * @param {string} opts.branch
 * @param {boolean} opts.failed  whether the audit failed
 * @param {boolean} [opts.dryRun] suppress *filing* only. Closing an open
 *   tracking issue still happens: otherwise an issue filed while alerts
 *   were enabled could never be cleared by a later green audit once they
 *   were turned off again.
 * @param {string} [opts.assignee]
 * @returns {Promise<{action: string, issueNumber?: number}>}
 */
export async function reportAuditResult({
  fetchImpl,
  repo,
  token,
  branch,
  failed,
  dryRun = false,
  assignee,
  sha,
  runUrl,
  lintCommit,
  failingPackages,
}) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  };

  const request = async (path, init = {}) => {
    const response = await fetchImpl(`${api}${path}`, { ...init, headers });
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(
        `GitHub API ${init.method ?? 'GET'} ${path} failed: ` +
          `${response.status} ${detail}`,
      );
    }
    return response.json();
  };

  const title = issueTitleFor(branch);
  // Label-filtered rather than the search API: search is eventually
  // consistent and would open duplicates on rapid reruns. Filtering
  // server-side also bounds the result set, so a busy repo cannot push
  // the tracking issue past the first page.
  const open = await request(
    `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`,
  );
  const existing = open.find(
    (issue) => issue.title === title && !issue.pull_request,
  );

  if (!failed) {
    if (!existing) return { action: 'noop' };
    await request(`/issues/${existing.number}`, {
      method: 'PATCH',
      body: JSON.stringify({ state: 'closed' }),
    });
    return { action: 'closed', issueNumber: existing.number };
  }

  if (dryRun) {
    // Reached only on failure — the close path above already ran.
    return { action: 'dry-run', issueNumber: existing?.number };
  }

  const body = buildIssueBody({
    branch,
    sha,
    runUrl,
    lintCommit,
    failingPackages,
  });

  if (existing) {
    await request(`/issues/${existing.number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body }),
    });
    return { action: 'commented', issueNumber: existing.number };
  }

  // The label must exist before it is attached. A repository that has
  // never filed an audit issue has no `audit-failure` label, and relying
  // on the issues API to conjure one would either reject the request or
  // drop the label — the first breaks alerting outright, the second makes
  // the label-filtered lookup miss and file duplicates forever after.
  await ensureLabel({ request, label: ISSUE_LABEL });

  const created = await request('/issues', {
    method: 'POST',
    body: JSON.stringify({
      title,
      body,
      labels: [ISSUE_LABEL],
      // An unassigned issue in an unwatched repo is not a notification
      // either, which is the failure mode this whole script addresses.
      ...(assignee ? { assignees: [assignee] } : {}),
    }),
  });
  return { action: 'created', issueNumber: created.number };
}

/**
 * Create the label if it is missing, tolerating the already-exists race
 * between two concurrent audits.
 *
 * @param {{request: Function, label: string}} opts
 */
export async function ensureLabel({ request, label }) {
  try {
    await request(`/labels/${encodeURIComponent(label)}`);
    return { action: 'exists' };
  } catch {
    // Not found — fall through and create it.
  }
  try {
    await request('/labels', {
      method: 'POST',
      body: JSON.stringify({
        name: label,
        color: 'b60205',
        description: 'Whole-tree audit is failing on a tracked branch',
      }),
    });
    return { action: 'created' };
  } catch (err) {
    // 422 already_exists: another run created it between our check and
    // our create. Anything else is a real failure and must surface.
    if (!/422/.test(err.message)) throw err;
    return { action: 'raced' };
  }
}

/* c8 ignore start -- CLI wrapper; the logic above is what is tested. */
// argv[1] is undefined under `node -e` / REPL imports, where
// pathToFileURL would throw rather than simply not match.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {
    GITHUB_TOKEN,
    GITHUB_REPOSITORY,
    GITHUB_SHA,
    GITHUB_SERVER_URL = 'https://github.com',
    GITHUB_RUN_ID,
    AUDIT_BRANCH,
    AUDIT_FAILED,
    AUDIT_ASSIGNEE,
    AUDIT_LINT_COMMIT,
    AUDIT_FAILING_PACKAGES = '',
  } = process.env;

  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY || !AUDIT_BRANCH) {
    process.stderr.write(
      'report-audit-failure: GITHUB_TOKEN, GITHUB_REPOSITORY and ' +
        'AUDIT_BRANCH are required.\n',
    );
    process.exit(2);
  }

  const result = await reportAuditResult({
    fetchImpl: fetch,
    repo: GITHUB_REPOSITORY,
    token: GITHUB_TOKEN,
    branch: AUDIT_BRANCH,
    failed: AUDIT_FAILED === 'true',
    dryRun: process.env.AUDIT_DRY_RUN === 'true',
    assignee: AUDIT_ASSIGNEE || undefined,
    sha: GITHUB_SHA,
    runUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`,
    lintCommit: AUDIT_LINT_COMMIT,
    failingPackages: AUDIT_FAILING_PACKAGES.split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  });

  process.stdout.write(
    `report-audit-failure: ${result.action}` +
      `${result.issueNumber ? ` (#${result.issueNumber})` : ''}\n`,
  );
}
/* c8 ignore stop */

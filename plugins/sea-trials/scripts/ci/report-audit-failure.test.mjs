import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ISSUE_LABEL,
  ISSUE_MARKER,
  buildIssueBody,
  issueTitleFor,
  reportAuditResult,
} from './report-audit-failure.mjs';

/**
 * Minimal fetch double. `routes` maps `${method} ${pathname}` to a
 * response body; every call is recorded for assertions.
 */
function makeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const { pathname, search } = new URL(url);
    const path = pathname.replace('/repos/acme/app', '') + search;
    calls.push({
      method,
      path,
      body: init.body ? JSON.parse(init.body) : undefined,
    });
    const key = `${method} ${path}`;
    if (!(key in routes)) {
      return { ok: false, status: 404, text: async () => `no route ${key}` };
    }
    return { ok: true, status: 200, json: async () => routes[key] };
  };
  return { fetchImpl, calls };
}

const base = {
  repo: 'acme/app',
  token: 't0ken',
  branch: 'dev',
  sha: 'abc123',
  runUrl: 'https://github.com/acme/app/actions/runs/1',
  lintCommit: 'f9d3919',
};

test('opens an issue when none exists and the audit failed', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [],
    'GET /labels/audit-failure': { name: 'audit-failure' },
    'POST /issues': { number: 7 },
  });

  const result = await reportAuditResult({
    ...base,
    fetchImpl,
    failed: true,
    assignee: 'hughesyadaddy',
    failingPackages: ['packages/app_ui'],
  });

  assert.deepEqual(result, { action: 'created', issueNumber: 7 });
  const created = calls.find((c) => c.method === 'POST');
  assert.equal(created.body.title, issueTitleFor('dev'));
  assert.deepEqual(created.body.assignees, ['hughesyadaddy']);
  assert.match(created.body.body, /packages\/app_ui/);
});

test('comments on the existing issue instead of opening a duplicate', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [
      { number: 42, title: issueTitleFor('dev') },
    ],
    'POST /issues/42/comments': { id: 1 },
  });

  const result = await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.deepEqual(result, { action: 'commented', issueNumber: 42 });
  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.path === '/issues').length,
    0,
    'must not open a second issue',
  );
});

test('matches per branch so dev and main do not share an issue', async () => {
  const { fetchImpl } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [
      { number: 42, title: issueTitleFor('dev') },
    ],
    'GET /labels/audit-failure': { name: 'audit-failure' },
    'POST /issues': { number: 43 },
  });

  const result = await reportAuditResult({
    ...base,
    fetchImpl,
    branch: 'main',
    failed: true,
  });

  assert.equal(result.action, 'created');
  assert.equal(result.issueNumber, 43);
});

test('ignores pull requests returned by the issues endpoint', async () => {
  // GitHub's /issues endpoint returns PRs too; a PR that happens to
  // carry the title must not be mistaken for the tracking issue.
  const { fetchImpl } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [
      { number: 9, title: issueTitleFor('dev'), pull_request: { url: 'x' } },
    ],
    'GET /labels/audit-failure': { name: 'audit-failure' },
    'POST /issues': { number: 10 },
  });

  const result = await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.deepEqual(result, { action: 'created', issueNumber: 10 });
});

test('closes the tracking issue when the audit passes', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [
      { number: 42, title: issueTitleFor('dev') },
    ],
    'PATCH /issues/42': { number: 42, state: 'closed' },
  });

  const result = await reportAuditResult({ ...base, fetchImpl, failed: false });

  assert.deepEqual(result, { action: 'closed', issueNumber: 42 });
  assert.equal(calls.at(-1).body.state, 'closed');
});

test('does nothing when the audit passes and no issue is open', async () => {
  const { fetchImpl, calls } = makeFetch({
    'GET /issues?state=open&labels=audit-failure&per_page=100': [],
  });

  const result = await reportAuditResult({ ...base, fetchImpl, failed: false });

  assert.deepEqual(result, { action: 'noop' });
  assert.equal(calls.length, 1, 'read-only when there is nothing to do');
});

test('surfaces API failures instead of silently reporting success', async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 403,
    text: async () => 'Resource not accessible by integration',
  });

  await assert.rejects(
    reportAuditResult({ ...base, fetchImpl, failed: true }),
    /403/,
    'a missing issues:write permission must fail loudly',
  );
});

test('the issue title is a stable literal, not whatever the code returns', () => {
  // Asserting against issueTitleFor() would pass through any wording
  // regression, since expectation and subject would be the same call.
  assert.equal(issueTitleFor('dev'), 'Whole-tree audit failing on `dev`');
});

test('a created issue carries the label the lookup filters on', async () => {
  // The lookup is label-filtered. An issue created without the label
  // would be invisible to the next run, which would open a duplicate.
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [],
    'GET /labels/audit-failure': { name: 'audit-failure' },
    'POST /issues': { number: 1 },
  });

  await reportAuditResult({ ...base, fetchImpl, failed: true });

  const created = calls.find((c) => c.method === 'POST');
  assert.deepEqual(created.body.labels, [ISSUE_LABEL]);
});

test('the lookup is filtered server-side, not paginated client-side', async () => {
  // /issues returns PRs too and defaults to 30 per page; an unfiltered
  // first-page scan would miss the tracking issue on a busy repo.
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [],
    'GET /labels/audit-failure': { name: 'audit-failure' },
    'POST /issues': { number: 1 },
  });

  await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.match(calls[0].path, new RegExp(`labels=${ISSUE_LABEL}`));
});

test('body carries the marker, the linter commit and the run URL', () => {
  const body = buildIssueBody({
    branch: 'main',
    sha: 'deadbeef',
    runUrl: 'https://example.test/run/5',
    lintCommit: 'f9d3919',
    failingPackages: ['packages/a', 'packages/b'],
  });

  assert.ok(body.startsWith(ISSUE_MARKER));
  assert.match(body, /deadbeef/);
  assert.match(body, /https:\/\/example\.test\/run\/5/);
  // The linter is built from the branch under audit, so a lagging branch
  // can yield false positives; the commit must be visible in the issue.
  assert.match(body, /f9d3919/);
  assert.match(body, /packages\/a/);
  assert.match(body, /packages\/b/);
});

test('body degrades gracefully when no package detail was captured', () => {
  const body = buildIssueBody({
    branch: 'dev',
    sha: 'abc',
    runUrl: 'u',
    lintCommit: '',
    failingPackages: [],
  });

  assert.match(body, /No per-package detail/);
  assert.match(body, /\(unknown\)/);
});

// ---------------------------------------------------------------------
// Label provisioning
// ---------------------------------------------------------------------

test('creates the label when the repository does not have it yet', async () => {
  // A repo that has never filed an audit issue has no audit-failure
  // label. Attaching an absent label would either reject the create --
  // breaking alerting outright -- or drop it, so the label-filtered
  // lookup misses and every later failure opens a duplicate.
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [],
    'POST /labels': { name: ISSUE_LABEL },
    'POST /issues': { number: 5 },
  });

  const result = await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.equal(result.action, 'created');
  const createdLabel = calls.find(
    (c) => c.method === 'POST' && c.path === '/labels',
  );
  assert.equal(createdLabel.body.name, ISSUE_LABEL);
  // Label first, then the issue that references it.
  assert.ok(
    calls.findIndex((c) => c.path === '/labels') <
      calls.findIndex((c) => c.path === '/issues'),
  );
});

test('does not recreate a label that already exists', async () => {
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [],
    [`GET /labels/${ISSUE_LABEL}`]: { name: ISSUE_LABEL },
    'POST /issues': { number: 6 },
  });

  await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.equal(
    calls.filter((c) => c.method === 'POST' && c.path === '/labels').length,
    0,
  );
});

test('tolerates two concurrent audits racing to create the label', async () => {
  // The nightly and a push audit can both reach this point; the loser of
  // the race gets 422 already_exists and must continue, not abort.
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const { pathname, search } = new URL(url);
    const p = pathname.replace('/repos/acme/app', '') + search;
    seen.push(`${method} ${p}`);
    if (p.startsWith('/labels/')) {
      return { ok: false, status: 404, text: async () => 'Not Found' };
    }
    if (p === '/labels') {
      return { ok: false, status: 422, text: async () => 'already_exists' };
    }
    if (p.startsWith('/issues?')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => ({ number: 8 }) };
  };

  const result = await reportAuditResult({ ...base, fetchImpl, failed: true });

  assert.deepEqual(result, { action: 'created', issueNumber: 8 });
  assert.ok(seen.some((c) => c === 'POST /issues'));
});

test('a non-422 label failure aborts rather than filing a broken issue', async () => {
  const fetchImpl = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const p = pathname.replace('/repos/acme/app', '') + search;
    if (p.startsWith('/issues?')) {
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: false, status: 403, text: async () => 'Forbidden' };
  };

  await assert.rejects(
    reportAuditResult({ ...base, fetchImpl, failed: true }),
    /403/,
  );
});

test('dry run suppresses filing but still closes a stale issue', () => {
  // An issue filed while alerts were enabled must remain closeable after
  // they are turned off, or it stays open forever with no way to clear it.
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [
      { number: 42, title: issueTitleFor('dev') },
    ],
    'PATCH /issues/42': { number: 42, state: 'closed' },
  });

  return reportAuditResult({
    ...base,
    fetchImpl,
    failed: false,
    dryRun: true,
  }).then((result) => {
    assert.deepEqual(result, { action: 'closed', issueNumber: 42 });
    assert.equal(calls.at(-1).body.state, 'closed');
  });
});

test('dry run files nothing on failure', async () => {
  const { fetchImpl, calls } = makeFetch({
    [`GET /issues?state=open&labels=${ISSUE_LABEL}&per_page=100`]: [],
  });

  const result = await reportAuditResult({
    ...base,
    fetchImpl,
    failed: true,
    dryRun: true,
  });

  assert.equal(result.action, 'dry-run');
  assert.equal(
    calls.filter((c) => c.method === 'POST').length,
    0,
    'no issue and no label may be created in dry run',
  );
});

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { resolveAuth, setFetch, setSleep } from './jira-rest.mjs';
import {
  CLAUDE_AGENT,
  DEFAULT_STATUSES,
  SUBAGENT_TYPE,
  adfText,
  buildJql,
  buildPrompt,
  buildTask,
  extractPrUrls,
  hasVerdictForSha,
  lastDevComment,
  parseArgs,
  pickPr,
  resolvePr,
  runCli,
  runSweep,
  searchIssues,
  setRunner,
  shortSha,
  sinceToJql,
} from './jira-test-review-sweep.mjs';

const ENV = {
  JIRA_SITE: 'https://example.atlassian.net',
  JIRA_EMAIL: 'qa@example.com',
  JIRA_API_TOKEN: 'secret-token',
};
const AUTH = resolveAuth({ env: ENV });
const HEAD = '4f2c1a9b7d3e5f60123456789abcdef012345678';

function reply(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** Route fake fetch by URL substring + method. */
function routedFetch(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (url.includes(r.match) && (!r.method || r.method === init.method)) {
        const res = typeof r.reply === 'function' ? r.reply(url, init) : r.reply;
        return res;
      }
    }
    throw new Error(`unrouted fetch ${init.method} ${url}`);
  };
  fn.calls = calls;
  return fn;
}

function paragraph(text) {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function comment(text, accountId, created) {
  return {
    body: paragraph(text),
    author: { accountId, displayName: `User ${accountId}` },
    created,
  };
}

let restoreFetch;
let restoreSleep;
let restoreRunner;

beforeEach(() => {
  restoreSleep = setSleep(async () => {});
  restoreFetch = setFetch(async () => {
    throw new Error('network call without a fake fetch');
  });
  restoreRunner = setRunner(() => ({ status: 1, stdout: '', stderr: 'no gh' }));
});

afterEach(() => {
  setFetch(restoreFetch);
  setSleep(restoreSleep);
  setRunner(restoreRunner);
});

// ===========================================================================
// ARGS + JQL
// ===========================================================================

test('parseArgs applies defaults and env fallbacks', () => {
  const a = parseArgs(['--project', 'STD']);
  assert.equal(a.project, 'STD');
  assert.deepEqual(a.statuses, DEFAULT_STATUSES);
  assert.equal(a.since, '24h');
  assert.equal(a.max, 10);
  assert.equal(a.format, 'table');
  const b = parseArgs(['--tasks', '--status', 'Code Review, QA', '--max', '3'], {
    JIRA_PROJECT_KEY: 'ENV',
    JIRA_TESTER_ACCOUNT_ID: 'acc-1',
  });
  assert.equal(b.project, 'ENV');
  assert.deepEqual(b.statuses, ['Code Review', 'QA']);
  assert.equal(b.max, 3);
  assert.equal(b.tester, 'acc-1');
  assert.equal(b.format, 'tasks');
  assert.throws(() => parseArgs([], {}), /--project/);
  assert.throws(() => parseArgs(['--project', 'X', '--max', '0']), /--max/);
  assert.throws(() => parseArgs(['--project', 'X', '--bogus']), /unknown/);
});

test('sinceToJql normalises relative windows and dates', () => {
  assert.equal(sinceToJql('24h'), '-24h');
  assert.equal(sinceToJql('2D'), '-2d');
  assert.equal(sinceToJql('-1w'), '-1w');
  assert.equal(sinceToJql('2026-09-01'), '"2026-09-01"');
  assert.equal(sinceToJql('2026-09-01T08:30'), '"2026-09-01 08:30"');
  assert.throws(() => sinceToJql('yesterday'), /--since/);
});

test('buildJql quotes statuses and honours sprint/assignee options', () => {
  assert.equal(
    buildJql({ project: 'STD', statuses: ['Code Review'], since: '24h' }),
    'project = STD AND status = "Code Review" AND updated >= -24h ' +
      'ORDER BY updated ASC',
  );
  const jql = buildJql({
    project: 'STD',
    statuses: ['In Review', 'Ready for QA'],
    sprint: 'active',
    assigneeNot: 'me',
    since: '2d',
  });
  assert.equal(
    jql,
    'project = STD AND status in ("In Review", "Ready for QA") AND ' +
      'sprint in openSprints() AND assignee != currentUser() AND ' +
      'updated >= -2d ORDER BY updated ASC',
  );
  assert.match(buildJql({ project: 'STD', sprint: '42' }), /sprint = 42/);
});

// ===========================================================================
// TEXT + URLS
// ===========================================================================

test('adfText flattens paragraphs, mentions and link marks', () => {
  const doc = {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'see ' },
          {
            type: 'text',
            text: 'PR',
            marks: [{ type: 'link', attrs: { href: 'https://x/y' } }],
          },
          { type: 'mention', attrs: { text: '@Dana' } },
        ],
      },
      { type: 'paragraph', content: [{ type: 'text', text: 'next' }] },
    ],
  };
  const text = adfText(doc);
  assert.match(text, /see PR https:\/\/x\/y @Dana/);
  assert.match(text, /\nnext/);
  assert.equal(adfText('plain'), 'plain');
  assert.equal(adfText(null), '');
});

test('extractPrUrls finds PR links in strings, ADF and remote links', () => {
  const urls = extractPrUrls({
    description: paragraph('fix in https://github.com/org/repo/pull/12 now'),
    customfield_10099: 'https://github.com/org/repo/pull/12',
    links: [
      { object: { url: 'https://github.com/org/repo/pull/13', title: 'PR' } },
      { object: { url: 'https://github.com/org/repo/issues/9' } },
    ],
  });
  assert.deepEqual(urls, [
    'https://github.com/org/repo/pull/12',
    'https://github.com/org/repo/pull/13',
  ]);
  assert.deepEqual(extractPrUrls(null), []);
});

test('hasVerdictForSha matches any 7+ hex prefix of the head', () => {
  const comments = [
    comment('Ran this on feature/x at 4f2c1a9. All AC pass.', 'qa', '2026-09-20'),
  ];
  assert.equal(hasVerdictForSha(comments, HEAD), true);
  assert.equal(hasVerdictForSha(comments, 'deadbeef00000000000000000000000000000000'), false);
  assert.equal(hasVerdictForSha(comments, null), false);
  // Six-char tokens and prose words are not SHAs.
  assert.equal(
    hasVerdictForSha([comment('done at 4f2c1a, decided', 'qa', '')], HEAD),
    false,
  );
  // Tester filter: a developer quoting the SHA does not count.
  assert.equal(hasVerdictForSha(comments, HEAD, 'other-tester'), false);
  assert.equal(hasVerdictForSha(comments, HEAD, 'qa'), true);
  // Full SHA in parentheses at the end counts too.
  assert.equal(
    hasVerdictForSha([comment(`Moving to Done. (${HEAD})`, 'qa', '')], HEAD),
    true,
  );
});

test('lastDevComment returns the newest non-tester comment, trimmed', () => {
  const long = 'x'.repeat(300);
  const comments = [
    comment('older dev note', 'dev', '2026-09-18T10:00:00.000+0000'),
    comment(long, 'dev', '2026-09-20T10:00:00.000+0000'),
    comment('qa verdict 4f2c1a9', 'qa', '2026-09-21T10:00:00.000+0000'),
  ];
  const last = lastDevComment(comments, 'qa');
  assert.equal(last.author, 'User dev');
  assert.equal(last.snippet.length, 200);
  assert.ok(last.snippet.endsWith('...'));
  assert.equal(lastDevComment([], 'qa'), null);
  assert.equal(lastDevComment(comments).snippet, 'qa verdict 4f2c1a9');
});

test('shortSha and pickPr', () => {
  assert.equal(shortSha(HEAD), '4f2c1a9');
  assert.equal(shortSha(null), null);
  const prs = [{ state: 'MERGED', number: 1 }, { state: 'OPEN', number: 2 }];
  assert.equal(pickPr(prs).number, 2);
  assert.equal(pickPr([prs[0]]).number, 1);
});

// ===========================================================================
// PR RESOLUTION
// ===========================================================================

test('resolvePr views explicit URLs first, then searches by key', () => {
  const calls = [];
  setRunner((args) => {
    calls.push(args);
    if (args[1] === 'view') {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: 12,
          url: args[2],
          headRefName: 'feature/std-1',
          headRefOid: HEAD,
          state: 'OPEN',
        }),
      };
    }
    return {
      status: 0,
      stdout: JSON.stringify([
        { number: 7, url: 'https://github.com/o/r/pull/7', headRefName: 'b', headRefOid: 'abc1234abc1234abc1234abc1234abc1234abc12', state: 'MERGED' },
      ]),
    };
  });
  const viewed = resolvePr('STD-1', ['https://github.com/o/r/pull/12']);
  assert.equal(viewed.headSha, HEAD);
  assert.equal(viewed.branch, 'feature/std-1');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 3), ['pr', 'view', 'https://github.com/o/r/pull/12']);

  const searched = resolvePr('STD-1', [], { repo: 'o/r' });
  assert.equal(searched.number, 7);
  assert.equal(searched.pr, 'https://github.com/o/r/pull/7');
  const searchArgs = calls[1];
  assert.equal(searchArgs[3], 'STD-1 in:title,head');
  assert.deepEqual(searchArgs.slice(-2), ['-R', 'o/r']);
});

test('resolvePr degrades to the raw URL when gh is unavailable', () => {
  const res = resolvePr('STD-1', ['https://github.com/o/r/pull/3']);
  assert.equal(res.pr, 'https://github.com/o/r/pull/3');
  assert.equal(res.headSha, null);
  assert.deepEqual(resolvePr('STD-2', []), {
    pr: null,
    number: null,
    branch: null,
    headSha: null,
    state: null,
  });
});

// ===========================================================================
// SEARCH + SWEEP
// ===========================================================================

test('searchIssues posts to /search/jql and follows nextPageToken', async () => {
  const fetch = routedFetch([
    {
      match: '/rest/api/3/search/jql',
      reply: (url, init) => {
        const body = JSON.parse(init.body);
        if (!body.nextPageToken) {
          return reply(200, { issues: [{ key: 'A-1' }], nextPageToken: 't2' });
        }
        return reply(200, { issues: [{ key: 'A-2' }], isLast: true });
      },
    },
  ]);
  setFetch(fetch);
  const issues = await searchIssues('project = A', { auth: AUTH });
  assert.deepEqual(issues.map((i) => i.key), ['A-1', 'A-2']);
  assert.equal(fetch.calls.length, 2);
  const first = JSON.parse(fetch.calls[0].init.body);
  assert.equal(first.jql, 'project = A');
  assert.ok(first.fields.includes('comment'));
  assert.equal(JSON.parse(fetch.calls[1].init.body).nextPageToken, 't2');
});

function sweepFixture() {
  const issues = [
    {
      key: 'STD-1',
      fields: {
        summary: 'Reviewed already',
        status: { name: 'In Review' },
        assignee: { accountId: 'dev', displayName: 'Dana' },
        updated: '2026-09-21T09:00:00.000+0000',
        description: paragraph('PR https://github.com/o/r/pull/1'),
        comment: {
          total: 2,
          comments: [
            comment('moved the service, see PR', 'dev', '2026-09-20T09:00'),
            comment('Ran this at 4f2c1a9, all AC pass. Done.', 'qa', '2026-09-21T09:00'),
          ],
        },
      },
    },
    {
      key: 'STD-2',
      fields: {
        summary: 'Needs a look',
        status: { name: 'In Review' },
        assignee: { accountId: 'dev', displayName: 'Dana' },
        updated: '2026-09-21T10:00:00.000+0000',
        description: paragraph('no link here'),
        comment: { total: 60, comments: [] },
      },
    },
    {
      key: 'STD-3',
      fields: {
        summary: 'Re-pushed after a verdict',
        status: { name: 'Ready for QA' },
        updated: '2026-09-21T11:00:00.000+0000',
        description: paragraph(''),
        comment: {
          total: 1,
          comments: [comment('Checked at 1111111, fails on Android', 'qa', '2026-09-19')],
        },
      },
    },
  ];
  const fetch = routedFetch([
    { match: '/search/jql', reply: reply(200, { issues, isLast: true }) },
    {
      match: '/issue/STD-2/comment',
      method: 'GET',
      reply: reply(200, {
        comments: [comment('Pushed the fix for the toast', 'dev', '2026-09-21T09:30')],
      }),
    },
    {
      match: '/issue/STD-3/remotelink',
      reply: reply(200, [{ object: { url: 'https://github.com/o/r/pull/3' } }]),
    },
    { match: '/remotelink', reply: reply(200, []) },
  ]);
  const heads = {
    'https://github.com/o/r/pull/1': HEAD,
    'https://github.com/o/r/pull/3': 'abcdef1234567890abcdef1234567890abcdef12',
  };
  setRunner((args) => {
    if (args[1] === 'view') {
      return {
        status: 0,
        stdout: JSON.stringify({
          number: Number(args[2].split('/').pop()),
          url: args[2],
          headRefName: `feature/${args[2].split('/').pop()}`,
          headRefOid: heads[args[2]],
          state: 'OPEN',
        }),
      };
    }
    if (args[3].startsWith('STD-2')) {
      return {
        status: 0,
        stdout: JSON.stringify([
          { number: 2, url: 'https://github.com/o/r/pull/2', headRefName: 'std-2-toast', headRefOid: '9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', state: 'OPEN' },
        ]),
      };
    }
    return { status: 0, stdout: '[]' };
  });
  return fetch;
}

test('runSweep skips issues verdicted on the current head and emits tasks', async () => {
  const fetch = sweepFixture();
  setFetch(fetch);
  const args = parseArgs(['--project', 'STD', '--tester', 'qa', '--repo-root', '/repo']);
  const res = await runSweep(args, { auth: AUTH });
  assert.deepEqual(res.summary, {
    candidates: 3,
    skippedVerdicted: 1,
    emitted: 2,
    deferred: 0,
  });
  const byKey = Object.fromEntries(res.records.map((r) => [r.key, r]));
  assert.equal(byKey['STD-1'].verdicted, true);
  assert.equal(byKey['STD-1'].shortSha, '4f2c1a9');
  assert.equal(byKey['STD-1'].lastDevComment.snippet, 'moved the service, see PR');
  // STD-2: comments were truncated in search, so they were fetched.
  assert.ok(fetch.calls.some((c) => c.url.includes('/issue/STD-2/comment')));
  assert.equal(byKey['STD-2'].pr, 'https://github.com/o/r/pull/2');
  assert.equal(byKey['STD-2'].branch, 'std-2-toast');
  assert.equal(byKey['STD-2'].lastDevComment.snippet, 'Pushed the fix for the toast');
  // STD-3: old verdict on 1111111, new head from the remote link → pending.
  assert.equal(byKey['STD-3'].verdicted, false);
  assert.equal(byKey['STD-3'].pr, 'https://github.com/o/r/pull/3');

  assert.deepEqual(res.tasks.map((t) => t.key), ['STD-2', 'STD-3']);
  const task = res.tasks[0];
  assert.equal(task.id, 'test-review:STD-2');
  assert.equal(task.subagent_type, SUBAGENT_TYPE);
  // The read-only verifier must never be pinned for a write-capable review.
  assert.notEqual(task.subagent_type, 'st-jira-verifier');
  assert.equal(task.claudeAgent, CLAUDE_AGENT ?? undefined);
  assert.equal(task.model, 'inherit');
  assert.equal(task.headSha, '9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  assert.match(task.prompt, /st-jira-test-review for Jira issue STD-2/);
  assert.match(task.prompt, /Repo root: \/repo/);
  assert.match(task.prompt, /9999999/);
  assert.match(task.prompt, /Pushed the fix for the toast/);
  assert.match(task.prompt, /never ask the user/);
});

test('runSweep caps emitted tasks at --max and reports the rest', async () => {
  setFetch(sweepFixture());
  const args = parseArgs(['--project', 'STD', '--tester', 'qa', '--max', '1']);
  const res = await runSweep(args, { auth: AUTH });
  assert.equal(res.tasks.length, 1);
  assert.equal(res.tasks[0].key, 'STD-2');
  assert.equal(res.summary.deferred, 1);
});

test('buildPrompt without a PR tells the worker how to find the branch', () => {
  const rec = { key: 'STD-9', summary: 'S', pr: null, headSha: null, shortSha: null };
  const prompt = buildPrompt(rec, { repoRoot: '/r' });
  assert.match(prompt, /gh pr list --search "STD-9 in:title,head"/);
  assert.match(prompt, /Name the tested commit short SHA once/);
  const task = buildTask(rec, { repoRoot: '/r' });
  assert.equal(task.run_in_background, true);
  assert.equal(task.description, 'Test review STD-9');
});

// ===========================================================================
// CLI
// ===========================================================================

function cli(argv, env = ENV) {
  const stdout = [];
  const stderr = [];
  return runCli(argv, {
    env,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  }).then((code) => ({ code, out: stdout.join(''), err: stderr.join('') }));
}

test('CLI --tasks prints one JSON line per pending issue and a summary', async () => {
  setFetch(sweepFixture());
  const res = await cli(['--project', 'STD', '--tester', 'qa', '--tasks']);
  assert.equal(res.code, 0);
  const lines = res.out.trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((l) => l.key), ['STD-2', 'STD-3']);
  assert.match(res.err, /candidates=3 skipped_verdicted=1 emitted=2/);
});

test('CLI --json and table modes include every candidate', async () => {
  setFetch(sweepFixture());
  const json = await cli(['--project', 'STD', '--tester', 'qa', '--json']);
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.issues.length, 3);
  assert.match(parsed.jql, /project = STD/);
  setFetch(sweepFixture());
  const table = await cli(['--project', 'STD', '--tester', 'qa']);
  assert.match(table.out, /^KEY\tSTATE\tHEAD\tPR\tSUMMARY\n/);
  assert.match(table.out, /STD-1\treviewed\t4f2c1a9/);
  assert.match(table.out, /STD-2\tpending/);
});

test('CLI exits 2 on usage errors and 1 on missing auth', async () => {
  const usage = await cli([], {});
  assert.equal(usage.code, 2);
  assert.match(usage.err, /--project/);
  const auth = await cli(['--project', 'STD'], { JIRA_SITE: 'https://x' });
  assert.equal(auth.code, 1);
  assert.match(auth.err, /JIRA_EMAIL/);
  assert.equal(auth.err.includes('secret-token'), false);
});

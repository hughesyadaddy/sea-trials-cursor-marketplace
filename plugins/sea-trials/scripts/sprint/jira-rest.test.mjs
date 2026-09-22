import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  attachFiles,
  chunk,
  deleteIssue,
  filterFields,
  formatJiraError,
  listSprints,
  moveToSprint,
  parseArgs,
  rankIssues,
  requestJson,
  resolveAuth,
  runCli,
  setDescription,
  setFetch,
  setSleep,
} from './jira-rest.mjs';

const ENV = {
  JIRA_SITE: 'https://example.atlassian.net/',
  JIRA_EMAIL: 'dev@example.com',
  JIRA_API_TOKEN: 'secret-token',
};
const AUTH = resolveAuth({ env: ENV });

/** Build a fetch Response-like object. */
function reply(status, body, headers = {}) {
  const map = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]),
  );
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (k) => map.get(k.toLowerCase()) ?? null },
    text: async () =>
      body === undefined
        ? ''
        : typeof body === 'string'
          ? body
          : JSON.stringify(body),
  };
}

/** Fake fetch that records calls and pops scripted responses. */
function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch #${calls.length}: ${url}`);
    return typeof next === 'function' ? next(url, init) : next;
  };
  fn.calls = calls;
  return fn;
}

let sleeps;
let restoreFetch;
let restoreSleep;

beforeEach(() => {
  sleeps = [];
  restoreSleep = setSleep(async (ms) => {
    sleeps.push(ms);
  });
  restoreFetch = setFetch(async () => {
    throw new Error('network call without a fake fetch');
  });
});

afterEach(() => {
  setFetch(restoreFetch);
  setSleep(restoreSleep);
});

// ===========================================================================
// HELPERS
// ===========================================================================

test('chunk splits into groups of n', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  assert.throws(() => chunk([1], 0));
});

test('resolveAuth builds Basic header and trims trailing slash', () => {
  assert.equal(AUTH.site, 'https://example.atlassian.net');
  const expected = Buffer.from('dev@example.com:secret-token').toString(
    'base64',
  );
  assert.equal(AUTH.authorization, `Basic ${expected}`);
  assert.throws(() => resolveAuth({ env: {} }), /JIRA_SITE/);
  assert.throws(
    () => resolveAuth({ env: { JIRA_SITE: 'https://x' } }),
    /JIRA_EMAIL/,
  );
  assert.equal(
    resolveAuth({ site: 'https://cli.example.net', env: ENV }).site,
    'https://cli.example.net',
  );
});

test('formatJiraError surfaces errorMessages and errors', () => {
  assert.equal(
    formatJiraError(400, {
      errorMessages: ['Bad thing'],
      errors: { summary: 'required' },
    }),
    'Jira HTTP 400: Bad thing; summary: required',
  );
  assert.equal(formatJiraError(502, null, '<html>'), 'Jira HTTP 502: <html>');
  assert.equal(formatJiraError(404, null, ''), 'Jira HTTP 404');
});

// ===========================================================================
// requestJson
// ===========================================================================

test('requestJson sends auth, JSON body and query', async () => {
  const fetch = fakeFetch([reply(200, { ok: true })]);
  setFetch(fetch);
  const res = await requestJson('POST', '/rest/api/3/issue/X', {
    body: { a: 1 },
    query: { expand: 'names', skip: undefined },
    auth: AUTH,
  });
  assert.deepEqual(res, { ok: true });
  const [{ url, init }] = fetch.calls;
  assert.equal(url, 'https://example.atlassian.net/rest/api/3/issue/X?expand=names');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, AUTH.authorization);
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.body, '{"a":1}');
});

test('requestJson returns null for empty 204 bodies', async () => {
  setFetch(fakeFetch([reply(204)]));
  assert.equal(await requestJson('DELETE', '/x', { auth: AUTH }), null);
});

test('requestJson honours Retry-After on 429 then succeeds', async () => {
  const fetch = fakeFetch([
    reply(429, {}, { 'Retry-After': '3' }),
    reply(429, {}),
    reply(200, { done: true }),
  ]);
  setFetch(fetch);
  const res = await requestJson('GET', '/x', { auth: AUTH });
  assert.deepEqual(res, { done: true });
  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(sleeps, [3000, 1000]);
});

test('requestJson gives up after 5 attempts on 429', async () => {
  const fetch = fakeFetch(Array.from({ length: 6 }, () => reply(429, {})));
  setFetch(fetch);
  await assert.rejects(
    requestJson('GET', '/x', { auth: AUTH }),
    (e) => e.status === 429,
  );
  assert.equal(fetch.calls.length, 5);
  assert.equal(sleeps.length, 4);
});

test('requestJson retries 5xx up to 3 attempts', async () => {
  const fetch = fakeFetch([
    reply(503, 'down'),
    reply(502, 'down'),
    reply(500, { errorMessages: ['still down'] }),
    reply(200, {}),
  ]);
  setFetch(fetch);
  await assert.rejects(
    requestJson('GET', '/x', { auth: AUTH }),
    /Jira HTTP 500: still down/,
  );
  assert.equal(fetch.calls.length, 3);
});

test('requestJson throws with field errors on 4xx', async () => {
  setFetch(
    fakeFetch([reply(400, { errors: { description: 'invalid ADF' } })]),
  );
  await assert.rejects(
    requestJson('PUT', '/x', { auth: AUTH }),
    /Jira HTTP 400: description: invalid ADF/,
  );
});

// ===========================================================================
// OPERATIONS
// ===========================================================================

test('attachFiles posts multipart with X-Atlassian-Token no-check', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jira-'));
  const file = path.join(dir, 'log.txt');
  fs.writeFileSync(file, 'hello');
  const fetch = fakeFetch([reply(200, [{ id: '1', filename: 'log.txt' }])]);
  setFetch(fetch);
  const res = await attachFiles('STD-1', [file], { auth: AUTH });
  assert.equal(res[0].filename, 'log.txt');
  const [{ url, init }] = fetch.calls;
  assert.equal(url, 'https://example.atlassian.net/rest/api/3/issue/STD-1/attachments');
  assert.equal(init.headers['X-Atlassian-Token'], 'no-check');
  assert.equal(init.headers['Content-Type'], undefined);
  assert.ok(init.body instanceof FormData);
  const part = init.body.get('file');
  assert.equal(part.name, 'log.txt');
  assert.equal(await part.text(), 'hello');
});

test('deleteIssue passes deleteSubtasks query', async () => {
  const fetch = fakeFetch([reply(204), reply(204)]);
  setFetch(fetch);
  await deleteIssue('STD-1', { auth: AUTH });
  await deleteIssue('STD-2', { auth: AUTH, withSubtasks: true });
  assert.equal(fetch.calls[0].init.method, 'DELETE');
  assert.ok(fetch.calls[0].url.endsWith('/issue/STD-1?deleteSubtasks=false'));
  assert.ok(fetch.calls[1].url.endsWith('/issue/STD-2?deleteSubtasks=true'));
});

test('moveToSprint chunks more than 50 issues', async () => {
  const keys = Array.from({ length: 120 }, (_, i) => `STD-${i + 1}`);
  const fetch = fakeFetch([reply(204), reply(204), reply(204)]);
  setFetch(fetch);
  const n = await moveToSprint(7, keys, { auth: AUTH });
  assert.equal(n, 120);
  assert.equal(fetch.calls.length, 3);
  const sizes = fetch.calls.map((c) => JSON.parse(c.init.body).issues.length);
  assert.deepEqual(sizes, [50, 50, 20]);
  assert.ok(fetch.calls[0].url.endsWith('/rest/agile/1.0/sprint/7/issue'));
  assert.equal(JSON.parse(fetch.calls[2].init.body).issues[19], 'STD-120');
});

test('rankIssues requires exactly one anchor and chunks', async () => {
  await assert.rejects(rankIssues(['A'], { auth: AUTH }), /exactly one/);
  await assert.rejects(
    rankIssues(['A'], { auth: AUTH, after: 'B', before: 'C' }),
    /exactly one/,
  );
  const keys = Array.from({ length: 51 }, (_, i) => `K-${i}`);
  const fetch = fakeFetch([reply(204), reply(204)]);
  setFetch(fetch);
  await rankIssues(keys, { auth: AUTH, before: 'K-anchor' });
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].init.method, 'PUT');
  assert.ok(fetch.calls[0].url.endsWith('/rest/agile/1.0/issue/rank'));
  const body = JSON.parse(fetch.calls[1].init.body);
  assert.deepEqual(body, { issues: ['K-50'], rankBeforeIssue: 'K-anchor' });
});

test('listSprints follows pagination until isLast', async () => {
  const fetch = fakeFetch([
    reply(200, { values: [{ id: 1 }, { id: 2 }], isLast: false }),
    reply(200, { values: [{ id: 3 }], isLast: true }),
  ]);
  setFetch(fetch);
  const sprints = await listSprints(12, { auth: AUTH, state: 'active,future' });
  assert.deepEqual(
    sprints.map((s) => s.id),
    [1, 2, 3],
  );
  const first = new URL(fetch.calls[0].url);
  assert.equal(first.pathname, '/rest/agile/1.0/board/12/sprint');
  assert.equal(first.searchParams.get('state'), 'active,future');
  assert.equal(first.searchParams.get('startAt'), '0');
  assert.equal(new URL(fetch.calls[1].url).searchParams.get('startAt'), '2');
});

test('filterFields matches name substring case-insensitively', () => {
  const fields = [
    { id: 'customfield_10016', name: 'Story point estimate', schema: { custom: 'c:float' } },
    { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'c:sprint' } },
    { id: 'summary', name: 'Summary' },
  ];
  assert.deepEqual(filterFields(fields, 'story POINT'), [
    { id: 'customfield_10016', name: 'Story point estimate', custom: 'c:float' },
  ]);
  assert.equal(filterFields(fields).length, 3);
  assert.deepEqual(filterFields(fields, 'summary'), [
    { id: 'summary', name: 'Summary', custom: null },
  ]);
});

test('setDescription wraps the ADF in fields.description', async () => {
  const fetch = fakeFetch([reply(204)]);
  setFetch(fetch);
  const adf = { type: 'doc', version: 1, content: [] };
  await setDescription('STD-9', adf, { auth: AUTH });
  const [{ url, init }] = fetch.calls;
  assert.ok(url.endsWith('/rest/api/3/issue/STD-9'));
  assert.equal(init.method, 'PUT');
  assert.deepEqual(JSON.parse(init.body), { fields: { description: adf } });
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

test('parseArgs separates command, positionals, flags and values', () => {
  assert.deepEqual(
    parseArgs(['rank', 'A', 'B', '--after', 'C', '--yes', '--with-subtasks']),
    {
      command: 'rank',
      positional: ['A', 'B'],
      after: 'C',
      yes: true,
      with_subtasks: true,
    },
  );
});

test('delete commands refuse without --yes and never call fetch', async () => {
  const fetch = fakeFetch([]);
  setFetch(fetch);
  const issue = await cli(['delete-issue', 'STD-1', '--with-subtasks'], {});
  assert.equal(issue.code, 2);
  assert.match(issue.out, /would delete issue STD-1 and its subtasks/);
  const att = await cli(['delete-attachment', '42']);
  assert.equal(att.code, 2);
  assert.match(att.out, /would delete attachment 42/);
  const com = await cli(['delete-comment', 'STD-1', '7']);
  assert.equal(com.code, 2);
  assert.match(com.out, /would delete comment 7 on STD-1/);
  assert.equal(fetch.calls.length, 0);
});

test('delete-issue with --yes performs the DELETE', async () => {
  const fetch = fakeFetch([reply(204)]);
  setFetch(fetch);
  const res = await cli(['delete-issue', 'STD-1', '--yes']);
  assert.equal(res.code, 0);
  assert.match(res.out, /deleted issue STD-1/);
  assert.equal(fetch.calls.length, 1);
  assert.ok(fetch.calls[0].url.endsWith('deleteSubtasks=false'));
});

test('fields CLI filters by --name and prints id/name/custom', async () => {
  setFetch(
    fakeFetch([
      reply(200, [
        { id: 'customfield_1', name: 'Story Points', schema: { custom: 'x' } },
        { id: 'summary', name: 'Summary' },
      ]),
    ]),
  );
  const res = await cli(['fields', '--name', 'story']);
  assert.equal(res.code, 0);
  assert.equal(res.out, 'customfield_1\tStory Points\tx\n');
});

test('CLI reports missing env without leaking the token', async () => {
  const res = await cli(['fields'], { JIRA_SITE: 'https://x' });
  assert.equal(res.code, 1);
  assert.match(res.err, /JIRA_EMAIL and JIRA_API_TOKEN/);
  const bad = await cli(['sprints']);
  assert.equal(bad.code, 1);
  assert.equal(bad.err.includes('secret-token'), false);
});

test('CLI --site overrides env site', async () => {
  const fetch = fakeFetch([reply(200, { values: [], isLast: true })]);
  setFetch(fetch);
  const res = await cli(['sprints', '3', '--site', 'https://other.example']);
  assert.equal(res.code, 0);
  assert.ok(fetch.calls[0].url.startsWith('https://other.example/rest/agile'));
});

test('CLI usage errors exit 2', async () => {
  assert.equal((await cli([])).code, 2);
  const res = await cli(['nope']);
  assert.equal(res.code, 2);
  assert.match(res.err, /unknown command/);
});

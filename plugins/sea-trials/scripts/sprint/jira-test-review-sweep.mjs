#!/usr/bin/env node
/**
 * Nightly sweep for /st-jira-test-review: find review-column issues that
 * changed recently, resolve their PR + head SHA, skip the ones that already
 * carry a QA comment for that head, and emit one task line per issue.
 *
 *   node jira-test-review-sweep.mjs --project KEY [--status "Code Review"]
 *     [--sprint active|<id>] [--assignee-not me] [--since 24h] [--max 10]
 *     [--repo owner/name] [--repo-root <dir>] [--tester <accountId>]
 *     [--json|--tasks]
 *
 * Auth: `JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (see jira-rest.mjs).
 * Defaults: `JIRA_PROJECT_KEY`, `JIRA_REVIEW_STATUS` (comma-separated),
 * `JIRA_TESTER_ACCOUNT_ID`, `GITHUB_REPO`, `ST_SWEEP_MAX`.
 *
 * Idempotence: a QA comment names the tested commit's short SHA once
 * (`references/qa-comment-voice.md`). An issue whose comments already
 * contain a 7+ hex prefix of the current PR head is skipped.
 *
 * stdout: task JSON lines (`--tasks`), the collected records (`--json`), or
 * a plain table. stderr: `candidates=N skipped_verdicted=M emitted=K`.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestJson, resolveAuth } from './jira-rest.mjs';

// ===========================================================================
// CONSTANTS
// ===========================================================================

export const DEFAULT_STATUSES = ['In Review', 'Ready for QA'];
export const DEFAULT_SINCE = '24h';
export const DEFAULT_MAX = 10;
export const PAGE_SIZE = 50;
export const MAX_PAGES = 40;
// The test review checks out a worktree, runs tests and posts a verdict,
// so it needs a full-tool worker driving the skill. st-jira-verifier is
// read-only and would not be able to post; do not pin it here.
export const SUBAGENT_TYPE = 'generalPurpose';
export const CLAUDE_AGENT = null;
export const FALLBACK_SUBAGENT_TYPE = 'generalPurpose';

const ISSUE_FIELDS = [
  'summary',
  'status',
  'assignee',
  'updated',
  'description',
  'comment',
];

const PR_URL_RE = /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const BLOCK_CONTAINERS = new Set([
  'doc',
  'bulletList',
  'orderedList',
  'taskList',
  'listItem',
  'blockquote',
  'panel',
  'table',
  'tableRow',
]);
const HEX_TOKEN_RE = /\b[0-9a-f]{7,40}\b/gi;
const SINCE_RE = /^(\d+)\s*([mhdw])$/i;

// ===========================================================================
// INJECTABLES
// ===========================================================================

let runnerImpl = (args) => spawnSync('gh', args, { encoding: 'utf8' });

/** Replace the `gh` runner (tests). Returns the previous one. */
export function setRunner(fn) {
  const prev = runnerImpl;
  runnerImpl = fn;
  return prev;
}

// ===========================================================================
// ARGS + JQL
// ===========================================================================

/** @param {string[]} argv */
export function parseArgs(argv, env = process.env) {
  const out = {
    project: env.JIRA_PROJECT_KEY ?? null,
    statuses: splitList(env.JIRA_REVIEW_STATUS) ?? DEFAULT_STATUSES,
    sprint: null,
    assigneeNot: null,
    since: DEFAULT_SINCE,
    max: Number(env.ST_SWEEP_MAX) || DEFAULT_MAX,
    repo: env.GITHUB_REPO ?? null,
    repoRoot: process.cwd(),
    tester: env.JIRA_TESTER_ACCOUNT_ID ?? null,
    site: null,
    format: 'table',
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--project') out.project = argv[++i];
    else if (arg === '--status') out.statuses = splitList(argv[++i]);
    else if (arg === '--sprint') out.sprint = argv[++i];
    else if (arg === '--assignee-not') out.assigneeNot = argv[++i];
    else if (arg === '--since') out.since = argv[++i];
    else if (arg === '--max') out.max = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--repo-root') out.repoRoot = path.resolve(argv[++i]);
    else if (arg === '--tester') out.tester = argv[++i];
    else if (arg === '--site') out.site = argv[++i];
    else if (arg === '--json') out.format = 'json';
    else if (arg === '--tasks') out.format = 'tasks';
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.project) {
    throw new Error('--project (or JIRA_PROJECT_KEY) is required');
  }
  if (!Number.isInteger(out.max) || out.max < 1) {
    throw new Error('--max must be a positive integer');
  }
  return out;
}

function splitList(value) {
  if (!value) return null;
  const items = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length ? items : null;
}

/**
 * `24h` → `-24h`; also accepts `-24h`, `2d`, `1w`, `90m`, or a date.
 *
 * @param {string} since
 */
export function sinceToJql(since) {
  const s = String(since ?? '').trim();
  if (!s) return `-${DEFAULT_SINCE}`;
  if (/^-\d+[mhdw]$/i.test(s)) return s.toLowerCase();
  const m = SINCE_RE.exec(s);
  if (m) return `-${m[1]}${m[2].toLowerCase()}`;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    return `"${s.slice(0, 16).replace('T', ' ')}"`;
  }
  throw new Error(`--since expects <n>[m|h|d|w] or a date, got "${since}"`);
}

function jqlString(value) {
  return `"${String(value).replace(/"/g, '\\"')}"`;
}

/**
 * @param {{project: string, statuses: string[], sprint?: string|null,
 *   assigneeNot?: string|null, since?: string}} o
 */
export function buildJql(o) {
  const parts = [`project = ${o.project}`];
  const statuses = (o.statuses ?? DEFAULT_STATUSES).map(jqlString);
  parts.push(
    statuses.length === 1
      ? `status = ${statuses[0]}`
      : `status in (${statuses.join(', ')})`,
  );
  if (o.sprint === 'active') parts.push('sprint in openSprints()');
  else if (o.sprint) parts.push(`sprint = ${o.sprint}`);
  if (o.assigneeNot === 'me') parts.push('assignee != currentUser()');
  else if (o.assigneeNot) parts.push(`assignee != ${jqlString(o.assigneeNot)}`);
  parts.push(`updated >= ${sinceToJql(o.since)}`);
  return `${parts.join(' AND ')} ORDER BY updated ASC`;
}

// ===========================================================================
// JIRA READS
// ===========================================================================

/**
 * POST /rest/api/3/search/jql, following `nextPageToken`.
 *
 * @param {string} jql
 * @param {{ auth: object, fields?: string[], pageSize?: number }} o
 */
export async function searchIssues(jql, o) {
  const issues = [];
  let nextPageToken;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const body = {
      jql,
      fields: o.fields ?? ISSUE_FIELDS,
      maxResults: o.pageSize ?? PAGE_SIZE,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;
    const data = await requestJson('POST', '/rest/api/3/search/jql', {
      body,
      auth: o.auth,
    });
    issues.push(...(data?.issues ?? []));
    nextPageToken = data?.nextPageToken;
    if (!nextPageToken || data?.isLast === true) return issues;
  }
  throw new Error('search pagination did not terminate');
}

/** Remote links for one issue; empty array on 404 (feature disabled). */
export async function fetchRemoteLinks(key, auth) {
  try {
    const data = await requestJson(
      'GET',
      `/rest/api/3/issue/${key}/remotelink`,
      { auth },
    );
    return Array.isArray(data) ? data : [];
  } catch (e) {
    if (e.status === 404 || e.status === 403) return [];
    throw e;
  }
}

/**
 * Comments for one issue, newest first. Uses the search payload when it
 * already holds every comment; otherwise fetches the last 50.
 */
export async function fetchComments(issue, auth) {
  const inline = issue.fields?.comment;
  const list = inline?.comments;
  if (Array.isArray(list) && (inline.total ?? list.length) <= list.length) {
    return [...list].sort((a, b) => cmpDesc(a.created, b.created));
  }
  const data = await requestJson(
    'GET',
    `/rest/api/3/issue/${issue.key}/comment`,
    { query: { orderBy: '-created', maxResults: 50 }, auth },
  );
  return data?.comments ?? [];
}

function cmpDesc(a, b) {
  return String(b ?? '').localeCompare(String(a ?? ''));
}

// ===========================================================================
// TEXT + URL EXTRACTION
// ===========================================================================

/** Concatenated text of an ADF node tree, or the string itself. */
export function adfText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(adfText).join('');
  if (typeof node !== 'object') return '';
  let out = '';
  if (typeof node.text === 'string') out += node.text;
  if (node.type === 'mention' && node.attrs?.text) out += node.attrs.text;
  if (node.marks) {
    for (const m of node.marks) {
      if (m.type === 'link' && m.attrs?.href) out += ` ${m.attrs.href} `;
    }
  }
  if (node.attrs?.url) out += ` ${node.attrs.url} `;
  if (Array.isArray(node.content)) {
    const sep = BLOCK_CONTAINERS.has(node.type) ? '\n' : '';
    out += node.content.map(adfText).join(sep);
  }
  return out;
}

/**
 * Every GitHub PR URL found anywhere inside `value` (strings, ADF, nested
 * objects such as custom fields and remote links), de-duplicated.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function extractPrUrls(value) {
  const found = new Set();
  const visit = (v) => {
    if (v == null) return;
    if (typeof v === 'string') {
      for (const m of v.matchAll(PR_URL_RE)) found.add(m[0]);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...found];
}

/** Short (7) SHA used in comments. */
export function shortSha(sha) {
  return sha ? String(sha).slice(0, 7).toLowerCase() : null;
}

/**
 * True when a comment already names the tested head: any 7-40 hex token
 * in the comment text is a prefix of `headSha`. When `testerId` is given
 * only that author's comments count.
 *
 * @param {object[]} comments Jira comment objects
 * @param {string|null} headSha
 * @param {string|null} [testerId]
 */
export function hasVerdictForSha(comments, headSha, testerId) {
  if (!headSha) return false;
  const head = String(headSha).toLowerCase();
  for (const c of comments ?? []) {
    if (testerId && c.author?.accountId !== testerId) continue;
    const text = adfText(c.body).toLowerCase();
    for (const m of text.matchAll(HEX_TOKEN_RE)) {
      if (head.startsWith(m[0])) return true;
    }
  }
  return false;
}

/**
 * Newest comment not written by the tester, trimmed to ~200 chars.
 *
 * @returns {{ author: string, created: string, snippet: string }|null}
 */
export function lastDevComment(comments, testerId) {
  const sorted = [...(comments ?? [])].sort((a, b) =>
    cmpDesc(a.created, b.created),
  );
  for (const c of sorted) {
    if (testerId && c.author?.accountId === testerId) continue;
    const text = adfText(c.body).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    return {
      author: c.author?.displayName ?? c.author?.accountId ?? 'unknown',
      created: c.created ?? '',
      snippet: text.length > 200 ? `${text.slice(0, 197)}...` : text,
    };
  }
  return null;
}

// ===========================================================================
// PR RESOLUTION (gh)
// ===========================================================================

const PR_JSON_FIELDS = 'number,url,headRefName,headRefOid,state,title';

function ghJson(args) {
  const res = runnerImpl(args);
  if (!res || res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout);
  } catch {
    return null;
  }
}

/**
 * Resolve the PR for an issue: explicit URLs first (`gh pr view`), then a
 * search on key in title or head branch. Never throws; returns nulls when
 * `gh` is missing or finds nothing.
 *
 * @param {string} key
 * @param {string[]} prUrls
 * @param {{ repo?: string|null }} [o]
 * @returns {{ pr: string|null, number: number|null, branch: string|null,
 *   headSha: string|null, state: string|null }}
 */
export function resolvePr(key, prUrls, o = {}) {
  const empty = {
    pr: null,
    number: null,
    branch: null,
    headSha: null,
    state: null,
  };
  const shape = (p) => ({
    pr: p.url ?? null,
    number: p.number ?? null,
    branch: p.headRefName ?? null,
    headSha: p.headRefOid ?? null,
    state: p.state ?? null,
  });
  const viewed = [];
  for (const url of prUrls) {
    const p = ghJson(['pr', 'view', url, '--json', PR_JSON_FIELDS]);
    if (p) viewed.push(p);
  }
  if (viewed.length) return shape(pickPr(viewed));
  const args = [
    'pr',
    'list',
    '--search',
    `${key} in:title,head`,
    '--state',
    'all',
    '--limit',
    '5',
    '--json',
    PR_JSON_FIELDS,
  ];
  if (o.repo) args.push('-R', o.repo);
  const list = ghJson(args);
  if (Array.isArray(list) && list.length) return shape(pickPr(list));
  if (prUrls.length) return { ...empty, pr: prUrls[0] };
  return empty;
}

/** Prefer an open PR; otherwise the first one listed. */
export function pickPr(prs) {
  return prs.find((p) => String(p.state).toUpperCase() === 'OPEN') ?? prs[0];
}

// ===========================================================================
// RECORDS + TASKS
// ===========================================================================

/**
 * Collect everything the sweep knows about one issue.
 *
 * @param {object} issue Jira issue from search
 * @param {{ auth: object, tester?: string|null, repo?: string|null }} ctx
 */
export async function collectIssue(issue, ctx) {
  const fields = issue.fields ?? {};
  const [links, comments] = await Promise.all([
    fetchRemoteLinks(issue.key, ctx.auth),
    fetchComments(issue, ctx.auth),
  ]);
  const { comment: _omit, ...fieldsWithoutComments } = fields;
  const prUrls = [
    ...new Set([
      ...extractPrUrls(links),
      ...extractPrUrls(fieldsWithoutComments),
    ]),
  ];
  const pr = resolvePr(issue.key, prUrls, { repo: ctx.repo });
  const verdicted = hasVerdictForSha(comments, pr.headSha, ctx.tester);
  return {
    key: issue.key,
    summary: fields.summary ?? '',
    status: fields.status?.name ?? null,
    assignee: fields.assignee?.displayName ?? null,
    assigneeAccountId: fields.assignee?.accountId ?? null,
    updated: fields.updated ?? null,
    prUrls,
    pr: pr.pr,
    prNumber: pr.number,
    prState: pr.state,
    branch: pr.branch,
    headSha: pr.headSha,
    shortSha: shortSha(pr.headSha),
    lastDevComment: lastDevComment(comments, ctx.tester),
    verdicted,
  };
}

/**
 * Self-contained brief for one review worker. No host tool names beyond
 * the skill slash command; the host decides how to run it.
 */
export function buildPrompt(rec, ctx) {
  const lines = [
    `Run the Sea Trials skill st-jira-test-review for Jira issue ${rec.key}` +
      ` ("${rec.summary}").`,
    'On Cursor invoke /st-jira-test-review; on Claude Code invoke ' +
      '/sea-trials:st-jira-test-review. Follow every phase of that skill.',
    `Repo root: ${ctx.repoRoot}. Never test in that checkout; the skill ` +
      'creates its own worktree.',
  ];
  if (rec.pr) {
    const bits = [];
    if (rec.branch) bits.push(`branch ${rec.branch}`);
    if (rec.headSha) bits.push(`head ${rec.headSha}`);
    lines.push(`PR: ${rec.pr}${bits.length ? ` (${bits.join(', ')})` : ''}`);
  } else {
    lines.push(
      'No PR link was found on the card; resolve the branch with ' +
        `\`gh pr list --search "${rec.key} in:title,head"\` first.`,
    );
  }
  if (rec.lastDevComment) {
    lines.push(
      `Latest developer note (${rec.lastDevComment.author}): ` +
        `"${rec.lastDevComment.snippet}"`,
    );
  }
  lines.push(
    rec.shortSha
      ? `No QA comment names ${rec.shortSha} yet, so this head is untested. ` +
          `Name ${rec.shortSha} once in your comment so the next sweep ` +
          'skips it.'
      : 'Name the tested commit short SHA once in your comment so the next ' +
          'sweep skips it.',
    'This is a headless run: never ask the user anything. A verdict of ' +
      'NEEDS DISCUSSION means comment without transitioning.',
    'Finish by printing exactly one JSON line: ' +
      `{"key":"${rec.key}","verdict":"PASS|PASS (different approach)|FAIL|` +
      'NEEDS DISCUSSION","commented":true|false,' +
      '"transitionedTo":"<status or null>"}',
  );
  return lines.join('\n');
}

/**
 * Task line in the plugin's fan-out shape (see st-build-shard-tasks.mjs).
 */
export function buildTask(rec, ctx) {
  return {
    source: 'test-review-sweep',
    id: `test-review:${rec.key}`,
    taskId: `test-review:${rec.key}`,
    key: rec.key,
    summary: rec.summary,
    pr: rec.pr,
    headSha: rec.headSha,
    branch: rec.branch,
    subagent_type: SUBAGENT_TYPE,
    fallbackSubagentType: FALLBACK_SUBAGENT_TYPE,
    ...(CLAUDE_AGENT ? { claudeAgent: CLAUDE_AGENT } : {}),
    model: 'inherit',
    claudeModel: 'inherit',
    run_in_background: true,
    description: `Test review ${rec.key}`,
    prompt: buildPrompt(rec, ctx),
  };
}

/**
 * Run the whole sweep. Returns records, the tasks to emit, and counts.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ auth: object }} deps
 */
export async function runSweep(args, deps) {
  const jql = buildJql(args);
  const issues = await searchIssues(jql, { auth: deps.auth });
  const records = [];
  for (const issue of issues) {
    records.push(
      await collectIssue(issue, {
        auth: deps.auth,
        tester: args.tester,
        repo: args.repo,
      }),
    );
  }
  const pending = records.filter((r) => !r.verdicted);
  const chosen = pending.slice(0, args.max);
  const tasks = chosen.map((r) => buildTask(r, { repoRoot: args.repoRoot }));
  return {
    jql,
    records,
    tasks,
    summary: {
      candidates: records.length,
      skippedVerdicted: records.length - pending.length,
      emitted: tasks.length,
      deferred: pending.length - chosen.length,
    },
  };
}

// ===========================================================================
// CLI
// ===========================================================================

const USAGE = `\
usage: jira-test-review-sweep.mjs --project KEY [--status "A,B"]
  [--sprint active|<id>] [--assignee-not me] [--since 24h] [--max 10]
  [--repo owner/name] [--repo-root <dir>] [--tester <accountId>]
  [--site <url>] [--json|--tasks]
`;

function summaryLine(s) {
  return (
    `candidates=${s.candidates} skipped_verdicted=${s.skippedVerdicted} ` +
    `emitted=${s.emitted}` +
    (s.deferred ? ` deferred_over_max=${s.deferred}` : '')
  );
}

function tableLine(r) {
  return [
    r.key,
    r.verdicted ? 'reviewed' : 'pending',
    r.shortSha ?? '-',
    r.pr ?? '-',
    r.summary,
  ].join('\t');
}

/**
 * @param {string[]} argv
 * @param {{ stdout?: Function, stderr?: Function, env?: object }} [io]
 */
export async function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const env = io.env ?? process.env;
  let args;
  try {
    args = parseArgs(argv, env);
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }
  try {
    const auth = resolveAuth({ site: args.site, env });
    const result = await runSweep(args, { auth });
    if (args.format === 'tasks') {
      for (const t of result.tasks) out(`${JSON.stringify(t)}\n`);
    } else if (args.format === 'json') {
      const doc = { jql: result.jql, issues: result.records };
      out(`${JSON.stringify(doc, null, 2)}\n`);
    } else {
      out('KEY\tSTATE\tHEAD\tPR\tSUMMARY\n');
      for (const r of result.records) out(`${tableLine(r)}\n`);
    }
    err(`${summaryLine(result.summary)}\n`);
    return 0;
  } catch (e) {
    err(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}

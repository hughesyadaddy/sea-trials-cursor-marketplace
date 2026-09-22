#!/usr/bin/env node
/**
 * Jira Cloud REST fallbacks for what the Atlassian MCP v1 cannot do
 * (attachments, deletes, sprint/backlog moves, ranking, field discovery).
 *
 * Auth: env `JIRA_EMAIL` + `JIRA_API_TOKEN` (Basic) and `JIRA_SITE`
 * (`https://yoursite.atlassian.net`) or `--site <url>`. The token is
 * never printed.
 *
 * Usage:
 *   node jira-rest.mjs attach <issueKey> <filePath...>
 *   node jira-rest.mjs delete-issue <issueKey> [--with-subtasks] --yes
 *   node jira-rest.mjs delete-attachment <attachmentId> --yes
 *   node jira-rest.mjs delete-comment <issueKey> <commentId> --yes
 *   node jira-rest.mjs move-to-sprint <sprintId> <issueKey...>
 *   node jira-rest.mjs move-to-backlog <issueKey...>
 *   node jira-rest.mjs rank <issueKey...> --after <KEY> | --before <KEY>
 *   node jira-rest.mjs sprints <boardId> [--state active,future]
 *   node jira-rest.mjs fields [--name "Story point estimate"]
 *   node jira-rest.mjs set-description <issueKey> <adf.json>
 *
 * Destructive subcommands print what they would delete and exit 2 unless
 * `--yes` is passed. 429s honour `Retry-After`; 5xx are retried.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const MAX_429_ATTEMPTS = 5;
const MAX_5XX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const AGILE_CHUNK = 50;

// ===========================================================================
// INJECTABLES (tests swap these; no real network in tests)
// ===========================================================================

let fetchImpl = (...args) => globalThis.fetch(...args);
let sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Replace the fetch implementation (tests). Returns the previous one. */
export function setFetch(fn) {
  const prev = fetchImpl;
  fetchImpl = fn;
  return prev;
}

/** Replace the sleep implementation (tests). Returns the previous one. */
export function setSleep(fn) {
  const prev = sleepImpl;
  sleepImpl = fn;
  return prev;
}

// ===========================================================================
// HELPERS
// ===========================================================================

/**
 * Split `arr` into arrays of at most `n` items.
 *
 * @template T
 * @param {T[]} arr
 * @param {number} n
 * @returns {T[][]}
 */
export function chunk(arr, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error('chunk size must be >= 1');
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/**
 * Resolve site + Basic auth header from explicit values or env.
 *
 * @param {{ site?: string, email?: string, token?: string, env?: object }} o
 * @returns {{ site: string, authorization: string }}
 */
export function resolveAuth(o = {}) {
  const env = o.env ?? process.env;
  const site = (o.site ?? env.JIRA_SITE ?? '').replace(/\/+$/, '');
  const email = o.email ?? env.JIRA_EMAIL;
  const token = o.token ?? env.JIRA_API_TOKEN;
  if (!site) throw new Error('JIRA_SITE (or --site) is required');
  if (!email || !token) {
    throw new Error('JIRA_EMAIL and JIRA_API_TOKEN env vars are required');
  }
  const basic = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return { site, authorization: `Basic ${basic}` };
}

function buildUrl(site, p, query) {
  const url = new URL(p, `${site}/`);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/** Human-readable message from a Jira error payload. */
export function formatJiraError(status, payload, fallbackText) {
  const parts = [];
  if (payload && typeof payload === 'object') {
    for (const m of payload.errorMessages ?? []) parts.push(m);
    for (const [field, msg] of Object.entries(payload.errors ?? {})) {
      parts.push(`${field}: ${msg}`);
    }
  }
  if (!parts.length && fallbackText) parts.push(fallbackText.slice(0, 300));
  return `Jira HTTP ${status}${parts.length ? `: ${parts.join('; ')}` : ''}`;
}

async function readBody(res) {
  const text = await res.text();
  if (!text) return { json: null, text: '' };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function retryAfterMs(res, attempt) {
  const header = res.headers?.get?.('retry-after');
  const secs = Number(header);
  if (header && Number.isFinite(secs) && secs >= 0) return secs * 1000;
  return BACKOFF_BASE_MS * 2 ** attempt;
}

/**
 * Authenticated JSON request with 429/5xx retry.
 *
 * @param {string} method
 * @param {string} p path such as `/rest/api/3/issue/KEY`
 * @param {{
 *   body?: unknown, form?: FormData, query?: object, headers?: object,
 *   auth?: { site: string, authorization: string },
 * }} [opts]
 * @returns {Promise<unknown>} parsed JSON, or null for empty bodies
 */
export async function requestJson(method, p, opts = {}) {
  const auth = opts.auth ?? resolveAuth();
  const url = buildUrl(auth.site, p, opts.query);
  const headers = {
    Authorization: auth.authorization,
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };
  let body;
  if (opts.form) {
    body = opts.form;
  } else if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }

  let attempts429 = 0;
  let attempts5xx = 0;
  for (;;) {
    const res = await fetchImpl(url, { method, headers, body });
    if (res.status === 429 && attempts429 < MAX_429_ATTEMPTS - 1) {
      await sleepImpl(retryAfterMs(res, attempts429));
      attempts429 += 1;
      continue;
    }
    if (res.status >= 500 && attempts5xx < MAX_5XX_ATTEMPTS - 1) {
      await sleepImpl(BACKOFF_BASE_MS * 2 ** attempts5xx);
      attempts5xx += 1;
      continue;
    }
    const { json, text } = await readBody(res);
    if (!res.ok) {
      const err = new Error(formatJiraError(res.status, json, text));
      err.status = res.status;
      err.payload = json;
      throw err;
    }
    return json;
  }
}

// ===========================================================================
// OPERATIONS
// ===========================================================================

/**
 * Upload files as attachments.
 *
 * @param {string} issueKey
 * @param {string[]} files
 * @param {{ auth?: object }} [opts]
 */
export async function attachFiles(issueKey, files, opts = {}) {
  if (!files.length) throw new Error('attach needs at least one file');
  const form = new FormData();
  for (const file of files) {
    const buf = fs.readFileSync(file);
    form.append('file', new Blob([buf]), path.basename(file));
  }
  return requestJson('POST', `/rest/api/3/issue/${issueKey}/attachments`, {
    form,
    headers: { 'X-Atlassian-Token': 'no-check' },
    auth: opts.auth,
  });
}

/**
 * @param {string} issueKey
 * @param {{ withSubtasks?: boolean, auth?: object }} o
 */
export async function deleteIssue(issueKey, o = {}) {
  return requestJson('DELETE', `/rest/api/3/issue/${issueKey}`, {
    query: { deleteSubtasks: o.withSubtasks ? 'true' : 'false' },
    auth: o.auth,
  });
}

export async function deleteAttachment(attachmentId, o = {}) {
  return requestJson('DELETE', `/rest/api/3/attachment/${attachmentId}`, {
    auth: o.auth,
  });
}

export async function deleteComment(issueKey, commentId, o = {}) {
  return requestJson(
    'DELETE',
    `/rest/api/3/issue/${issueKey}/comment/${commentId}`,
    { auth: o.auth },
  );
}

/** Move issues into a sprint, 50 per request. */
export async function moveToSprint(sprintId, issueKeys, o = {}) {
  for (const issues of chunk(issueKeys, AGILE_CHUNK)) {
    await requestJson('POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, {
      body: { issues },
      auth: o.auth,
    });
  }
  return issueKeys.length;
}

/** Move issues to the backlog, 50 per request. */
export async function moveToBacklog(issueKeys, o = {}) {
  for (const issues of chunk(issueKeys, AGILE_CHUNK)) {
    await requestJson('POST', '/rest/agile/1.0/backlog/issue', {
      body: { issues },
      auth: o.auth,
    });
  }
  return issueKeys.length;
}

/**
 * Rank issues after or before another issue, 50 per request.
 *
 * @param {string[]} issueKeys
 * @param {{ after?: string, before?: string, auth?: object }} o
 */
export async function rankIssues(issueKeys, o = {}) {
  if (Boolean(o.after) === Boolean(o.before)) {
    throw new Error('rank needs exactly one of --after or --before');
  }
  const anchor = o.after
    ? { rankAfterIssue: o.after }
    : { rankBeforeIssue: o.before };
  for (const issues of chunk(issueKeys, AGILE_CHUNK)) {
    await requestJson('PUT', '/rest/agile/1.0/issue/rank', {
      body: { issues, ...anchor },
      auth: o.auth,
    });
  }
  return issueKeys.length;
}

/**
 * All sprints on a board, following pagination until `isLast`.
 *
 * @param {number|string} boardId
 * @param {{ state?: string, auth?: object }} o
 */
export async function listSprints(boardId, o = {}) {
  const out = [];
  let startAt = 0;
  for (let page = 0; page < 100; page += 1) {
    const data = await requestJson(
      'GET',
      `/rest/agile/1.0/board/${boardId}/sprint`,
      { query: { startAt, state: o.state, maxResults: 50 }, auth: o.auth },
    );
    const values = data?.values ?? [];
    out.push(...values);
    if (data?.isLast !== false || values.length === 0) return out;
    startAt += values.length;
  }
  throw new Error(`sprint pagination did not terminate for board ${boardId}`);
}

/**
 * Fields whose name contains `name` (case-insensitive). Use it to find the
 * per-site custom field ids for story points and sprint.
 *
 * @param {{ name?: string, auth?: object }} o
 * @returns {Promise<Array<{ id: string, name: string, custom: string|null }>>}
 */
export async function listFields(o = {}) {
  const fields = (await requestJson('GET', '/rest/api/3/field', {
    auth: o.auth,
  })) ?? [];
  return filterFields(fields, o.name);
}

/** Pure filter/shape step behind `listFields`. */
export function filterFields(fields, name) {
  const needle = (name ?? '').toLowerCase();
  return fields
    .filter((f) => !needle || (f.name ?? '').toLowerCase().includes(needle))
    .map((f) => ({
      id: f.id,
      name: f.name,
      custom: f.schema?.custom ?? null,
    }));
}

/** Replace an issue description with an ADF document. */
export async function setDescription(issueKey, adf, o = {}) {
  return requestJson('PUT', `/rest/api/3/issue/${issueKey}`, {
    body: { fields: { description: adf } },
    auth: o.auth,
  });
}

// ===========================================================================
// CLI
// ===========================================================================

const FLAGS = new Set(['--yes', '--with-subtasks']);

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { command: argv[0], positional: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.has(arg)) out[arg.slice(2).replace(/-/g, '_')] = true;
    else if (arg.startsWith('--')) {
      out[arg.slice(2).replace(/-/g, '_')] = argv[++i];
    } else out.positional.push(arg);
  }
  return out;
}

/** Human description of what a delete command targets, or null. */
function describeDeleteTarget(args) {
  const pos = args.positional;
  switch (args.command) {
    case 'delete-issue':
      if (!pos[0]) return null;
      return `issue ${pos[0]}${args.with_subtasks ? ' and its subtasks' : ''}`;
    case 'delete-attachment':
      return pos[0] ? `attachment ${pos[0]}` : null;
    case 'delete-comment':
      return pos[0] && pos[1] ? `comment ${pos[1]} on ${pos[0]}` : null;
    default:
      return null;
  }
}

const USAGE =
  'usage: jira-rest.mjs <attach|delete-issue|delete-attachment|' +
  'delete-comment|move-to-sprint|move-to-backlog|rank|sprints|fields|' +
  'set-description> ... [--site <url>] [--yes]\n';

/**
 * Run the CLI against `argv` (without node/script). Returns the exit
 * code; writes to `io.stdout` / `io.stderr` so tests can capture output.
 *
 * @param {string[]} argv
 * @param {{ stdout?: (s: string) => void, stderr?: (s: string) => void,
 *   env?: object }} [io]
 */
export async function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  const args = parseArgs(argv);
  const pos = args.positional;
  if (!args.command) {
    err(USAGE);
    return 2;
  }

  // Destructive commands refuse before touching auth or the network.
  const target = describeDeleteTarget(args);
  if (target && !args.yes) {
    out(`DRY RUN: would delete ${target}. Re-run with --yes to confirm.\n`);
    return 2;
  }

  try {
    const auth = resolveAuth({ site: args.site, env: io.env });
    const o = { auth };

    switch (args.command) {
      case 'attach': {
        const [key, ...files] = pos;
        if (!key || !files.length) throw new Error('attach <key> <file...>');
        const res = await attachFiles(key, files, o);
        for (const a of res ?? []) out(`attached ${a.id} ${a.filename}\n`);
        return 0;
      }
      case 'delete-issue': {
        const [key] = pos;
        if (!key) throw new Error('delete-issue <key>');
        await deleteIssue(key, { ...o, withSubtasks: args.with_subtasks });
        out(`deleted ${target}\n`);
        return 0;
      }
      case 'delete-attachment': {
        const [id] = pos;
        if (!id) throw new Error('delete-attachment <id>');
        await deleteAttachment(id, o);
        out(`deleted ${target}\n`);
        return 0;
      }
      case 'delete-comment': {
        const [key, id] = pos;
        if (!key || !id) throw new Error('delete-comment <key> <commentId>');
        await deleteComment(key, id, o);
        out(`deleted ${target}\n`);
        return 0;
      }
      case 'move-to-sprint': {
        const [sprintId, ...keys] = pos;
        if (!sprintId || !keys.length) {
          throw new Error('move-to-sprint <sprintId> <key...>');
        }
        const n = await moveToSprint(sprintId, keys, o);
        out(`moved ${n} issue(s) to sprint ${sprintId}\n`);
        return 0;
      }
      case 'move-to-backlog': {
        if (!pos.length) throw new Error('move-to-backlog <key...>');
        const n = await moveToBacklog(pos, o);
        out(`moved ${n} issue(s) to backlog\n`);
        return 0;
      }
      case 'rank': {
        if (!pos.length) throw new Error('rank <key...> --after|--before');
        const n = await rankIssues(pos, {
          ...o,
          after: args.after,
          before: args.before,
        });
        out(`ranked ${n} issue(s)\n`);
        return 0;
      }
      case 'sprints': {
        const [boardId] = pos;
        if (!boardId) throw new Error('sprints <boardId> [--state ...]');
        const sprints = await listSprints(boardId, { ...o, state: args.state });
        for (const s of sprints) {
          out(`${s.id}\t${s.state}\t${s.name}\n`);
        }
        return 0;
      }
      case 'fields': {
        const fields = await listFields({ ...o, name: args.name });
        for (const f of fields) out(`${f.id}\t${f.name}\t${f.custom ?? ''}\n`);
        return 0;
      }
      case 'set-description': {
        const [key, file] = pos;
        if (!key || !file) throw new Error('set-description <key> <adf.json>');
        const adf = JSON.parse(fs.readFileSync(file, 'utf8'));
        await setDescription(key, adf, o);
        out(`updated description of ${key}\n`);
        return 0;
      }
      default:
        err(`unknown command: ${args.command}\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    err(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).then((code) => process.exit(code));
}

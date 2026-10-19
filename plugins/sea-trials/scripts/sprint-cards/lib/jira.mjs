/**
 * Small Jira REST client on top of ../sprint/jira-rest.mjs.
 *
 *   - GETs retry on 429 (Retry-After), 5xx and network errors.
 *   - Writes retry only on 429. A 5xx or network error on a write is
 *     never blindly retried: the caller GETs first to see if the write
 *     landed (see push.mjs).
 *   - `JIRA_READ_ONLY=1` (or `readOnly: true`) makes every non-GET throw
 *     before it leaves the machine. Pull and resync always run read-only.
 */
import fs from 'node:fs';
import path from 'node:path';
import { attachFiles, requestJson } from '../../sprint/jira-rest.mjs';

let sleepImpl = (ms) => new Promise((r) => setTimeout(r, ms));
export function setClientSleep(fn) {
  const prev = sleepImpl;
  sleepImpl = fn;
  return prev;
}

export class WriteBlockedError extends Error {}

export function createClient(auth, o = {}) {
  const readOnly = Boolean(o.readOnly) || process.env.JIRA_READ_ONLY === '1';
  const calls = [];
  async function get(p, query) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        calls.push({ method: 'GET', path: p });
        return await requestJson('GET', p, { auth, query });
      } catch (err) {
        const network = err.status === undefined;
        if (network && attempt < 3) {
          await sleepImpl(500 * 2 ** attempt);
          continue;
        }
        throw err;
      }
    }
  }
  function guard(method, p) {
    if (readOnly) throw new WriteBlockedError(`read-only: refused ${method} ${p}`);
    calls.push({ method, path: p });
  }
  async function write(method, p, body, query) {
    guard(method, p);
    return requestJson(method, p, { auth, body, query, retry5xx: false });
  }
  async function attach(issueKey, file, name) {
    guard('POST', `/rest/api/3/issue/${issueKey}/attachments`);
    if (name && name !== path.basename(file)) {
      const tmpDir = fs.mkdtempSync(path.join(path.dirname(file), '.up-'));
      const tmp = path.join(tmpDir, name);
      fs.copyFileSync(file, tmp);
      try {
        return await attachFiles(issueKey, [tmp], { auth });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    }
    return attachFiles(issueKey, [file], { auth });
  }
  async function download(url) {
    calls.push({ method: 'GET', path: url });
    const res = await globalThis.fetch(url, { headers: { Authorization: auth.authorization }, redirect: 'follow' });
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
  /** POST /rest/api/3/search/jql, following nextPageToken. */
  async function search(jql, fields, max = 1000) {
    const out = [];
    let nextPageToken;
    for (let page = 0; page < 50 && out.length < max; page += 1) {
      calls.push({ method: 'POST(search)', path: '/rest/api/3/search/jql' });
      // Search is a read even though it is a POST.
      const r = await requestJson('POST', '/rest/api/3/search/jql', {
        auth,
        body: { jql, fields, maxResults: 100, ...(nextPageToken ? { nextPageToken } : {}) },
      });
      out.push(...(r?.issues ?? []));
      if (!r?.nextPageToken || r?.isLast) break;
      nextPageToken = r.nextPageToken;
    }
    return out;
  }
  return { get, write, attach, download, search, calls, readOnly, auth };
}

/** Find the per-site field ids for story points and sprint. */
export async function discoverFields(client, env = process.env) {
  const fields = (await client.get('/rest/api/3/field')) ?? [];
  const byName = (re) => fields.find((f) => re.test(f.name ?? ''));
  const sp = env.JIRA_STORY_POINTS_FIELD
    || byName(/^story point estimate$/i)?.id
    || byName(/^story points$/i)?.id
    || null;
  const sprint = env.JIRA_SPRINT_FIELD
    || fields.find((f) => f.schema?.custom === 'com.pyxis.greenhopper.jira:gh-sprint')?.id
    || byName(/^sprint$/i)?.id
    || null;
  return { storyPoints: sp, sprint };
}

/** Issue type ids by name for a project (Epic, Story, Bug, Sub-task...). */
export async function discoverIssueTypes(client, projectKey) {
  const p = await client.get(`/rest/api/3/project/${encodeURIComponent(projectKey)}`);
  const types = p?.issueTypes ?? [];
  const find = (pred) => types.find(pred);
  return {
    projectId: p?.id ?? null,
    all: types.map((t) => ({ id: t.id, name: t.name, subtask: Boolean(t.subtask), level: t.hierarchyLevel })),
    epic: find((t) => t.hierarchyLevel === 1) ?? find((t) => /^epic$/i.test(t.name)),
    story: find((t) => /^story$/i.test(t.name)),
    subtask: find((t) => t.subtask) ?? find((t) => /^sub-?task$/i.test(t.name)),
    byName: (name) => find((t) => t.name.toLowerCase() === String(name).toLowerCase()),
  };
}

/** Test helpers: a temp sprint folder and an in-memory fake Jira. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderCard } from '../lib/frontmatter.mjs';

export function tmpSprint() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sprint-cards-'));
  fs.mkdirSync(path.join(dir, 'compare'), { recursive: true });
  return dir;
}

export function writeCard(dir, rel, meta, body) {
  const p = path.join(dir, 'compare', rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, renderCard(meta, body));
  return p;
}

export const STORY_BODY = `As a user, I want a reset link so that I can sign in again.

## Context

The sign in page has no way back in after a lost password.

## Acceptance criteria

- [ ] Given a known email, when the user asks for a link, then an email is sent.
- [ ] Given an unknown email, when the user asks, then the page shows the same message.
- [ ] Given a used link, when it is opened again, then it shows that it expired.

## Out of scope

- Account recovery by phone.

## Dependencies

- None.
`;

export const SUBTASK_BODY = `## What and why

Add the reset route so the email link has somewhere to land.

## Where

- \`app/reset/page.tsx\`, new file

## How

Read the token from the query and post it.

\`\`\`ts
export default function Page() {
  return null;
}
\`\`\`

## Done when

- [ ] Given a valid token, when the page loads, then the form shows.
- [ ] \`npm test\` exits 0.
`;

export const EPIC_BODY = `## Goal

Users can get back into their account without help.

## Scope

In this epic:

- Reset by email.

## Stories

- User Story 1: Reset link by email
`;

export function meta(over) {
  return {
    local_id: null,
    jira_key: null,
    jira_id: null,
    parent_local_id: null,
    parent_jira_key: null,
    key: null,
    type: 'Story',
    parent: null,
    summary: 'x',
    status: 'To Do',
    status_category: 'new',
    story_points: 3,
    labels: [],
    sprint: null,
    attachments: [],
    order: 1,
    ...over,
  };
}

/**
 * Fake Jira. Records every request; `handlers` decide responses.
 * Default handlers cover fields, project, search and create.
 */
export function fakeJira(o = {}) {
  const calls = [];
  let n = o.startKey ?? 100;
  const issues = new Map(Object.entries(o.issues ?? {}));
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const method = init.method ?? 'GET';
    let body = null;
    if (typeof init.body === 'string') body = JSON.parse(init.body);
    calls.push({ method, path: u.pathname, body });
    const json = (code, data) => new Response(data === undefined ? '' : JSON.stringify(data), { status: code, headers: { 'content-type': 'application/json' } });
    const custom = o.handle?.({ method, path: u.pathname, body, url: u, calls });
    if (custom) return custom instanceof Response ? custom : json(custom.status ?? 200, custom.body);
    if (method === 'GET' && u.pathname === '/rest/api/3/field') return json(200, [{ id: 'customfield_10016', name: 'Story point estimate' }, { id: 'customfield_10020', name: 'Sprint', schema: { custom: 'com.pyxis.greenhopper.jira:gh-sprint' } }]);
    if (method === 'GET' && u.pathname.startsWith('/rest/api/3/project/')) return json(200, { id: '1', issueTypes: [{ id: '1', name: 'Epic', hierarchyLevel: 1 }, { id: '2', name: 'Story', hierarchyLevel: 0 }, { id: '3', name: 'Subtask', subtask: true, hierarchyLevel: -1 }] });
    if (method === 'POST' && u.pathname === '/rest/api/3/search/jql') {
      const keys = /key in \(([^)]*)\)/.exec(body.jql)?.[1]?.split(',') ?? [];
      return json(200, { issues: keys.map((k) => issues.get(k)).filter(Boolean), isLast: true });
    }
    if (method === 'POST' && u.pathname === '/rest/api/3/issue') {
      n += 1;
      const key = `PROJ-${n}`;
      issues.set(key, { id: String(n), key, fields: { ...body.fields, status: { name: 'To Do', statusCategory: { key: 'new' } } } });
      return json(201, { id: String(n), key });
    }
    if (method === 'GET' && /^\/rest\/api\/3\/issue\/[^/]+$/.test(u.pathname)) {
      const k = u.pathname.split('/').pop();
      const is = issues.get(k);
      return is ? json(200, is) : json(404, { errorMessages: ['not found'] });
    }
    return json(404, { errorMessages: [`fake: no handler for ${method} ${u.pathname}`] });
  };
  return { fetch, calls, issues };
}

export const AUTH = { site: 'https://example.atlassian.net', authorization: 'Basic ZmFrZTpmYWtl' };

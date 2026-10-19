import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setFetch } from '../../sprint/jira-rest.mjs';
import { assignIds } from '../lib/ids.mjs';
import { pull } from '../lib/pull.mjs';
import { serve, safeJoin } from '../lib/server.mjs';
import { bodyToAdf } from '../lib/push.mjs';
import { parseCard } from '../lib/frontmatter.mjs';
import { init, newCard } from '../lib/scaffold.mjs';
import { tmpSprint, writeCard, meta, fakeJira, AUTH, STORY_BODY, EPIC_BODY } from './helpers.mjs';

test('pull is GET only and writes the Jira copy next to the local card', async () => {
  const dir = tmpSprint();
  fs.writeFileSync(path.join(dir, 'compare/index.json'), JSON.stringify({ version: 2, jira: { project_key: 'PROJ' }, items: {} }));
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', jira_key: 'PROJ-1', story_points: null }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-a/story.local.md', meta({ summary: 'User Story 1: Reset', jira_key: 'PROJ-2' }), STORY_BODY);
  assignIds(dir);
  const issues = {
    'PROJ-1': { id: '1', key: 'PROJ-1', fields: { summary: 'E', issuetype: { name: 'Epic', hierarchyLevel: 1 }, status: { name: 'In Progress', statusCategory: { key: 'indeterminate' } }, labels: [], description: bodyToAdf(EPIC_BODY), attachment: [], updated: '2026-10-01T00:00:00.000+0000' } },
    'PROJ-2': { id: '2', key: 'PROJ-2', fields: { summary: 'User Story 1: Reset', issuetype: { name: 'Story', hierarchyLevel: 0 }, parent: { key: 'PROJ-1' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: [], customfield_10016: 3, description: bodyToAdf(STORY_BODY), attachment: [], updated: '2026-10-01T00:00:00.000+0000' } },
  };
  const fj = fakeJira({ issues });
  const prev = setFetch(fj.fetch);
  const prevGlobal = globalThis.fetch;
  globalThis.fetch = fj.fetch;
  try {
    const r = await pull(dir, { auth: AUTH });
    assert.equal(r.writes, 0);
    const writes = fj.calls.filter((c) => c.method !== 'GET' && c.path !== '/rest/api/3/search/jql');
    assert.deepEqual(writes, []);
    const jm = parseCard(fs.readFileSync(path.join(dir, 'compare/01-epic-a/01-story-a/story.jira.md'), 'utf8'));
    assert.equal(jm.meta.jira_key, 'PROJ-2');
    assert.equal(jm.meta.story_points, 3);
    assert.equal(jm.body.trim(), STORY_BODY.trim());
  } finally {
    setFetch(prev);
    globalThis.fetch = prevGlobal;
  }
});

test('safeJoin keeps paths inside the folder', () => {
  assert.equal(safeJoin('/a/b', '../etc/passwd'), null);
  assert.equal(safeJoin('/a/b', '%2e%2e/x'), null);
  assert.equal(safeJoin('/a/b', 'c/d.md'), '/a/b/c/d.md');
});

test('viewer server: manifest, files, traversal refused, reorder renumbers', async () => {
  const dir = tmpSprint();
  init(dir, { projectKey: 'PROJ', sprintName: 'Sprint 1' });
  const e = newCard(dir, 'epic', { title: 'Epic one' });
  newCard(dir, 'story', { title: 'First', parent: e.local_id });
  newCard(dir, 'story', { title: 'Second', parent: e.local_id });
  const s = await serve(dir, { port: 18766, log: () => {} });
  try {
    const mf = await (await fetch(`${s.url}api/manifest`)).json();
    assert.equal(mf.epics.length, 1);
    const stories = mf.epics[0].stories;
    assert.deepEqual(stories.map((x) => x.title), ['User Story 1: First', 'User Story 2: Second']);
    const html = await (await fetch(s.url)).text();
    assert.match(html, /sprint-title/);
    assert.equal((await fetch(`${s.url}api/file/..%2F..%2Fetc%2Fpasswd`)).status, 403);
    const f = await fetch(`${s.url}api/file/${stories[0].local_md}`);
    assert.equal(f.status, 200);
    const cross = await fetch(`${s.url}api/reorder`, { method: 'POST', headers: { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(cross.status, 403);
    const r = await (await fetch(`${s.url}api/reorder`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: 'story', ordered_ids: [stories[1].id, stories[0].id] }) })).json();
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.manifest.epics[0].stories.map((x) => x.title), ['User Story 1: Second', 'User Story 2: First']);
  } finally {
    await new Promise((res) => s.server.close(res));
  }
});

test('import-jira (MCP path) adopts an epic with its stories, parents first, and stamps jira_updated', async () => {
  const { importIssues } = await import('../lib/pull.mjs');
  const dir = tmpSprint();
  fs.writeFileSync(path.join(dir, 'compare/index.json'), JSON.stringify({ version: 2, jira: { project_key: 'PROJ' }, items: {} }));
  const list = [
    { id: '2', key: 'PROJ-2', fields: { summary: 'User Story 1: Reset', issuetype: { name: 'Story', hierarchyLevel: 0 }, parent: { key: 'PROJ-1' }, status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: [], description: STORY_BODY, updated: '2026-10-02T00:00:00.000+0000' } },
    { id: '1', key: 'PROJ-1', fields: { summary: 'E', issuetype: { name: 'Epic', hierarchyLevel: 1 }, status: { name: 'To Do', statusCategory: { key: 'new' } }, labels: [], description: EPIC_BODY, updated: '2026-10-01T00:00:00.000+0000' } },
  ];
  const r = importIssues(dir, list, {}, { adopt: true });
  assert.deepEqual(r.adopted, ['PROJ-1', 'PROJ-2']);
  assert.deepEqual(r.written.sort(), ['PROJ-1', 'PROJ-2']);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'compare/index.json'), 'utf8'));
  assert.equal(idx.items['loc-PROJ-2'].jira_updated, '2026-10-02T00:00:00.000+0000');
  assert.equal(idx.items['loc-PROJ-2'].parent_local_id, 'loc-PROJ-1');
  assert.equal(idx.items['loc-PROJ-2'].sync_status, 'in_sync');
});

test('retro metrics reads stories from a card folder', async () => {
  const { resolveSprint } = await import('../../sprint/retro-metrics.mjs');
  const dir = tmpSprint();
  init(dir, { projectKey: 'PROJ' });
  const e = newCard(dir, 'epic', { title: 'Epic one' });
  newCard(dir, 'story', { title: 'First', parent: e.local_id });
  const r = resolveSprint(dir);
  assert.equal(r.config.projectKey, 'PROJ');
  assert.equal(r.stories.length, 1);
  assert.equal(r.stories[0].title, 'User Story 1: First');
});

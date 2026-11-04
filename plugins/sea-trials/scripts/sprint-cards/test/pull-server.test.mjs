import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setFetch } from '../../sprint/jira-rest.mjs';
import { assignIds } from '../lib/ids.mjs';
import { pull } from '../lib/pull.mjs';
import { findViewer } from '../lib/viewer.mjs';
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

test('serve finds the sprint-plan-viewer submodule above the sprint folder', () => {
  const root = tmpSprint();
  fs.mkdirSync(path.join(root, '.git'));
  const sprint = path.join(root, 'sprint_planning', 'sprint-1');
  init(sprint, {});
  assert.equal(findViewer(sprint, { env: {} }), null);
  fs.mkdirSync(path.join(root, 'sprint_planning', 'sprint-plan-viewer'), { recursive: true });
  // An uninitialised submodule (empty folder) is not a viewer.
  assert.equal(findViewer(sprint, { env: {} }), null);
  fs.writeFileSync(path.join(root, 'sprint_planning', 'sprint-plan-viewer', 'spv.py'), '');
  const v = findViewer(sprint, { env: {} });
  assert.equal(v.dir, path.join(root, 'sprint_planning', 'sprint-plan-viewer'));
  assert.equal(v.spv.endsWith('spv.py'), true);
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

test('rankIssues keeps the order across chunks of 50', async () => {
  const { rankIssues } = await import('../../sprint/jira-rest.mjs');
  const sent = [];
  const prev = setFetch(async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  });
  try {
    const keys = Array.from({ length: 120 }, (_, i) => `PROJ-${i + 1}`);
    await rankIssues(keys, { after: 'PROJ-0', auth: AUTH });
    assert.deepEqual(sent.map((b) => b.rankAfterIssue), ['PROJ-0', 'PROJ-50', 'PROJ-100']);
    sent.length = 0;
    await rankIssues(keys, { before: 'PROJ-999', auth: AUTH });
    assert.deepEqual(sent.map((b) => [b.issues[0], b.rankBeforeIssue]), [['PROJ-1', 'PROJ-999'], ['PROJ-51', 'PROJ-999'], ['PROJ-101', 'PROJ-999']]);
  } finally {
    setFetch(prev);
  }
});

test('findViewer walks up past 8 levels to the git root', () => {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'viewer-deep-'));
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'sprint-plan-viewer'));
  fs.writeFileSync(path.join(root, 'sprint-plan-viewer', 'spv.py'), '');
  const deep = path.join(root, ...Array.from({ length: 11 }, (_, i) => `d${i}`));
  fs.mkdirSync(deep, { recursive: true });
  const v = findViewer(deep, { env: {} });
  assert.equal(v?.dir, path.join(root, 'sprint-plan-viewer'));
});

test('connect saves field ids for the MCP path and rejects bad ids', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'connect-')), 'sprint');
  init(dir, {});
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const r = spawnSync(process.execPath, [cli, 'connect', dir, '--story-points-field', 'customfield_10016', '--sprint-field', 'customfield_10020'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'compare/index.json'), 'utf8'));
  assert.deepEqual(idx.field_ids, { storyPoints: 'customfield_10016', sprint: 'customfield_10020' });
  const bad = spawnSync(process.execPath, [cli, 'connect', dir, '--sprint-field', 'x; rm -rf /'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

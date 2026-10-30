import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, renderCard } from '../lib/frontmatter.mjs';
import { loadTree } from '../lib/tree.mjs';
import { renumber, auditNumbering } from '../lib/numbering.mjs';
import { lintCard, lintViewerFormat } from '../lib/lint.mjs';
import { tmpSprint, writeCard, meta, STORY_BODY, SUBTASK_BODY, EPIC_BODY } from './helpers.mjs';

test('front matter round-trips byte for byte', () => {
  const text = renderCard(meta({ summary: 'User Story 1: Reset: by email', labels: ['web', 'auth'], jira_id: '10042', plan_number: 'S3' }), STORY_BODY);
  const { meta: m, body } = parseCard(text);
  assert.equal(m.summary, 'User Story 1: Reset: by email');
  assert.equal(m.jira_id, '10042');
  assert.deepEqual(m.labels, ['web', 'auth']);
  assert.equal(renderCard(m, body), text);
});

test('stories are numbered 1..n with no gaps; Done stories keep their title', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', local_id: 'loc-e' }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-a/story.local.md', meta({ summary: 'User Story 4: First', order: 1, local_id: 'loc-1' }), STORY_BODY);
  writeCard(dir, '01-epic-a/02-story-b/story.local.md', meta({ summary: 'Shipped thing', order: 2, status: 'Done', status_category: 'done', local_id: 'loc-2' }), STORY_BODY);
  writeCard(dir, '01-epic-a/03-story-c/story.local.md', meta({ summary: 'Third', order: 7, local_id: 'loc-3' }), STORY_BODY);
  const tree = loadTree(dir);
  renumber(tree);
  const s = tree.epics[0].children;
  assert.deepEqual(s.map((c) => c.meta.order), [1, 2, 3]);
  assert.equal(s[0].meta.summary, 'User Story 1: First');
  assert.equal(s[1].meta.summary, 'Shipped thing');
  assert.equal(s[2].meta.summary, 'User Story 3: Third');
  assert.equal(auditNumbering(tree).gaps.length, 0);
});

test('lint passes a good subtask and flags dashes, hedges and template text', () => {
  const ok = lintCard({ kind: 'subtask', meta: meta({ type: 'Sub-task', summary: 'Add the reset route', parent_local_id: 'loc-0a1b2c3d', local_id: 'loc-1a2b3c4d' }), body: SUBTASK_BODY, folder: '01-epic-LOCAL-e/01-story-LOCAL-s/subtasks/01-LOCAL-add-the-reset-route', hasLocal: true });
  assert.deepEqual(ok.filter((p) => p.severity !== 'warn'), []);
  const bad = lintCard({ kind: 'subtask', meta: meta({ type: 'Sub-task', summary: 'Maybe add it?' }), body: SUBTASK_BODY.replace('Add the reset route', 'Add the route \u2014 maybe [[FILL: x]]'), folder: 'x', hasLocal: true });
  const rules = new Set(bad.map((p) => p.rule));
  assert.ok(rules.has('rule-2'), 'dash');
  assert.ok(rules.has('placeholder'), 'template text');
  assert.ok([...rules].some((r) => r !== 'rule-2' && r !== 'placeholder'), 'hedge or question mark');
});

test('lint flags a story with too few checks', () => {
  const body = STORY_BODY.replace(/- \[ \] Given an unknown[^\n]*\n- \[ \] Given a used[^\n]*\n/, '');
  const p = lintCard({ kind: 'story', meta: meta({ summary: 'User Story 1: Reset' }), body, folder: 'x', hasLocal: true });
  assert.ok(p.some((x) => x.severity !== 'warn' && /check/i.test(x.message)), JSON.stringify(p));
});

test('the template cards ship with text the lint refuses', async () => {
  const { TEMPLATES } = await import('../lib/scaffold.mjs');
  for (const kind of ['epic', 'story', 'subtask']) {
    const p = lintCard({ kind, meta: meta({ summary: 'A title' }), body: TEMPLATES[kind], folder: 'x', hasLocal: true });
    assert.ok(p.some((x) => x.rule === 'placeholder'), kind);
  }
});

test('viewer format: folder names, LOCAL folders, alias keys, plan_number, title line, Jira copy', () => {
  const card = (over, folder, extra = {}) => ({ kind: 'story', meta: meta({ summary: 'User Story 1: Reset', plan_number: '1', jira_order: 1, ...over }), body: STORY_BODY, folder, hasLocal: true, jiraMeta: null, ...extra });
  const rules = (c) => lintViewerFormat(c).map((p) => `${p.rule}:${p.message}`);
  assert.deepEqual(rules(card({}, '01-epic-LOCAL-e/01-story-LOCAL-reset')), []);
  const keyed = { local_id: 'loc-PROJ-2', jira_key: 'PROJ-2', key: 'PROJ-2', parent_jira_key: 'PROJ-1', parent: 'PROJ-1' };
  assert.deepEqual(rules(card(keyed, '01-epic-PROJ-1-e/01-story-PROJ-2-reset', { jiraMeta: {} })), []);
  assert.ok(rules(card(keyed, '01-epic-PROJ-1-e/01-story-LOCAL-reset', { jiraMeta: {} })).some((r) => /contains LOCAL/.test(r)), 'key in LOCAL folder');
  assert.ok(rules(card(keyed, '01-epic-LOCAL-e/01-story-PROJ-2-reset', { jiraMeta: {} })).some((r) => /contains LOCAL/.test(r)), 'key under a LOCAL parent');
  assert.ok(rules(card(keyed, '01-epic-PROJ-1-e/01-story-PROJ-2-reset')).some((r) => r.startsWith('viewer-jira-copy')), 'missing jira.md');
  assert.ok(rules(card({ ...keyed, key: null }, '01-epic-PROJ-1-e/01-story-PROJ-2-reset', { jiraMeta: {} })).some((r) => /key must equal/.test(r)));
  assert.ok(rules(card({}, '01-epic-LOCAL-e/story-reset')).some((r) => /folder name/.test(r)));
  assert.ok(rules(card({ plan_number: '1.2' }, '01-epic-LOCAL-e/01-story-LOCAL-reset')).some((r) => /plan_number/.test(r)));
  assert.ok(rules(card({}, '01-epic-LOCAL-e/01-story-LOCAL-reset', { body: '# Reset\n\n' + STORY_BODY })).some((r) => /# Title/.test(r)));
  const noPlan = meta({}); delete noPlan.plan_number;
  assert.ok(lintViewerFormat({ kind: 'story', meta: noPlan, body: STORY_BODY, folder: '01-epic-LOCAL-e/01-story-LOCAL-reset', hasLocal: true, jiraMeta: null }).some((p) => /plan_number/.test(p.message) && p.severity === 'error'));
  const p = lintViewerFormat(card({}, '01-epic-LOCAL-e/01-story-LOCAL-reset', { meta: { summary: 'User Story 1: Reset', local_id: null, jira_key: null, key: null, type: 'Story', parent: null, parent_jira_key: null, order: 1, plan_number: '1', jira_order: 1 } }));
  assert.ok(p.some((x) => x.rule === 'viewer-order' && x.severity === 'warn'), 'key order is a warning');
});

test('folders renames LOCAL folders of keyed cards, children first, dry run by default', async () => {
  const { renameLocalFolders } = await import('../lib/folders.mjs');
  const dir = tmpSprint();
  writeCard(dir, '01-epic-LOCAL-e/epic.local.md', meta({ type: 'Epic', summary: 'E', local_id: 'loc-PROJ-1', jira_key: 'PROJ-1', key: 'PROJ-1', story_points: null }), EPIC_BODY);
  writeCard(dir, '01-epic-LOCAL-e/01-story-LOCAL-01-reset/story.local.md', meta({ summary: 'User Story 1: Reset', local_id: 'loc-PROJ-2', jira_key: 'PROJ-2', key: 'PROJ-2', parent_local_id: 'loc-PROJ-1' }), STORY_BODY);
  writeCard(dir, '01-epic-LOCAL-e/01-story-LOCAL-01-reset/subtasks/01-LOCAL-1.1-route/subtask.local.md', meta({ type: 'Sub-task', summary: 'Route', local_id: 'loc-0a1b2c3d', parent_local_id: 'loc-PROJ-2' }), SUBTASK_BODY);
  const dry = renameLocalFolders(dir);
  assert.deepEqual(dry.renames.map((r) => r.to), ['01-epic-LOCAL-e/01-story-PROJ-2-reset', '01-epic-PROJ-1-e']);
  assert.ok(fs.existsSync(path.join(dir, 'compare', '01-epic-LOCAL-e')), 'dry run renames nothing');
  renameLocalFolders(dir, { apply: true });
  const tree = loadTree(dir);
  assert.deepEqual(tree.all.map((c) => c.folder), ['01-epic-PROJ-1-e', '01-epic-PROJ-1-e/01-story-PROJ-2-reset', '01-epic-PROJ-1-e/01-story-PROJ-2-reset/subtasks/01-LOCAL-1.1-route']);
});

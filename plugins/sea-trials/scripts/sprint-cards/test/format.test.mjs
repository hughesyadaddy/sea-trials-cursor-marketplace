import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseCard, renderCard } from '../lib/frontmatter.mjs';
import { loadTree } from '../lib/tree.mjs';
import { renumber, auditNumbering } from '../lib/numbering.mjs';
import { lintCard } from '../lib/lint.mjs';
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
  const ok = lintCard({ kind: 'subtask', meta: meta({ type: 'Sub-task', summary: 'Add the reset route', parent_local_id: 'loc-0a1b2c3d', local_id: 'loc-1a2b3c4d' }), body: SUBTASK_BODY, folder: 'x', hasLocal: true });
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
  assert.ok(fs.existsSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '../viewer/index.html')));
});

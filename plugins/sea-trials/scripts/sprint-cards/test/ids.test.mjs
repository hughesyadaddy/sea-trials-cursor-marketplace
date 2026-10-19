import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assignIds } from '../lib/ids.mjs';
import { parseCard } from '../lib/frontmatter.mjs';
import { tmpSprint, writeCard, meta, STORY_BODY, EPIC_BODY } from './helpers.mjs';

const read = (dir, rel) => parseCard(fs.readFileSync(path.join(dir, 'compare', rel), 'utf8')).meta;

test('null keys stay null and keys are never guessed from folder names', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-PROJ-5-x/epic.local.md', meta({ type: 'Epic', summary: 'E' }), EPIC_BODY);
  writeCard(dir, '01-epic-PROJ-5-x/01-story-PROJ-6-y/story.local.md', meta({ summary: 'S' }), STORY_BODY);
  assignIds(dir);
  const e = read(dir, '01-epic-PROJ-5-x/epic.local.md');
  const s = read(dir, '01-epic-PROJ-5-x/01-story-PROJ-6-y/story.local.md');
  assert.equal(e.jira_key, null);
  assert.equal(s.jira_key, null);
  assert.match(e.local_id, /^loc-/);
  assert.equal(s.parent_local_id, e.local_id, 'parent comes from nesting');
});

test('an existing key is kept and parent links are not wiped', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', local_id: 'loc-e', jira_key: null }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-b/story.local.md', meta({ summary: 'S', local_id: 'loc-s', jira_key: 'PROJ-9', parent_jira_key: 'PROJ-1', parent: 'PROJ-1' }), STORY_BODY);
  const before = fs.readFileSync(path.join(dir, 'compare/01-epic-a/01-story-b/story.local.md'), 'utf8');
  assignIds(dir);
  const s = read(dir, '01-epic-a/01-story-b/story.local.md');
  assert.equal(s.jira_key, 'PROJ-9');
  assert.equal(s.local_id, 'loc-s');
  assert.equal(s.parent_local_id, 'loc-e');
  assert.equal(s.parent_jira_key, 'PROJ-1', 'parent key survives when the parent has no key yet');
  assert.notEqual(before, '');
  // Second run changes nothing.
  const r2 = assignIds(dir);
  assert.deepEqual(r2.changed, []);
});

test('a copied folder with a duplicate local_id gets a new one', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', local_id: 'loc-e' }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-b/story.local.md', meta({ summary: 'S1', local_id: 'loc-dup' }), STORY_BODY);
  writeCard(dir, '01-epic-a/02-story-c/story.local.md', meta({ summary: 'S2', local_id: 'loc-dup', order: 2 }), STORY_BODY);
  assignIds(dir);
  const a = read(dir, '01-epic-a/01-story-b/story.local.md');
  const b = read(dir, '01-epic-a/02-story-c/story.local.md');
  assert.equal(a.local_id, 'loc-dup');
  assert.notEqual(b.local_id, 'loc-dup');
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'compare/index.json'), 'utf8'));
  assert.equal(Object.keys(idx.items).length, 3);
});

test('index keeps the jira block', () => {
  const dir = tmpSprint();
  fs.writeFileSync(path.join(dir, 'compare/index.json'), JSON.stringify({ version: 2, jira: { project_key: 'PROJ', board_id: 7 }, items: {} }));
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E' }), EPIC_BODY);
  assignIds(dir);
  const idx = JSON.parse(fs.readFileSync(path.join(dir, 'compare/index.json'), 'utf8'));
  assert.deepEqual(idx.jira, { project_key: 'PROJ', board_id: 7 });
});

test('ids reports index rows whose folder is gone', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', local_id: 'loc-e' }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-b/story.local.md', meta({ summary: 'S', local_id: 'loc-s', jira_key: 'PROJ-9' }), STORY_BODY);
  assignIds(dir);
  fs.rmSync(path.join(dir, 'compare/01-epic-a/01-story-b'), { recursive: true });
  const r = assignIds(dir);
  assert.deepEqual(r.dropped.map((d) => d.jira_key), ['PROJ-9']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setFetch, setSleep } from '../../sprint/jira-rest.mjs';
import { assignIds } from '../lib/ids.mjs';
import { loadTree, readIndex } from '../lib/tree.mjs';
import { applyPush, mcpPlan, planPush, recordKey } from '../lib/push.mjs';
import { createClient, WriteBlockedError } from '../lib/jira.mjs';
import { parseCard } from '../lib/frontmatter.mjs';
import { tmpSprint, writeCard, meta, fakeJira, AUTH, STORY_BODY, SUBTASK_BODY, EPIC_BODY } from './helpers.mjs';

// These tests talk to an in-memory fake Jira only; the read-only switch
// would block the fake writes they check.
const savedReadOnly = process.env.JIRA_READ_ONLY;
delete process.env.JIRA_READ_ONLY;
test.after(() => {
  if (savedReadOnly !== undefined) process.env.JIRA_READ_ONLY = savedReadOnly;
});

function sprintWithNewCards() {
  const dir = tmpSprint();
  fs.writeFileSync(path.join(dir, 'compare/index.json'), JSON.stringify({ version: 2, jira: { project_key: 'PROJ', sprint_id: 10, sprint_name: 'Sprint 1' }, items: {} }));
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'Users can reset passwords', story_points: null }), EPIC_BODY);
  writeCard(dir, '01-epic-a/01-story-a/story.local.md', meta({ summary: 'User Story 1: Reset link by email', sprint: 'Sprint 1' }), STORY_BODY);
  writeCard(dir, '01-epic-a/01-story-a/subtasks/01-x/subtask.local.md', meta({ type: 'Sub-task', summary: 'Add the reset route', story_points: null }), SUBTASK_BODY);
  assignIds(dir);
  return dir;
}

test('plan creates parents first and is a dry run', () => {
  const dir = sprintWithNewCards();
  const plan = planPush(loadTree(dir), readIndex(dir));
  const creates = plan.ops.filter((o) => o.op === 'create');
  assert.deepEqual(creates.map((c) => c.kind), ['epic', 'story', 'subtask']);
  assert.equal(creates[1].sprint, 10);
});

test('Done cards are skipped and keep their Jira text', () => {
  const dir = tmpSprint();
  writeCard(dir, '01-epic-a/epic.local.md', meta({ type: 'Epic', summary: 'E', jira_key: 'PROJ-1' }), EPIC_BODY);
  writeCard(dir, '01-epic-a/epic.jira.md', meta({ type: 'Epic', summary: 'E', jira_key: 'PROJ-1', status: 'Done', status_category: 'done' }), 'old text\n');
  assignIds(dir);
  const plan = planPush(loadTree(dir), readIndex(dir));
  assert.equal(plan.ops.length, 0);
  assert.equal(plan.skipped.length, 1);
});

test('apply creates in order, writes keys back, links children', async () => {
  const dir = sprintWithNewCards();
  const fj = fakeJira();
  const prev = setFetch(fj.fetch);
  const prevSleep = setSleep(async () => {});
  try {
    const plan = planPush(loadTree(dir), readIndex(dir), { only: ['create'] });
    const r = await applyPush(dir, plan, { auth: AUTH, sleep: async () => {} });
    assert.deepEqual(r.failed, []);
    assert.equal(r.created.length, 3);
    const posts = fj.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue');
    assert.equal(posts.length, 3);
    assert.equal(posts[1].body.fields.parent.key, 'PROJ-101');
    assert.equal(posts[2].body.fields.parent.key, 'PROJ-102');
    assert.equal(posts[1].body.fields.customfield_10016, 3);
    // The ADF sent never puts a paragraph inside a taskItem.
    assert.doesNotMatch(JSON.stringify(posts[2].body.fields.description), /"taskItem","attrs":\{[^}]*\},"content":\[\{"type":"paragraph"/);
    const st = parseCard(fs.readFileSync(path.join(dir, 'compare/01-epic-a/01-story-a/subtasks/01-x/subtask.local.md'), 'utf8')).meta;
    assert.equal(st.jira_key, 'PROJ-103');
    assert.equal(st.parent_jira_key, 'PROJ-102');
    // No key leaks into the log.
    const logs = fs.readdirSync(dir).filter((f) => f.startsWith('PUSH-LOG-'));
    assert.equal(logs.length, 1);
    assert.doesNotMatch(fs.readFileSync(path.join(dir, logs[0]), 'utf8'), /ZmFrZTpmYWtl/);
  } finally {
    setFetch(prev);
    setSleep(prevSleep);
  }
});

test('a 5xx on create is not retried blindly: it searches and adopts the issue that landed', async () => {
  const dir = sprintWithNewCards();
  let landed = null;
  const fj = fakeJira({
    handle: ({ method, path: p, body }) => {
      if (method === 'POST' && p === '/rest/api/3/issue' && body.fields.issuetype.id === '1') {
        landed = { id: '555', key: 'PROJ-555', fields: { summary: body.fields.summary } };
        return { status: 502, body: { errorMessages: ['bad gateway'] } };
      }
      if (method === 'POST' && p === '/rest/api/3/search/jql' && /summary ~/.test(body.jql)) return { body: { issues: landed ? [landed] : [], isLast: true } };
      return null;
    },
  });
  const prev = setFetch(fj.fetch);
  try {
    const plan = planPush(loadTree(dir), readIndex(dir), { only: ['create'], keys: [loadTree(dir).epics[0].meta.local_id] });
    const r = await applyPush(dir, plan, { auth: AUTH, sleep: async () => {} });
    const epicPosts = fj.calls.filter((c) => c.method === 'POST' && c.path === '/rest/api/3/issue');
    assert.equal(epicPosts.length, 1, 'no second create');
    assert.equal(r.created[0].key, 'PROJ-555');
  } finally {
    setFetch(prev);
  }
});

test('read-only client refuses writes before they leave the machine', async () => {
  const fj = fakeJira();
  const prev = setFetch(fj.fetch);
  try {
    const c = createClient(AUTH, { readOnly: true });
    await assert.rejects(() => c.write('PUT', '/rest/api/3/issue/PROJ-1', { fields: {} }), WriteBlockedError);
    await assert.rejects(() => c.attach('PROJ-1', '/nonexistent'), WriteBlockedError);
    assert.equal(fj.calls.length, 0);
  } finally {
    setFetch(prev);
  }
});

test('JIRA_READ_ONLY=1 blocks apply writes too', async () => {
  const dir = sprintWithNewCards();
  const fj = fakeJira();
  const prev = setFetch(fj.fetch);
  process.env.JIRA_READ_ONLY = '1';
  try {
    const plan = planPush(loadTree(dir), readIndex(dir), { only: ['create'] });
    const r = await applyPush(dir, plan, { auth: AUTH, sleep: async () => {} });
    assert.ok(r.failed.length >= 1);
    assert.equal(fj.calls.filter((c) => c.method !== 'GET' && c.path !== '/rest/api/3/search/jql').length, 0);
  } finally {
    delete process.env.JIRA_READ_ONLY;
    setFetch(prev);
  }
});

test('recordKey refuses to overwrite a different key', () => {
  const dir = sprintWithNewCards();
  const e = loadTree(dir).epics[0];
  recordKey(dir, e.meta.local_id, 'PROJ-7');
  assert.throws(() => recordKey(dir, e.meta.local_id, 'PROJ-8'), /refusing/);
  const s = loadTree(dir).epics[0].children[0];
  assert.equal(s.meta.parent_jira_key, 'PROJ-7');
});

test('MCP plan: parents first, precheck before create, user-key-only ops marked', () => {
  const dir = sprintWithNewCards();
  fs.mkdirSync(path.join(dir, 'compare/01-epic-a/01-story-a/images/local'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'compare/01-epic-a/01-story-a/images/local/shot.png'), 'png');
  fs.writeFileSync(path.join(dir, 'compare/01-epic-a/01-story-a/images/manifest.json'), JSON.stringify([{ filename: 'shot.png', status: 'staged', path: 'images/local/shot.png' }]));
  const tree = loadTree(dir);
  const mp = mcpPlan(planPush(tree, readIndex(dir)), tree, readIndex(dir));
  const creates = mp.steps.filter((s) => s.tool === 'createJiraIssue');
  assert.equal(creates.length, 1, 'only the epic: children wait for its key');
  assert.ok(mp.deferred_creates >= 2);
  assert.match(creates[0].precheck.arguments.jql, /summary/);
  assert.equal(creates[0].arguments.contentFormat, 'adf');
  assert.ok(mp.steps.some((s) => s.needs === 'user-key'));
});

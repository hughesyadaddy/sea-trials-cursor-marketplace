import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { init, newCard } from '../lib/scaffold.mjs';
import { readIndex } from '../lib/tree.mjs';
import { resolveUserKey } from '../lib/auth.mjs';
import { viewerArgs } from '../lib/viewer.mjs';

const CLI = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const TOKEN = 'ATATTfakeViewerTOKEN42';

// A planning repo with a fake sprint-plan-viewer that logs its argv and whether it got a key.
function planningRepo() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'spv-'));
  fs.mkdirSync(path.join(root, '.git'));
  const vdir = path.join(root, 'sprint-plan-viewer');
  fs.mkdirSync(vdir);
  const log = path.join(root, 'viewer-calls.jsonl');
  fs.writeFileSync(path.join(vdir, 'spv.py'), `import json, os, sys\nwith open(${JSON.stringify(log)}, 'a') as f:\n    f.write(json.dumps({'argv': sys.argv[1:], 'cwd': os.getcwd(), 'has_key': bool(os.environ.get('JIRA_API_TOKEN'))}) + '\\n')\n`);
  const sprint = path.join(root, 's1');
  init(sprint, { projectKey: 'PROJ', site: 'https://example-site.atlassian.net', sprintId: 5, sprintName: 'Sprint 5' });
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { root, sprint, calls };
}

function run(args, env = {}) {
  const e = { ...process.env, ...env };
  for (const k of ['JIRA_READ_ONLY', 'JIRA_EMAIL', 'JIRA_API_TOKEN', 'JIRA_SITE', 'JIRA_CREDS_FILE', 'SPRINT_PLAN_VIEWER']) if (!(k in env)) delete e[k];
  e.HOME = env.HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  e.SPRINT_CARDS_NO_KEYCHAIN = '1';
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: e });
}

const KEY = { JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: TOKEN };

test('init and connect mirror the Jira settings into plan.json for the viewer', () => {
  const { sprint } = planningRepo();
  const r = run(['connect', sprint, '--board', '3', '--story-points-field', 'customfield_10016']);
  assert.equal(r.status, 0, r.stderr);
  const pj = JSON.parse(fs.readFileSync(path.join(sprint, 'plan.json'), 'utf8'));
  assert.deepEqual(pj.jira, { site: 'https://example-site.atlassian.net', project: 'PROJ', board_id: 3, sprint_id: 5, sprint_name: 'Sprint 5', story_points_field: 'customfield_10016' });
});

test('readIndex fills missing Jira settings from plan.json (folders made by the viewer)', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pj-')), 's');
  fs.mkdirSync(path.join(dir, 'compare'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'compare/index.json'), JSON.stringify({ version: 2, items: {} }));
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ jira: { site: 'https://x.atlassian.net', project: 'ABC', sprint_id: 9, sprint_field: 'customfield_10020' } }));
  const idx = readIndex(dir);
  assert.equal(idx.jira.project_key, 'ABC');
  assert.equal(idx.jira.sprint_id, 9);
  assert.equal(idx.field_ids.sprint, 'customfield_10020');
});

test('serve runs spv.py serve --plan <abs sprint dir> from the folder that holds the viewer', () => {
  const { root, sprint, calls } = planningRepo();
  const r = run(['serve', sprint, '--port', '8770', '--strict-port']);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls();
  assert.deepEqual(c.argv, ['serve', '--plan', sprint, '--port', '8770', '--strict-port']);
  assert.equal(fs.realpathSync(c.cwd), root);
});

test('serve without the viewer exits 3 with the submodule command', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nov-')), 's');
  fs.mkdirSync(path.join(dir, '..', '.git'));
  init(dir, {});
  const r = run(['serve', dir]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /git submodule add https:\/\/github\.com\/hughesyadaddy\/sprint-plan-viewer\.git sprint-plan-viewer/);
});

test('pull with the viewer present runs its GET-only resync, with the key in the child env only', () => {
  const { sprint, calls } = planningRepo();
  const r = run(['pull', sprint], KEY);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls();
  assert.deepEqual(c.argv, ['resync', '--plan', sprint, '--images']);
  assert.equal(c.has_key, true);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
});

test('push --apply with the viewer sends creates through spv.py push and is refused under JIRA_READ_ONLY', () => {
  const { sprint, calls } = planningRepo();
  const epic = newCard(sprint, 'epic', { title: 'Epic A' });
  const dry = run(['push', sprint, '--skip-lint'], KEY);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /spv\.py push --plan .* --apply --create loc-/);
  assert.equal(calls().length, 0, 'a dry run never starts the viewer');
  const ro = run(['push', sprint, '--apply', '--skip-lint'], { ...KEY, JIRA_READ_ONLY: '1' });
  assert.equal(ro.status, 2);
  assert.equal(calls().length, 0);
  const ap = run(['push', sprint, '--apply', '--skip-lint'], KEY);
  assert.equal(ap.status, 0, ap.stderr + ap.stdout);
  const [c] = calls();
  assert.equal(c.argv[0], 'push');
  assert.ok(c.argv.includes('--apply') && c.argv.includes('--create'));
  assert.ok(c.argv[c.argv.indexOf('--create') + 1].includes(epic.meta?.local_id ?? 'loc-'));
  assert.doesNotMatch(ap.stdout + ap.stderr, new RegExp(TOKEN));
});

test('viewer passthrough keeps spv flags as given', () => {
  const { sprint, calls } = planningRepo();
  const r = run(['viewer', 'resync', sprint, '--dry'], KEY);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(calls()[0].argv, ['resync', '--plan', sprint, '--dry']);
  assert.equal(run(['viewer', 'rm', sprint]).status, 2);
});

test('the key handed to a viewer child never shows in JSON', () => {
  const k = resolveUserKey({ env: KEY, home: os.tmpdir(), keychain: () => null, site: 'https://x.atlassian.net' });
  assert.equal(k.childEnv.JIRA_API_TOKEN, TOKEN);
  assert.doesNotMatch(JSON.stringify(k), new RegExp(TOKEN));
  assert.deepEqual(viewerArgs({ spv: '/v/spv.py' }, 'check', '/p/s'), ['/v/spv.py', 'check', '--plan', path.resolve('/p/s')]);
});

test('a creds file bound to another site is refused before the viewer starts', () => {
  const { sprint, calls } = planningRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  fs.writeFileSync(path.join(home, '.jira-creds'), `JIRA_EMAIL=dev@example.com\nJIRA_API_TOKEN=${TOKEN}\nJIRA_SITE=https://other-site.atlassian.net\n`);
  const r = run(['pull', sprint], { HOME: home });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /other-site\.atlassian\.net/);
  assert.equal(calls().length, 0);
  assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
});

test('viewer commands that do not talk to Jira get no key in their env', () => {
  const { sprint, calls } = planningRepo();
  const json = path.join(sprint, 'issues.json');
  fs.writeFileSync(json, '{"issues": []}');
  assert.equal(run(['viewer', 'config', sprint], KEY).status, 0);
  assert.equal(run(['viewer', 'push', sprint], KEY).status, 0);
  assert.equal(run(['import-jira', sprint, json], KEY).status, 0);
  const c = calls();
  assert.deepEqual(c.map((x) => [x.argv[0], x.has_key]), [['config', false], ['push', false], ['import-jira', false]]);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { maskEmail, parseCredsText, redact, resolveUserKey } from '../lib/auth.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const TOKEN = 'ATATT3xFAKEtokenVALUE1234567890';
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sc-home-'));

test('no key: ok false so callers use the MCP path', () => {
  const r = resolveUserKey({ env: {}, home: home(), keychain: () => null });
  assert.equal(r.ok, false);
});

test('env key wins and needs a site', () => {
  const env = { JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: TOKEN };
  assert.equal(resolveUserKey({ env, home: home(), keychain: () => null }).ok, false);
  const r = resolveUserKey({ env: { ...env, JIRA_SITE: 'example.atlassian.net' }, home: home(), keychain: () => null });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'env');
  assert.equal(r.site, 'https://example.atlassian.net');
  assert.equal(r.auth.authorization, `Basic ${Buffer.from(`dev@example.com:${TOKEN}`).toString('base64')}`);
});

test('creds file as KEY=VALUE or JSON (the old reader only took JSON)', () => {
  assert.deepEqual(parseCredsText(`# c\nexport JIRA_EMAIL="dev@example.com"\nJIRA_API_TOKEN=${TOKEN}\nJIRA_SITE=https://example.atlassian.net\n`).JIRA_EMAIL, 'dev@example.com');
  assert.equal(parseCredsText(JSON.stringify({ JIRA_API_TOKEN: TOKEN })).JIRA_API_TOKEN, TOKEN);
  const h = home();
  fs.writeFileSync(path.join(h, '.jira-creds'), `JIRA_EMAIL=dev@example.com\nJIRA_API_TOKEN=${TOKEN}\nJIRA_SITE=example.atlassian.net\n`);
  const r = resolveUserKey({ env: {}, home: h, keychain: () => null });
  assert.equal(r.ok, true);
  assert.match(r.source, /^file:/);
});

test('redact and maskEmail hide secrets', () => {
  const auth = { authorization: `Basic ${Buffer.from(`a@b.c:${TOKEN}`).toString('base64')}` };
  const s = redact(`token ${TOKEN} header ${auth.authorization}`, { auth, token: TOKEN });
  assert.doesNotMatch(s, new RegExp(TOKEN));
  assert.doesNotMatch(s, /QGIu/);
  assert.equal(maskEmail('dev@example.com').includes('dev@'), false);
});

test('auth status never prints the token, in text or JSON', () => {
  const env = { ...process.env, HOME: home(), JIRA_EMAIL: 'dev@example.com', JIRA_API_TOKEN: TOKEN, JIRA_SITE: 'example.atlassian.net' };
  for (const args of [['auth', 'status'], ['auth', 'status', '--json']]) {
    const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(TOKEN));
    assert.doesNotMatch(r.stdout + r.stderr, /Basic /);
    assert.match(r.stdout, /user.key/i);
  }
});

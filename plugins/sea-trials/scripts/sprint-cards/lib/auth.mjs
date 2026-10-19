/**
 * The optional user key: an Atlassian API token (email + token) that
 * the CLI uses for direct REST calls. Without it the skills use the
 * Atlassian MCP server (OAuth sign-in) instead; see
 * references/shared/jira-connection.md.
 *
 * Sources, first match wins:
 *   1. env `JIRA_EMAIL` + `JIRA_API_TOKEN`
 *      (aliases `ATLASSIAN_EMAIL` + `ATLASSIAN_API_TOKEN`)
 *   2. OS keychain, service `sprint-cards-jira`
 *      (macOS `security`, Linux `secret-tool`); `auth login` stores it
 *   3. `~/.jira-creds` (or `$JIRA_CREDS_FILE`): `KEY=VALUE` lines,
 *      optional `export ` and quotes. JSON with the same keys also works.
 *
 * The site comes from `--site`, env `JIRA_SITE`, the creds file, or the
 * sprint folder's `index.json` (`jira.site`). The token is never printed,
 * logged or written anywhere by this tool.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KEYCHAIN_SERVICE = 'sprint-cards-jira';

/** Parse a creds file: KEY=VALUE lines or a JSON object. */
export function parseCredsText(text) {
  const out = {};
  const t = String(text ?? '').trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t);
      for (const [k, v] of Object.entries(j)) if (typeof v === 'string') out[k] = v;
      return out;
    } catch {
      // fall through to KEY=VALUE
    }
  }
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

export function normalizeSite(site) {
  if (!site) return null;
  let s = String(site).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(s)) s = `https://${s}`;
  return s;
}

function run(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    return r.status === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}

/** Read email + token from the OS keychain, or null. */
export function readKeychain(platform = process.platform, runner = run) {
  if (platform === 'darwin') {
    const attrs = runner('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE]);
    if (!attrs) return null;
    const acct = /"acct"<blob>="([^"]*)"/.exec(attrs)?.[1];
    const token = runner('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'])?.trim();
    return acct && token ? { email: acct, token } : null;
  }
  if (platform === 'linux') {
    const found = runner('secret-tool', ['search', '--all', 'service', KEYCHAIN_SERVICE]);
    if (!found) return null;
    const email = /attribute\.account = (.+)/.exec(found)?.[1]?.trim();
    const token = runner('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE])?.trim();
    return email && token ? { email, token } : null;
  }
  return null;
}

/**
 * Find the user key. Never throws; returns `{ ok: false, ... }` when
 * there is none so callers can fall back to the MCP path.
 *
 * @param {{ env?: object, site?: string|null, indexSite?: string|null,
 *   home?: string, keychain?: () => ({email: string, token: string}|null) }} [o]
 */
export function resolveUserKey(o = {}) {
  const env = o.env ?? process.env;
  const home = o.home ?? os.homedir();
  let email = env.JIRA_EMAIL || env.ATLASSIAN_EMAIL || null;
  let token = env.JIRA_API_TOKEN || env.ATLASSIAN_API_TOKEN || null;
  let source = email && token ? 'env' : null;
  let fileSite = null;
  if (!source) {
    const kc = (o.keychain ?? (() => readKeychain()))();
    if (kc) {
      ({ email, token } = kc);
      source = 'keychain';
    }
  }
  const credsPath = env.JIRA_CREDS_FILE || path.join(home, '.jira-creds');
  if (fs.existsSync(credsPath)) {
    try {
      const c = parseCredsText(fs.readFileSync(credsPath, 'utf8'));
      fileSite = c.JIRA_SITE || c.JIRA_BASE_URL || c.JIRA_URL || null;
      if (!source && (c.JIRA_EMAIL || c.email) && (c.JIRA_API_TOKEN || c.token)) {
        email = c.JIRA_EMAIL || c.email;
        token = c.JIRA_API_TOKEN || c.token;
        source = `file:${credsPath.replace(home, '~')}`;
      }
    } catch {
      // unreadable file: ignore
    }
  }
  const site = normalizeSite(o.site || env.JIRA_SITE || o.indexSite || fileSite);
  if (!source) return { ok: false, reason: 'no user key (env, keychain or ~/.jira-creds)', site };
  if (!site) return { ok: false, reason: 'user key found but no site; pass --site or set JIRA_SITE', source, site: null };
  const basic = Buffer.from(`${email}:${token}`, 'utf8').toString('base64');
  return {
    ok: true,
    source,
    site,
    email,
    auth: { site, authorization: `Basic ${basic}` },
  };
}

/** a***@example.com */
export function maskEmail(email) {
  if (!email) return null;
  const [u, d] = String(email).split('@');
  return `${u.slice(0, 1)}***${d ? `@${d}` : ''}`;
}

/** Remove anything that looks like the token or the Basic header from text. */
export function redact(text, key) {
  let s = String(text ?? '');
  if (key?.auth?.authorization) s = s.split(key.auth.authorization).join('Basic [redacted]');
  const b64 = key?.auth?.authorization?.slice(6);
  if (b64) s = s.split(b64).join('[redacted]');
  return s.replace(/(ATATT|ATCTT)[A-Za-z0-9_\-=]{8,}/g, '[redacted]');
}

/**
 * Store the key in the OS keychain. The token is typed by the user into
 * the keychain tool's own prompt, so it never passes through this process.
 */
export function keychainLogin(email, platform = process.platform) {
  if (platform === 'darwin') {
    const r = spawnSync('security', ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', email, '-w'], { stdio: 'inherit' });
    return r.status === 0;
  }
  if (platform === 'linux') {
    const r = spawnSync('secret-tool', ['store', '--label', 'Jira API token (sprint-cards)', 'service', KEYCHAIN_SERVICE, 'account', email], { stdio: 'inherit' });
    return r.status === 0;
  }
  return false;
}

export function keychainLogout(platform = process.platform) {
  if (platform === 'darwin') return spawnSync('security', ['delete-generic-password', '-s', KEYCHAIN_SERVICE], { stdio: 'ignore' }).status === 0;
  if (platform === 'linux') return spawnSync('secret-tool', ['clear', 'service', KEYCHAIN_SERVICE], { stdio: 'ignore' }).status === 0;
  return false;
}

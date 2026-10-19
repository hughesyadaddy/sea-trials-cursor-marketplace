/**
 * Local viewer server. Binds 127.0.0.1 only. Serves viewer/ and the
 * sprint's compare/ files, rebuilds the manifest on every request, and
 * saves drag-reorder into the cards. "Pull from Jira" runs the GET-only
 * pull when a user key is set; it never writes to Jira.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCard, renderCard } from './frontmatter.mjs';
import { buildManifest } from './manifest.mjs';
import { renumber } from './numbering.mjs';
import { cardsRoot, loadTree, readIndex, writeJson, writeText } from './tree.mjs';
import { assignIds } from './ids.mjs';
import { resolveUserKey } from './auth.mjs';
import { pull } from './pull.mjs';

const VIEWER_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'viewer');
const HOST = '127.0.0.1';
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

export async function findFreePort(start) {
  for (let p = start; p < start + 40; p += 1) {
    const free = await new Promise((resolve) => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(p, HOST, () => s.close(() => resolve(true)));
    });
    if (free) return p;
  }
  throw new Error('no free port');
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(buf);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Resolve `rel` inside `base`, or null when it escapes. */
export function safeJoin(base, rel) {
  const clean = decodeURIComponent(rel).replace(/^\/+/, '');
  if (clean.split('/').includes('..')) return null;
  const abs = path.resolve(base, clean);
  const b = path.resolve(base);
  return abs === b || abs.startsWith(b + path.sep) ? abs : null;
}

function diffStatReport(mf) {
  const items = [];
  let tp = 0;
  let tm = 0;
  const walk = (it) => {
    const st = it.diff_stat ?? { plus: 0, minus: 0 };
    if (it.change_kind && it.change_kind !== 'unchanged') {
      items.push({ key: it.jira_key, kind: it.kind, plus: st.plus, minus: st.minus, folder: it.folder });
      tp += st.plus;
      tm += st.minus;
    }
  };
  for (const e of mf.epics) {
    walk(e);
    for (const s of e.stories) {
      walk(s);
      s.subtasks.forEach(walk);
    }
  }
  return { total_plus: tp, total_minus: tm, items, structural: [], field_change_count: 0 };
}

/** Apply a drag-reorder: set `order` on each sibling, then renumber. */
export function applyReorder(dir, orderedIds) {
  const tree = loadTree(dir);
  const pos = new Map(orderedIds.map((id, i) => [id, i + 1]));
  const touched = [];
  for (const c of tree.all) {
    const n = pos.get(c.folder) ?? pos.get(c.meta.local_id);
    if (n === undefined || !c.hasLocal) continue;
    c.meta.order = n;
    c.meta._order_custom = true;
    touched.push(c);
  }
  if (!touched.length) throw new Error('none of ordered_ids matched a card');
  const changed = new Set([...touched.map((c) => c.folder), ...renumber(tree)]);
  for (const c of tree.all) {
    if (!changed.has(c.folder) || !c.hasLocal) continue;
    const { body } = parseCard(fs.readFileSync(c.localPath, 'utf8'));
    writeText(c.localPath, renderCard(c.meta, body));
  }
  assignIds(dir);
  return [...changed];
}

/**
 * @param {string} dir sprint dir
 * @param {{ port?: number, log?: (s: string) => void }} [o]
 */
export async function serve(dir, o = {}) {
  const root = cardsRoot(dir);
  if (!fs.existsSync(root)) throw new Error(`no compare/ folder in ${dir}; run init first`);
  const stateFile = path.join(root, '.state', 'ui.json');
  const log = o.log ?? ((s) => process.stderr.write(`${s}\n`));
  let pulling = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const p = url.pathname;
    try {
      // Only this machine, by name: blocks DNS rebinding (Host) and
      // cross-site writes (Origin, and a JSON body that a plain HTML
      // form cannot send without a CORS preflight we never answer).
      const host = String(req.headers.host ?? '');
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(res, 403, { error: 'unexpected Host header' });
      if (req.method === 'POST') {
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return send(res, 403, { error: 'cross-origin request refused' });
        const fetchSite = req.headers['sec-fetch-site'];
        if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return send(res, 403, { error: 'cross-site request refused' });
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return send(res, 415, { error: 'POST needs Content-Type: application/json' });
      }
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return send(res, 200, fs.readFileSync(path.join(VIEWER_DIR, 'index.html')), TYPES['.html']);
      if (req.method === 'GET' && p === '/api/manifest') {
        const mf = buildManifest(dir);
        writeJson(path.join(root, 'manifest.json'), mf);
        return send(res, 200, mf);
      }
      if (req.method === 'GET' && p === '/api/diff-stat') return send(res, 200, diffStatReport(buildManifest(dir)));
      if (req.method === 'GET' && p === '/api/numbering-audit') {
        const mf = buildManifest(dir);
        return send(res, 200, { markdown: '', audit: mf.numbering_audit });
      }
      if (req.method === 'GET' && p === '/api/done-reconcile') return send(res, 404, { error: 'not used' });
      if (req.method === 'GET' && p === '/api/state') {
        try {
          return send(res, 200, JSON.parse(fs.readFileSync(stateFile, 'utf8')));
        } catch {
          return send(res, 200, { reviewed: {}, notes: {} });
        }
      }
      if (req.method === 'GET' && (p.startsWith('/api/file/') || p.startsWith('/compare/'))) {
        const rel = p.startsWith('/api/file/') ? p.slice('/api/file/'.length) : p.slice('/compare/'.length);
        const abs = safeJoin(root, rel);
        if (!abs) return send(res, 403, { error: 'path escapes the sprint folder' });
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return send(res, 404, { error: 'not found' });
        return send(res, 200, fs.readFileSync(abs), TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream');
      }
      if (req.method === 'POST' && p === '/api/state') {
        const data = JSON.parse((await readBody(req)) || '{}');
        writeJson(stateFile, data);
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && p === '/api/reorder') {
        const data = JSON.parse((await readBody(req)) || '{}');
        if (!Array.isArray(data.ordered_ids) || !data.ordered_ids.length) return send(res, 400, { error: 'ordered_ids required' });
        applyReorder(dir, data.ordered_ids.map(String));
        const mf = buildManifest(dir);
        writeJson(path.join(root, 'manifest.json'), mf);
        return send(res, 200, { ok: true, manifest: mf });
      }
      if (req.method === 'POST' && (p === '/api/refresh')) return send(res, 200, buildManifest(dir));
      if (req.method === 'POST' && p === '/api/pull') {
        const key = resolveUserKey({ indexSite: readIndex(dir)?.jira?.site });
        if (!key.ok) return send(res, 409, { ok: false, error: `${key.reason}. Without a user key, ask the agent to resync through the Atlassian MCP (import-jira).` });
        if (pulling) return send(res, 409, { ok: false, error: 'a pull is already running' });
        pulling = true;
        try {
          const r = await pull(dir, { auth: key.auth });
          return send(res, 200, { ok: true, log_tail: JSON.stringify({ ...r, unmatched_jira: r.unmatched_jira.length }), manifest: buildManifest(dir) });
        } finally {
          pulling = false;
        }
      }
      if (req.method === 'GET') {
        const abs = safeJoin(VIEWER_DIR, p);
        if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) return send(res, 200, fs.readFileSync(abs), TYPES[path.extname(abs)] ?? 'application/octet-stream');
      }
      return send(res, 404, { error: 'not found' });
    } catch (err) {
      log(`viewer error: ${String(err.message).slice(0, 300)}`);
      return send(res, 500, { ok: false, error: String(err.message).slice(0, 300) });
    }
  });
  const port = await findFreePort(o.port ?? Number(process.env.SPRINT_VIEWER_PORT || 8766));
  await new Promise((resolve) => server.listen(port, HOST, resolve));
  return { server, port, url: `http://${HOST}:${port}/` };
}

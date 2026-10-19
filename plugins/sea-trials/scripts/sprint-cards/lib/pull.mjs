/**
 * GET-only resync: refresh every `*.jira.md` copy, the snapshot and the
 * Jira images from Jira. Never edits a `*.local.md` file, except with
 * `adopt`, which creates local cards for Jira issues that have none yet
 * (the local text starts as a copy of Jira). The client is always
 * read-only here, so a bug cannot write to Jira.
 *
 * `importIssue` does the same for one issue JSON that an agent fetched
 * through the Atlassian MCP (`getJiraIssue`), for users without a key.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { renderCard } from './frontmatter.mjs';
import { issueToCard, slugify } from './convert.mjs';
import { assignIds, contentHash } from './ids.mjs';
import { buildManifest } from './manifest.mjs';
import { cardsRoot, loadTree, readIndex, sprintDir, writeJson, writeText } from './tree.mjs';
import { createClient, discoverFields } from './jira.mjs';

const ISSUE_FIELDS = ['summary', 'status', 'issuetype', 'parent', 'labels', 'description', 'attachment', 'updated', 'project'];

function stamp(d = new Date()) {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readJson(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
}

function safeName(n) {
  return String(n).replace(/[/\\:*?"<>|\0]/g, '_').slice(0, 120);
}

/**
 * Write the Jira copy of one card and merge its Jira images into the
 * card's images/manifest.json.
 */
export async function writeJiraCopy(card, issue, fieldIds, o) {
  const atts = issue.fields?.attachment ?? [];
  const mfPath = path.join(card.folderAbs, 'images', 'manifest.json');
  const entries = readJson(mfPath, []);
  const jiraAtts = [];
  for (const a of atts) {
    if (!/^image\//.test(a.mimeType ?? '') && !/\.(png|jpe?g|gif|webp|svg)$/i.test(a.filename ?? '')) continue;
    const rel = `images/jira/${a.id}_${safeName(a.filename)}`;
    const abs = path.join(card.folderAbs, rel);
    let hash = entries.find((e) => String(e.jira_attachment_id) === String(a.id))?.sha256 ?? null;
    if ((!fs.existsSync(abs) || !hash) && o.client && o.images !== false) {
      try {
        const buf = await o.client.download(a.content);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, buf);
        hash = sha(buf);
      } catch (err) {
        o.log?.({ kind: 'image_download_failed', key: issue.key, file: a.filename, reason: String(err.message).slice(0, 200) });
      }
    } else if (fs.existsSync(abs) && !hash) hash = sha(fs.readFileSync(abs));
    if (!hash) continue;
    jiraAtts.push({ filename: a.filename, sha256: hash });
    const staged = entries.find((e) => e.sha256 === hash && e.status !== 'in_jira');
    const existing = entries.find((e) => String(e.jira_attachment_id) === String(a.id));
    if (existing) Object.assign(existing, { filename: a.filename, sha256: hash, status: 'in_jira', path: rel });
    else if (staged) Object.assign(staged, { jira_attachment_id: String(a.id), status: 'in_jira', jira_path: rel });
    else entries.push({ filename: a.filename, sha256: hash, jira_attachment_id: String(a.id), status: 'in_jira', path: rel });
  }
  // Attachment ids that are no longer on the issue.
  const live = new Set(atts.map((a) => String(a.id)));
  for (const e of entries) {
    if (e.status === 'in_jira' && e.jira_attachment_id && !live.has(String(e.jira_attachment_id))) e.status = 'removed_in_jira';
  }
  if (entries.length) writeJson(mfPath, entries);
  const { meta, body, updated } = issueToCard(issue, fieldIds, { sprintId: o.sprintId, attachments: jiraAtts });
  meta.local_id = card.meta.local_id ?? `loc-${issue.key}`;
  meta.parent_local_id = card.meta.parent_local_id ?? null;
  const text = renderCard(meta, body);
  writeText(card.jiraPath, text);
  return { meta, body, updated };
}

function nextSeq(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir)) {
      const m = /^(\d+)-/.exec(e);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // empty
  }
  return String(n + 1).padStart(2, '0');
}

/** Folder for a Jira issue that has no local card yet, or null when its parent is missing. */
function adoptFolder(root, issue, byKey) {
  const t = (issue.fields?.issuetype?.name ?? '').toLowerCase();
  const isSub = Boolean(issue.fields?.issuetype?.subtask) || /sub-?task/.test(t);
  const isEpic = (issue.fields?.issuetype?.hierarchyLevel ?? null) === 1 || t === 'epic';
  const slug = slugify(issue.fields?.summary);
  if (isEpic) return { kind: 'epic', dir: path.join(root, `${nextSeq(root)}-epic-${issue.key}-${slug}`) };
  const parent = byKey.get(issue.fields?.parent?.key);
  if (!parent) return null;
  if (isSub) {
    if (parent.kind !== 'story') return null;
    const sd = path.join(parent.folderAbs, 'subtasks');
    return { kind: 'subtask', dir: path.join(sd, `${nextSeq(sd)}-${issue.key}-${slug}`) };
  }
  if (parent.kind !== 'epic') return null;
  return { kind: 'story', dir: path.join(parent.folderAbs, `${nextSeq(parent.folderAbs)}-story-${issue.key}-${slug}`) };
}

/**
 * @param {string} dir sprint dir
 * @param {{ auth: object, epics?: string[], adopt?: boolean, images?: boolean,
 *   log?: (e: object) => void, now?: Date }} o
 */
export async function pull(dir, o) {
  const root = cardsRoot(dir);
  const sdir = sprintDir(dir);
  const client = o.client ?? createClient(o.auth, { readOnly: true });
  const index = readIndex(dir) ?? { version: 2, jira: {}, items: {} };
  const jira = index.jira ?? {};
  const fieldIds = await discoverFields(client);
  const fields = [...ISSUE_FIELDS, ...(fieldIds.storyPoints ? [fieldIds.storyPoints] : []), ...(fieldIds.sprint ? [fieldIds.sprint] : [])];
  let tree = loadTree(dir);
  const keys = new Set(tree.all.map((c) => c.meta.jira_key).filter(Boolean));
  const jqls = [];
  for (const chunkStart of [...Array(Math.ceil(keys.size / 80)).keys()]) {
    const ks = [...keys].slice(chunkStart * 80, chunkStart * 80 + 80);
    jqls.push(`key in (${ks.join(',')})`);
  }
  if (jira.sprint_id) jqls.push(`sprint = ${Number(jira.sprint_id)}`);
  for (const e of o.epics ?? []) {
    if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(e)) throw new Error(`bad epic key ${e}`);
    jqls.push(`key = ${e} OR parent = ${e}`);
  }
  const issues = new Map();
  for (const jql of jqls) for (const it of await client.search(jql, fields)) issues.set(it.key, it);
  // Subtasks of every story we know about.
  const storyKeys = [...issues.values()].filter((i) => !i.fields?.issuetype?.subtask && (i.fields?.issuetype?.hierarchyLevel ?? 0) === 0).map((i) => i.key);
  for (let i = 0; i < storyKeys.length; i += 80) {
    const ks = storyKeys.slice(i, i + 80);
    if (ks.length) for (const it of await client.search(`parent in (${ks.join(',')})`, fields)) issues.set(it.key, it);
  }
  const snapDir = path.join(sdir, `jira-snapshot-${stamp(o.now)}`);
  const report = { fetched: issues.size, updated_copies: 0, adopted: [], unmatched_jira: [], missing_in_jira: [] };
  if (o.adopt) {
    report.adopted = adoptIssues(dir, [...issues.values()], fieldIds, jira);
    for (const k of report.adopted) keys.add(k);
    tree = loadTree(dir);
  }
  const items = index.items ?? {};
  for (const card of tree.all) {
    const key = card.meta.jira_key;
    if (!key) continue;
    const issue = issues.get(key);
    if (!issue) {
      report.missing_in_jira.push(key);
      continue;
    }
    fs.mkdirSync(path.join(snapDir, 'raw'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'raw', `${key}.json`), `${JSON.stringify(issue, null, 1)}\n`);
    const { meta, body, updated } = await writeJiraCopy(card, issue, fieldIds, { client, sprintId: jira.sprint_id, images: o.images, log: o.log });
    fs.mkdirSync(path.join(snapDir, 'md'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'md', `${key}.md`), renderCard(meta, body));
    const lid = card.meta.local_id ?? `loc-${key}`;
    items[lid] = { ...(items[lid] ?? {}), jira_updated: updated, content_hash_at_pull: contentHash(meta, body) };
    report.updated_copies += 1;
  }
  for (const [k, it] of issues) {
    if (!keys.has(k)) report.unmatched_jira.push({ key: k, summary: it.fields?.summary ?? '', type: it.fields?.issuetype?.name ?? null, parent: it.fields?.parent?.key ?? null });
  }
  index.items = items;
  index.pulled_at = (o.now ?? new Date()).toISOString();
  index.unmatched_jira = report.unmatched_jira;
  index.field_ids = fieldIds;
  writeJson(path.join(root, 'index.json'), index);
  assignIds(dir);
  writeJson(path.join(root, 'manifest.json'), buildManifest(dir));
  return { ...report, calls: client.calls.length, writes: client.calls.filter((c) => !['GET', 'POST(search)'].includes(c.method)).length };
}

/**
 * Make local cards for issues that have none, parents first (epics,
 * then stories, then subtasks). The local text starts as the Jira text.
 * Returns the adopted keys.
 */
export function adoptIssues(dir, list, fieldIds, jira = {}) {
  const root = cardsRoot(dir);
  const level = (i) => ((i.fields?.issuetype?.hierarchyLevel ?? 0) === 1 || /^epic$/i.test(i.fields?.issuetype?.name ?? '') ? 0 : i.fields?.issuetype?.subtask ? 2 : 1);
  const have = new Set(loadTree(dir).all.map((c) => c.meta.jira_key).filter(Boolean));
  const pending = list.filter((i) => i?.key && !have.has(i.key)).sort((a, b) => level(a) - level(b));
  const adopted = [];
  for (const issue of pending) {
    const byKey = new Map(loadTree(dir).all.filter((c) => c.meta.jira_key).map((c) => [c.meta.jira_key, c]));
    const spot = adoptFolder(root, issue, byKey);
    if (!spot) continue;
    const { meta, body } = issueToCard(issue, fieldIds, { sprintId: jira.sprint_id });
    meta.local_id = `loc-${issue.key}`;
    meta.parent_local_id = byKey.get(meta.parent_jira_key)?.meta.local_id ?? null;
    writeText(path.join(spot.dir, `${spot.kind}.local.md`), renderCard(meta, body));
    adopted.push(issue.key);
  }
  return adopted;
}

/**
 * Import one issue JSON fetched through MCP. `file` holds the issue
 * (`{ key, id, fields }`) or `{ issues: [...] }`.
 */
export function importIssues(dir, json, fieldIds = {}, o = {}) {
  const index = readIndex(dir) ?? { jira: {} };
  const list = (Array.isArray(json?.issues) ? json.issues : Array.isArray(json) ? json : [json]).filter((i) => i && i.key && i.fields);
  const ids0 = { ...(index.field_ids ?? {}), ...Object.fromEntries(Object.entries(fieldIds).filter(([, v]) => v)) };
  const adopted = o.adopt ? adoptIssues(dir, list, ids0, index.jira ?? {}) : [];
  const tree = loadTree(dir);
  const byKey = new Map(tree.all.filter((c) => c.meta.jira_key).map((c) => [c.meta.jira_key, c]));
  const out = { written: [], unmatched: [], adopted };
  const ids = ids0;
  const stamps = {};
  for (const issue of list) {
    const card = byKey.get(issue.key);
    if (!card) {
      out.unmatched.push(issue.key);
      continue;
    }
    const { meta, body } = issueToCard(issue, ids, { sprintId: index.jira?.sprint_id, attachments: card.jiraMeta?.attachments ?? [] });
    meta.local_id = card.meta.local_id;
    meta.parent_local_id = card.meta.parent_local_id ?? null;
    writeText(card.jiraPath, renderCard(meta, body));
    stamps[card.meta.local_id] = { jira_updated: issue.fields.updated ?? null, content_hash_at_pull: contentHash(meta, body) };
    out.written.push(issue.key);
  }
  if (out.written.length) {
    const fresh = readIndex(dir) ?? index;
    fresh.items = fresh.items ?? {};
    for (const [lid, st] of Object.entries(stamps)) fresh.items[lid] = { ...(fresh.items[lid] ?? {}), ...st };
    if (Object.keys(fieldIds).some((k) => fieldIds[k])) fresh.field_ids = ids;
    writeJson(path.join(cardsRoot(dir), 'index.json'), fresh);
  }
  assignIds(dir);
  writeJson(path.join(cardsRoot(dir), 'manifest.json'), buildManifest(dir));
  return out;
}

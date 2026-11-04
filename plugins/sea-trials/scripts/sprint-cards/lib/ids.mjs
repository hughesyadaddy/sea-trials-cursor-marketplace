/**
 * Stable identity for every card, and `compare/index.json`.
 *
 * Rules (each one fixes a bug in the older Python `assign_ids.py`):
 *   - `local_id` never changes once set. A new card gets `loc-<KEY>` when
 *     it already has a Jira key, else `loc-<8 hex>`.
 *   - A non-null `jira_key` / `jira_id` is never overwritten or cleared.
 *     A null key is never guessed from the folder name.
 *   - The parent link comes from the folder nesting (story in epic,
 *     subtask in story). `parent_local_id` is always the parent card's
 *     `local_id`, so a parent that is not in Jira yet keeps its link.
 *     `parent_jira_key` is the parent's key when it has one, else the
 *     value already in the file, else null. It is never wiped.
 *   - `key` and `parent` mirror `jira_key` and `parent_jira_key`.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { renderCard, normalizeBody } from './frontmatter.mjs';
import { cardsRoot, loadTree, readIndex, writeJson, writeText } from './tree.mjs';

export const TYPE_BY_KIND = { epic: 'Epic', story: 'Story', subtask: 'Sub-task' };

/** @param {unknown} v */
export function cleanKey(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || s === '-' || s === '—' || s.toLowerCase() === 'null') return null;
  return s;
}

export function newLocalId(jiraKey, rand = () => crypto.randomBytes(4).toString('hex')) {
  return jiraKey ? `loc-${jiraKey}` : `loc-${rand()}`;
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** Hash of the parts of a card that are pushed to Jira. */
export function contentHash(meta, body) {
  const pick = {
    summary: meta.summary ?? null,
    type: meta.type ?? null,
    parent: meta.parent_jira_key ?? null,
    labels: [...(meta.labels ?? [])].map(String).sort(),
    story_points: meta.story_points ?? null,
    status: meta.status ?? null,
  };
  return sha256(`${JSON.stringify(pick)}\n${normalizeBody(body)}`);
}

/**
 * Pure step: work out the identity fields of every card.
 *
 * @param {import('./tree.mjs').Card[]} cards in tree order (parents first)
 * @param {{ rand?: () => string }} [o]
 * @returns {Map<import('./tree.mjs').Card, Record<string, any>>} new meta per card
 */
export function computeIds(cards, o = {}) {
  const out = new Map();
  const used = new Set();
  for (const c of cards) {
    const m = { ...c.meta };
    const jiraKey = cleanKey(m.jira_key) ?? cleanKey(m.key) ?? cleanKey(c.jiraMeta?.jira_key) ?? cleanKey(c.jiraMeta?.key);
    let localId = cleanKey(m.local_id);
    if (localId && used.has(localId)) localId = null; // copied folder: give it a new id
    if (!localId) {
      localId = newLocalId(jiraKey && !used.has(`loc-${jiraKey}`) ? jiraKey : null, o.rand);
      while (used.has(localId)) localId = newLocalId(null, o.rand);
    }
    used.add(localId);
    const jiraId = cleanKey(m.jira_id) ?? cleanKey(c.jiraMeta?.jira_id);
    m.local_id = localId;
    m.jira_key = jiraKey;
    m.jira_id = jiraId === null ? null : String(jiraId);
    if (c.parentCard) {
      const pm = out.get(c.parentCard) ?? c.parentCard.meta;
      m.parent_local_id = pm.local_id;
      m.parent_jira_key = cleanKey(pm.jira_key) ?? cleanKey(m.parent_jira_key) ?? cleanKey(m.parent);
    } else {
      m.parent_local_id = null;
      m.parent_jira_key = cleanKey(m.parent_jira_key) ?? cleanKey(m.parent);
    }
    m.key = m.jira_key;
    m.parent = m.parent_jira_key;
    if (!m.type) m.type = TYPE_BY_KIND[c.kind];
    if (!Array.isArray(m.labels)) m.labels = m.labels ? [String(m.labels)] : [];
    if (!Array.isArray(m.attachments)) m.attachments = [];
    out.set(c, m);
  }
  return out;
}

/**
 * Assign ids on disk and rebuild `index.json`. Keeps the `jira` block
 * (site, project, board, sprint) that the index already holds.
 *
 * @param {string} dir sprint or cards dir
 * @param {{ dryRun?: boolean, now?: () => string, rand?: () => string }} [o]
 */
export function assignIds(dir, o = {}) {
  const tree = loadTree(dir);
  const ids = computeIds(tree.all, o);
  const changed = [];
  for (const c of tree.all) {
    const m = ids.get(c);
    if (!c.hasLocal) continue;
    const before = renderCard(c.meta, c.body);
    const after = renderCard(m, c.body);
    if (before !== after) {
      changed.push(c.folder);
      if (!o.dryRun) writeText(c.localPath, after);
    }
    c.meta = m;
  }
  const prevItems = readIndex(dir)?.items ?? {};
  const index = buildIndex(dir, tree, o);
  // Index rows whose card folder is gone (moved out, deleted by hand).
  const dropped = Object.keys(prevItems).filter((k) => !index.items[k]).map((k) => ({ local_id: k, jira_key: prevItems[k]?.jira_key ?? null, folder: prevItems[k]?.folder ?? null }));
  if (!o.dryRun) writeJson(path.join(cardsRoot(dir), 'index.json'), index);
  return { changed, index, dropped };
}

/** Build index.json from a loaded tree (cards must already carry ids). */
export function buildIndex(dir, tree, o = {}) {
  const prev = readIndex(dir) ?? {};
  const now = (o.now ?? (() => new Date().toISOString()))();
  const items = {};
  let withKey = 0;
  for (const c of tree.all) {
    const m = c.meta;
    const old = prev.items?.[m.local_id] ?? {};
    const localHash = contentHash(m, c.body);
    const jiraHash = c.jiraMeta ? contentHash(c.jiraMeta, c.jiraBody ?? '') : null;
    const atPull = old.content_hash_at_pull ?? jiraHash;
    let sync = 'unknown';
    if (!m.jira_key) sync = 'local_only';
    else if (jiraHash && localHash === jiraHash) sync = 'in_sync';
    else if (jiraHash && atPull && jiraHash === atPull) sync = 'local_edited';
    else if (jiraHash && atPull && localHash === atPull) sync = 'jira_edited';
    else if (jiraHash) sync = 'conflict';
    if (m.jira_key) withKey += 1;
    items[m.local_id] = {
      jira_key: m.jira_key,
      jira_id: m.jira_id,
      folder: c.folder,
      kind: c.kind,
      summary: m.summary ?? null,
      parent_local_id: m.parent_local_id,
      parent_jira_key: m.parent_jira_key,
      jira_updated: old.jira_updated ?? null,
      content_hash_at_pull: atPull ?? null,
      local_content_hash: localHash,
      jira_content_hash: jiraHash,
      sync_status: sync,
    };
  }
  return {
    version: 2,
    jira: prev.jira ?? {},
    pulled_at: prev.pulled_at ?? null,
    assigned_at: now,
    items,
    counts: { with_jira_key: withKey, null_jira_key: tree.all.length - withKey, total: tree.all.length },
  };
}

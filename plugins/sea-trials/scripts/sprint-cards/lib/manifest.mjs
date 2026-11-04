/**
 * Build `compare/manifest.json`, the data the viewer reads. Everything
 * comes from the files on disk (cards, Jira copies, image manifests and
 * index.json); nothing here talks to Jira.
 */
import fs from 'node:fs';
import path from 'node:path';
import { unifiedDiff, diffStat } from './diff.mjs';
import { auditNumbering } from './numbering.mjs';
import { bySiblingOrder, cardsRoot, loadTree, readIndex } from './tree.mjs';
import { normalizeBody } from './frontmatter.mjs';

const IMG_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function normPoints(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normLabels(v) {
  return [...(Array.isArray(v) ? v : [])].map(String).sort();
}

/** Field-level differences, Jira (old) to local (new). */
export function fieldChanges(jm, lm) {
  if (!jm) return [];
  const out = [];
  const cmp = [
    ['summary', (x) => String(x ?? '').trim() || null],
    ['story_points', normPoints],
    ['labels', normLabels],
    ['status', (x) => x || null],
    ['parent', (x) => x || null],
    ['type', (x) => x || null],
    ['sprint', (x) => x || null],
  ];
  for (const [f, norm] of cmp) {
    const field = f === 'parent' ? 'parent_jira_key' : f;
    const a = norm(jm[field] ?? (f === 'parent' ? jm.parent : undefined));
    const b = norm(lm[field] ?? (f === 'parent' ? lm.parent : undefined));
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ field: f, old: a, new: b });
  }
  return out;
}

function listImages(root, card, side) {
  const byName = new Map();
  for (const e of card.images ?? []) {
    if (e?.filename) byName.set(e.filename, e);
    if (e?.path) byName.set(e.path, e);
  }
  const dirs = side === 'local' ? ['local', 'staged'] : ['jira'];
  const out = [];
  for (const d of dirs) {
    const abs = path.join(card.folderAbs, 'images', d);
    let names = [];
    try {
      names = fs.readdirSync(abs).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (!IMG_EXT.has(path.extname(n).toLowerCase())) continue;
      const rel = path.relative(root, path.join(abs, n)).split(path.sep).join('/');
      const relInCard = `images/${d}/${n}`;
      const ent = byName.get(n) ?? byName.get(relInCard) ?? {};
      out.push({
        path: rel,
        name: n,
        duplicate: false,
        status: ent.status ?? (d === 'staged' ? 'staged' : d === 'jira' ? 'in_jira' : 'local'),
        jira_attachment_id: ent.jira_attachment_id ?? null,
        sha256: ent.sha256 ?? null,
      });
    }
  }
  return out;
}

function isDone(meta) {
  return String(meta?.status_category ?? '').toLowerCase() === 'done'
    || ['done', 'closed', 'resolved'].includes(String(meta?.status ?? '').toLowerCase());
}

function itemFor(root, card, sprintName) {
  const lm = card.meta;
  const jm = card.jiraMeta;
  const lb = card.hasLocal ? normalizeBody(card.body) : '';
  const jb = card.jiraBody !== null ? normalizeBody(card.jiraBody) : '';
  const udiff = jm ? unifiedDiff(jb, lb, 'jira/description', 'local/description') : '';
  const stat = jm ? diffStat(udiff) : { plus: lb ? lb.split('\n').length - 1 : 0, minus: 0 };
  const fields = fieldChanges(jm, lm);
  let changeKind = 'unchanged';
  if (!jm && card.hasLocal) changeKind = 'added';
  else if (jm && !card.hasLocal) changeKind = 'removed';
  else if (udiff || fields.length) changeKind = 'modified';
  const key = lm.jira_key ?? null;
  const done = isDone(jm ?? lm);
  const inSprint = Boolean(key) && Boolean(sprintName) && (jm?.sprint ?? lm.sprint) === sprintName;
  const order = Number.isInteger(lm.order) ? lm.order : null;
  const jiraOrder = Number.isInteger(lm.jira_order) ? lm.jira_order : null;
  const title = lm.summary ?? jm?.summary ?? card.folder;
  const self = changeKind === 'unchanged' ? 'green' : 'red';
  return {
    id: card.folder,
    key,
    jira_key: key,
    local_id: lm.local_id ?? null,
    folder: card.folder,
    title,
    kind: card.kind,
    type: lm.type ?? null,
    section: card.kind === 'epic' ? (lm.plan_number ?? null) : undefined,
    status: (jm ?? lm).status ?? null,
    status_category: (jm ?? lm).status_category ?? null,
    done,
    done_sources: done ? ['jira'] : [],
    done_mismatch: [],
    story_points: lm.story_points ?? null,
    labels: lm.labels ?? [],
    sprint: lm.sprint ?? null,
    in_active_sprint: inSprint,
    sprint_pill: inSprint ? sprintName : null,
    differs: changeKind !== 'unchanged',
    match_dot: self,
    self_dot: self,
    diff_stat: stat,
    live_stat: { plus: stat.plus, minus: stat.minus, kind: changeKind === 'unchanged' ? 'same' : changeKind },
    field_changes: fields,
    unified_diff: udiff,
    change_kind: changeKind,
    order,
    plan_number: lm.plan_number ?? null,
    jira_order: jiraOrder,
    order_changed: order !== null && jiraOrder !== null && order !== jiraOrder,
    local_md: `${card.folder}/${card.kind}.local.md`,
    jira_md: `${card.folder}/${card.kind}.jira.md`,
    local_images: listImages(root, card, 'local'),
    jira_images: listImages(root, card, 'jira'),
    nav_label: key ? `${key}: ${title}` : title,
  };
}

function rollup(items) {
  const total = items.length;
  const green = items.filter((x) => x.self_dot === 'green').length;
  return { green, red: total - green, total };
}

/**
 * @param {string} dir sprint or cards dir
 * @param {{ now?: () => string }} [o]
 */
export function buildManifest(dir, o = {}) {
  const root = cardsRoot(dir);
  const tree = loadTree(dir);
  const index = readIndex(dir) ?? {};
  const jira = index.jira ?? {};
  const sprintName = jira.sprint_name ?? null;
  const counts = { epics: 0, stories: 0, subtasks: 0, with_jira_key: 0, local_only: 0, done_items: 0, images: 0 };
  const change = { added: 0, modified: 0, removed: 0, unchanged: 0 };
  const shaSeen = new Map();
  const dupImages = [];
  const tally = (it) => {
    change[it.change_kind] += 1;
    if (it.jira_key) counts.with_jira_key += 1;
    else counts.local_only += 1;
    if (it.done) counts.done_items += 1;
    for (const im of [...it.local_images, ...it.jira_images]) {
      counts.images += 1;
      if (!im.sha256) continue;
      const prev = shaSeen.get(im.sha256);
      if (prev && prev.split('/images/')[0] !== im.path.split('/images/')[0]) dupImages.push([prev, im.path]);
      else shaSeen.set(im.sha256, im.path);
    }
  };
  const epics = [...tree.epics].sort(bySiblingOrder).map((e) => {
    const ei = itemFor(root, e, sprintName);
    counts.epics += 1;
    tally(ei);
    ei.stories = [...e.children].sort(bySiblingOrder).map((s) => {
      const si = itemFor(root, s, sprintName);
      counts.stories += 1;
      tally(si);
      si.subtasks = [...s.children].sort(bySiblingOrder).map((t) => {
        const ti = itemFor(root, t, sprintName);
        counts.subtasks += 1;
        tally(ti);
        return ti;
      });
      si.rollup = rollup(si.subtasks.length ? si.subtasks : [si]);
      si.rollup_dot = si.rollup.red ? 'red' : 'green';
      si.child_changed = si.subtasks.some((t) => t.change_kind !== 'unchanged');
      return si;
    });
    ei.rollup = rollup(ei.stories.length ? ei.stories : [ei]);
    ei.rollup_dot = ei.rollup.red || ei.stories.some((s) => s.rollup_dot === 'red') ? 'red' : 'green';
    ei.child_changed = ei.stories.some((s) => s.change_kind !== 'unchanged' || s.child_changed);
    // Sprint badge: share of non-Done children with a key that are in the sprint.
    let inCount = 0;
    let total = 0;
    for (const s of ei.stories) {
      for (const it of [s, ...s.subtasks]) {
        if (!it.jira_key || it.done) continue;
        total += 1;
        if (it.in_active_sprint) inCount += 1;
      }
    }
    ei.sprint_in_count = inCount;
    ei.sprint_total_count = total;
    ei.sprint_badge = total && inCount === total ? 'green' : inCount ? 'yellow' : null;
    ei.sprint_badge_title = total ? `${inCount} of ${total} in sprint` : 'No non-Done children';
    return ei;
  });
  if (dupImages.length) {
    const dups = new Set(dupImages.flat());
    for (const e of epics) {
      for (const it of [e, ...e.stories, ...e.stories.flatMap((s) => s.subtasks)]) {
        for (const im of [...it.local_images, ...it.jira_images]) if (dups.has(im.path)) im.duplicate = true;
      }
    }
  }
  const unmatchedLocal = tree.unmatched.map((n) => ({
    id: `_unmatched_local/${n}`,
    folder: `_unmatched_local/${n}`,
    title: n,
    kind: 'item',
    change_kind: 'added',
    local_md: `_unmatched_local/${n}/item.local.md`,
    jira_md: null,
    local_images: [],
    jira_images: [],
    nav_label: n,
  }));
  return {
    format: 'sprint-cards-v1',
    title: jira.sprint_name || path.basename(path.dirname(root)),
    generated_at: (o.now ?? (() => new Date().toISOString()))(),
    pulled_at: index.pulled_at ?? null,
    sprint_id: jira.sprint_id ?? null,
    active_sprint: sprintName ? { id: jira.sprint_id ?? null, name: sprintName, state: jira.sprint_state ?? null } : null,
    jira: { site: jira.site ?? null, project_key: jira.project_key ?? null, board_id: jira.board_id ?? null },
    epics,
    counts,
    change_counts: change,
    duplicate_images: dupImages,
    numbering_audit: auditNumbering(tree),
    unmatched_local: unmatchedLocal,
    unmatched_jira: index.unmatched_jira ?? [],
  };
}

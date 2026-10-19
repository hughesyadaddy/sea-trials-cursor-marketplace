/**
 * Push the local cards to Jira.
 *
 * `planPush` is pure: it compares every local card with its Jira copy
 * (`*.jira.md`, refreshed by `pull`) and lists the operations, in the
 * order they must run:
 *
 *   1. create   cards with `jira_key: null`, parents first
 *   2. update   summary, description, labels, story points, parent
 *   3. transition  when `status` differs
 *   4. upload   staged images whose sha256 is not on the issue yet
 *   5. sprint   move into the tracked sprint (`index.json` jira.sprint_id)
 *   6. rank     siblings in local `order` (viewer drag-reorder)
 *
 * Cards that are Done in Jira are skipped (they keep their Jira text).
 *
 * `applyPush` runs a plan with the user key (direct REST): creates are
 * idempotent (search before create, and search again after an unclear
 * error), new keys are written back to the card at once, updates GET the
 * live issue first (Done at write time is skipped, the old fields are
 * backed up), 429s back off, and every touched issue is read back.
 *
 * `mcpPlan` turns a plan into Atlassian MCP tool calls for users without
 * a key, and marks the steps that need the key.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { markdownToAdf, validateAdf } from '../../sprint/md-to-adf.mjs';
import { normalizeBody, parseCard, renderCard } from './frontmatter.mjs';
import { descriptionToBody } from './convert.mjs';
import { assignIds, cleanKey } from './ids.mjs';
import { buildManifest } from './manifest.mjs';
import { bySiblingOrder, cardsRoot, loadTree, readIndex, sprintDir, writeJson, writeText } from './tree.mjs';
import { createClient, discoverFields, discoverIssueTypes } from './jira.mjs';
import { writeJiraCopy } from './pull.mjs';
import { redact } from './auth.mjs';

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp)$/i;

function isDoneMeta(m) {
  return String(m?.status_category ?? '').toLowerCase() === 'done';
}

function labelsOf(m) {
  return [...(Array.isArray(m?.labels) ? m.labels : [])].map(String).sort();
}

function pointsOf(m) {
  const v = m?.story_points;
  return v === null || v === undefined || v === '' ? null : Number(v);
}

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/** Staged images of a card that are not in Jira yet. */
export function stagedImages(card) {
  const entries = Array.isArray(card.images) ? card.images : [];
  const inJira = new Set(entries.filter((e) => e.status === 'in_jira').map((e) => e.sha256));
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (e.status !== 'staged' || !e.path) continue;
    const abs = path.join(card.folderAbs, e.path);
    if (!fs.existsSync(abs)) continue;
    const sha = e.sha256 || sha256File(abs);
    if (inJira.has(sha) || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ file: e.path, filename: e.filename || path.basename(abs), sha256: sha });
  }
  // Files dropped into images/staged/ without a manifest entry.
  const dir = path.join(card.folderAbs, 'images', 'staged');
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    names = [];
  }
  for (const n of names) {
    if (!IMG_EXT.test(n)) continue;
    const rel = `images/staged/${n}`;
    if (entries.some((e) => e.path === rel)) continue;
    const sha = sha256File(path.join(dir, n));
    if (inJira.has(sha) || seen.has(sha)) continue;
    seen.add(sha);
    out.push({ file: rel, filename: n, sha256: sha, unlisted: true });
  }
  return out;
}

/**
 * @param {{ all: any[], epics: any[] }} tree
 * @param {{ jira?: object }} index
 * @param {{ keys?: string[]|null, only?: string[]|null, backlog?: boolean }} [o]
 */
export function planPush(tree, index, o = {}) {
  const jira = index?.jira ?? {};
  const ops = [];
  const skipped = [];
  const problems = [];
  const keyFilter = o.keys?.length ? new Set(o.keys) : null;
  const wanted = (c) => !keyFilter || keyFilter.has(c.meta.jira_key) || keyFilter.has(c.meta.local_id);
  const want = (k) => !o.only || o.only.includes(k);
  const level = { epic: 0, story: 1, subtask: 2 };
  const shaOwner = new Map();

  // 1. creates, parents first.
  const creates = tree.all.filter((c) => c.hasLocal && !cleanKey(c.meta.jira_key) && wanted(c)).sort((a, b) => level[a.kind] - level[b.kind]);
  if (want('create')) {
    for (const c of creates) {
      ops.push({
        op: 'create',
        local_id: c.meta.local_id,
        kind: c.kind,
        folder: c.folder,
        issuetype: c.meta.type || { epic: 'Epic', story: 'Story', subtask: 'Sub-task' }[c.kind],
        summary: c.meta.summary,
        parent_local_id: c.meta.parent_local_id ?? null,
        parent_key: c.parentCard ? cleanKey(c.parentCard.meta.jira_key) : null,
        labels: labelsOf(c.meta),
        story_points: c.kind === 'epic' ? null : pointsOf(c.meta),
        sprint: c.kind === 'story' && jira.sprint_id && c.meta.sprint && c.meta.sprint === jira.sprint_name ? Number(jira.sprint_id) : null,
        status: c.meta.status ?? null,
      });
    }
  }

  for (const c of tree.all) {
    const key = cleanKey(c.meta.jira_key);
    if (!key || !c.hasLocal || !wanted(c)) continue;
    const jm = c.jiraMeta;
    if (!jm) {
      problems.push({ key, folder: c.folder, message: 'no Jira copy yet; run pull first' });
      continue;
    }
    if (isDoneMeta(jm)) {
      skipped.push({ key, folder: c.folder, reason: 'Done in Jira (keeps its Jira text)' });
      continue;
    }
    // 2. update
    const fields = {};
    if (String(c.meta.summary ?? '').trim() !== String(jm.summary ?? '').trim()) fields.summary = c.meta.summary;
    if (normalizeBody(c.body) !== normalizeBody(c.jiraBody ?? '')) fields.description = true;
    if (JSON.stringify(labelsOf(c.meta)) !== JSON.stringify(labelsOf(jm))) fields.labels = labelsOf(c.meta);
    if (c.kind !== 'epic' && pointsOf(c.meta) !== pointsOf(jm)) fields.story_points = pointsOf(c.meta);
    const wantParent = c.parentCard ? cleanKey(c.parentCard.meta.jira_key) : null;
    if (c.kind === 'story' && wantParent && wantParent !== cleanKey(jm.parent_jira_key ?? jm.parent)) fields.parent = wantParent;
    if (c.kind === 'subtask' && wantParent && wantParent !== cleanKey(jm.parent_jira_key ?? jm.parent)) {
      problems.push({ key, folder: c.folder, message: `subtask parent is ${jm.parent_jira_key ?? jm.parent} in Jira and ${wantParent} here; Jira cannot move a subtask by API, move it by hand` });
    }
    if (Object.keys(fields).length && want('update')) ops.push({ op: 'update', key, local_id: c.meta.local_id, folder: c.folder, fields: Object.keys(fields), values: fields });
    // 3. transition
    if (c.meta.status && jm.status && c.meta.status !== jm.status && want('transition')) ops.push({ op: 'transition', key, folder: c.folder, from: jm.status, to: c.meta.status });
  }

  // 4. uploads (also for cards being created; key filled at run time)
  if (want('upload')) {
    for (const c of tree.all) {
      if (!c.hasLocal || !wanted(c) || isDoneMeta(c.jiraMeta)) continue;
      for (const im of stagedImages(c)) {
        const owner = shaOwner.get(im.sha256);
        if (owner) {
          problems.push({ folder: c.folder, message: `image ${im.filename} is the same file as one staged on ${owner}; it is uploaded once, to ${owner}` });
          continue;
        }
        shaOwner.set(im.sha256, c.folder);
        ops.push({ op: 'upload', key: cleanKey(c.meta.jira_key), local_id: c.meta.local_id, folder: c.folder, ...im });
      }
    }
  }

  // 5. sprint moves (stories and bugs; subtasks follow their parent)
  if (jira.sprint_id && jira.sprint_name && want('sprint')) {
    const into = [];
    const out = [];
    for (const c of tree.all) {
      if (c.kind !== 'story' || !c.hasLocal || !wanted(c)) continue;
      const key = cleanKey(c.meta.jira_key);
      if (!key || !c.jiraMeta || isDoneMeta(c.jiraMeta)) continue;
      const here = c.meta.sprint === jira.sprint_name;
      const there = c.jiraMeta.sprint === jira.sprint_name;
      if (here && !there) into.push(key);
      if (!here && there && c.meta.sprint === null) out.push(key);
    }
    if (into.length) ops.push({ op: 'sprint', sprint_id: Number(jira.sprint_id), keys: into });
    if (out.length && o.backlog) ops.push({ op: 'backlog', keys: out });
    else if (out.length) problems.push({ message: `${out.length} card(s) have sprint: null here but are in the sprint in Jira (${out.join(', ')}); pass --backlog to move them out` });
  }

  // 6. rank: per parent, when any sibling moved or a sibling is new.
  if (want('rank')) {
    const groups = [tree.epics, ...tree.epics.map((e) => e.children), ...tree.epics.flatMap((e) => e.children.map((s) => s.children))];
    for (const g of groups) {
      const sibs = [...g].filter((c) => c.hasLocal).sort(bySiblingOrder);
      if (sibs.length < 2 || sibs[0].kind === 'epic') continue;
      const moved = sibs.some((c) => Number.isInteger(c.meta.order) && Number.isInteger(c.meta.jira_order) && c.meta.order !== c.meta.jira_order);
      const fresh = sibs.some((c) => !cleanKey(c.meta.jira_key));
      if (!moved && !fresh) continue;
      const live = sibs.filter((c) => !isDoneMeta(c.jiraMeta));
      if (live.length < 2) continue;
      ops.push({ op: 'rank', parent: sibs[0].parentCard?.meta.jira_key ?? null, local_ids: live.map((c) => c.meta.local_id), keys: live.map((c) => cleanKey(c.meta.jira_key)) });
    }
  }
  return { ops, skipped, problems, jira };
}

/** One line per op, for the dry-run report. */
export function describeOp(op) {
  switch (op.op) {
    case 'create':
      return `CREATE ${op.issuetype} "${op.summary}" under ${op.parent_key ?? (op.parent_local_id ? `(new parent ${op.parent_local_id})` : 'the project')}${op.sprint ? ` in sprint ${op.sprint}` : ''}`;
    case 'update':
      return `UPDATE ${op.key}: ${op.fields.join(', ')}`;
    case 'transition':
      return `TRANSITION ${op.key}: ${op.from} -> ${op.to}`;
    case 'upload':
      return `UPLOAD ${op.filename} to ${op.key ?? `(new ${op.local_id})`} (sha ${op.sha256.slice(0, 12)})`;
    case 'sprint':
      return `SPRINT move ${op.keys.length} issue(s) into sprint ${op.sprint_id}: ${op.keys.join(', ')}`;
    case 'backlog':
      return `BACKLOG move ${op.keys.length} issue(s): ${op.keys.join(', ')}`;
    case 'rank':
      return `RANK under ${op.parent ?? 'board'}: ${op.keys.map((k, i) => k ?? `(new ${op.local_ids[i]})`).join(' > ')}`;
    default:
      return JSON.stringify(op);
  }
}

/** ADF for a card body, validated. Throws when Jira would reject it. */
export function bodyToAdf(body) {
  const adf = markdownToAdf(normalizeBody(body));
  const errs = validateAdf(adf);
  if (errs.length) throw new Error(`ADF invalid: ${errs.slice(0, 3).join('; ')}`);
  return adf;
}

function jqlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Search for an issue we may already have created (same summary, same parent, recent). */
async function findExisting(client, projectKey, summary, parentKey) {
  const words = String(summary).replace(/[^\p{L}\p{N} ]+/gu, ' ').trim();
  const jql = `project = ${jqlString(projectKey)}${parentKey ? ` AND parent = ${parentKey}` : ''} AND summary ~ ${jqlString(words.slice(0, 200))} AND created >= -14d ORDER BY created DESC`;
  const hits = await client.search(jql, ['summary', 'parent', 'issuetype']);
  return hits.find((h) => String(h.fields?.summary ?? '').trim() === String(summary).trim()) ?? null;
}

function setMeta(card, patch) {
  const text = fs.readFileSync(card.localPath, 'utf8');
  const { meta, body } = parseCard(text);
  Object.assign(meta, patch);
  writeText(card.localPath, renderCard(meta, body));
  Object.assign(card.meta, patch);
}

/**
 * Write a new key back into a card and point its children at it.
 * Used by apply and by the `record` command (MCP path).
 */
export function recordKey(dir, localId, key, id) {
  if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) throw new Error(`bad key ${key}`);
  const tree = loadTree(dir);
  const card = tree.all.find((c) => c.meta.local_id === localId);
  if (!card) throw new Error(`no card with local_id ${localId}`);
  const cur = cleanKey(card.meta.jira_key);
  if (cur && cur !== key) throw new Error(`${localId} already has jira_key ${cur}; refusing to overwrite it with ${key}`);
  setMeta(card, { jira_key: key, key, ...(id ? { jira_id: String(id) } : {}) });
  for (const ch of card.children) if (ch.hasLocal) setMeta(ch, { parent_jira_key: key, parent: key });
  return card;
}

/**
 * Run a plan against Jira with the user key.
 *
 * @param {string} dir
 * @param {ReturnType<typeof planPush>} plan
 * @param {{ auth: object, client?: object, log?: (e: object) => void, now?: Date, sleep?: (ms: number) => Promise<void> }} o
 */
export async function applyPush(dir, plan, o) {
  const client = o.client ?? createClient(o.auth);
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sdir = sprintDir(dir);
  const day = (o.now ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
  const logPath = path.join(sdir, `PUSH-LOG-${day}.jsonl`);
  const backupPath = path.join(sdir, `PUSH-BACKUP-${day}.jsonl`);
  const res = { created: [], updated: [], transitioned: [], uploaded: [], sprint: [], ranked: [], skipped: [], failed: [], verify: [] };
  const log = (e) => {
    const line = redact(JSON.stringify({ t: new Date().toISOString(), ...e }), { auth: o.auth });
    fs.appendFileSync(logPath, `${line}\n`);
    o.log?.(e);
  };
  const fail = (op, err) => {
    const reason = redact(String(err?.message ?? err), { auth: o.auth }).slice(0, 400);
    res.failed.push({ op: op.op, key: op.key ?? null, local_id: op.local_id ?? null, reason });
    log({ kind: `${op.op}_failed`, key: op.key, local_id: op.local_id, reason });
  };
  const jira = plan.jira ?? readIndex(dir)?.jira ?? {};
  const projectKey = jira.project_key;
  const touched = new Set();
  const cardByLocal = () => new Map(loadTree(dir).all.map((c) => [c.meta.local_id, c]));
  const fieldIds = await discoverFields(client);
  const needsTypes = plan.ops.some((x) => x.op === 'create');
  if (needsTypes && !projectKey) throw new Error('index.json has no jira.project_key; run `init` or `connect` first');
  const types = needsTypes ? await discoverIssueTypes(client, projectKey) : null;

  for (const op of plan.ops) {
    try {
      if (op.op === 'create') {
        const cards = cardByLocal();
        const card = cards.get(op.local_id);
        if (!card) throw new Error('card no longer exists');
        if (cleanKey(card.meta.jira_key)) {
          res.skipped.push({ local_id: op.local_id, reason: `already has ${card.meta.jira_key}` });
          continue;
        }
        const parentKey = card.parentCard ? cleanKey(card.parentCard.meta.jira_key) : null;
        if (card.parentCard && !parentKey) throw new Error(`parent ${card.meta.parent_local_id} has no Jira key (its create failed?)`);
        const t = types.byName(op.issuetype) ?? (card.kind === 'subtask' ? types.subtask : card.kind === 'epic' ? types.epic : types.story);
        if (!t) throw new Error(`project ${projectKey} has no issue type for ${op.issuetype}`);
        const fields = {
          project: { key: projectKey },
          issuetype: { id: t.id },
          summary: card.meta.summary,
          description: bodyToAdf(card.body),
          labels: labelsOf(card.meta),
          ...(parentKey ? { parent: { key: parentKey } } : {}),
        };
        const sp = card.kind === 'epic' ? null : pointsOf(card.meta);
        if (sp !== null && fieldIds.storyPoints) fields[fieldIds.storyPoints] = sp;
        if (op.sprint && fieldIds.sprint) fields[fieldIds.sprint] = Number(op.sprint);
        let made = await findExisting(client, projectKey, card.meta.summary, parentKey);
        let note = made ? 'found existing issue, not created again' : '';
        if (!made) {
          try {
            made = await client.write('POST', '/rest/api/3/issue', { fields });
          } catch (err) {
            if (err.status === 400 && /customfield|cannot be set|not on the appropriate screen/i.test(String(err.message))) {
              // A field is not on the create screen: create without it, set it after.
              const retry = { ...fields };
              for (const k of Object.keys(retry)) if (k.startsWith('customfield_')) delete retry[k];
              made = await client.write('POST', '/rest/api/3/issue', { fields: retry });
              note = 'created without custom fields; set by update';
              const later = {};
              for (const k of Object.keys(fields)) if (k.startsWith('customfield_')) later[k] = fields[k];
              try {
                await client.write('PUT', `/rest/api/3/issue/${made.key}`, { fields: later }, { notifyUsers: 'false' });
              } catch (e2) {
                note += `; custom fields failed: ${String(e2.message).slice(0, 120)}`;
              }
            } else if (err.status === undefined || err.status >= 500) {
              await sleep(3000);
              made = await findExisting(client, projectKey, card.meta.summary, parentKey);
              if (!made) throw err;
              note = `created despite error ${err.status ?? 'network'}`;
            } else throw err;
          }
        }
        recordKey(dir, op.local_id, made.key, made.id);
        touched.add(made.key);
        res.created.push({ key: made.key, local_id: op.local_id, kind: card.kind, parent: parentKey, note });
        log({ kind: 'created', key: made.key, id: made.id, local_id: op.local_id, parent: parentKey, note });
      } else if (op.op === 'update') {
        const card = cardByLocal().get(op.local_id);
        const cur = await client.get(`/rest/api/3/issue/${op.key}`, { fields: ['summary', 'description', 'labels', 'status', 'parent', 'project', ...(fieldIds.storyPoints ? [fieldIds.storyPoints] : [])].join(',') });
        if (cur?.fields?.status?.statusCategory?.key === 'done') {
          res.skipped.push({ key: op.key, reason: 'Done in Jira at write time' });
          log({ kind: 'update_skipped_done', key: op.key });
          continue;
        }
        if (projectKey && cur?.fields?.project?.key && cur.fields.project.key !== projectKey) throw new Error(`${op.key} is in project ${cur.fields.project.key}, not ${projectKey}`);
        fs.appendFileSync(backupPath, `${JSON.stringify({ t: new Date().toISOString(), key: op.key, fields: cur.fields })}\n`);
        const fields = {};
        if (op.fields.includes('summary')) fields.summary = card.meta.summary;
        if (op.fields.includes('description')) {
          const live = descriptionToBody(cur.fields.description);
          if (live !== normalizeBody(card.body)) fields.description = bodyToAdf(card.body);
        }
        if (op.fields.includes('labels')) fields.labels = labelsOf(card.meta);
        if (op.fields.includes('story_points') && fieldIds.storyPoints) fields[fieldIds.storyPoints] = pointsOf(card.meta);
        if (op.fields.includes('parent')) fields.parent = { key: op.values.parent };
        if (!Object.keys(fields).length) {
          res.skipped.push({ key: op.key, reason: 'already matches Jira' });
          continue;
        }
        try {
          await client.write('PUT', `/rest/api/3/issue/${op.key}`, { fields }, { notifyUsers: 'false' });
        } catch (err) {
          if (err.status === 400 || err.status === 403) {
            if (/notif/i.test(String(err.message))) await client.write('PUT', `/rest/api/3/issue/${op.key}`, { fields });
            else throw err;
          } else if (err.status === undefined || err.status >= 500) {
            await sleep(2000);
            const chk = await client.get(`/rest/api/3/issue/${op.key}`, { fields: 'summary' });
            if (fields.summary && chk?.fields?.summary !== fields.summary) throw err;
          } else throw err;
        }
        touched.add(op.key);
        res.updated.push({ key: op.key, fields: Object.keys(fields) });
        log({ kind: 'updated', key: op.key, fields: Object.keys(fields) });
      } else if (op.op === 'transition') {
        const tr = await client.get(`/rest/api/3/issue/${op.key}/transitions`);
        const hit = (tr?.transitions ?? []).find((x) => String(x.to?.name ?? x.name).toLowerCase() === String(op.to).toLowerCase());
        if (!hit) throw new Error(`no transition to "${op.to}" from the current status (have: ${(tr?.transitions ?? []).map((x) => x.to?.name ?? x.name).join(', ')})`);
        await client.write('POST', `/rest/api/3/issue/${op.key}/transitions`, { transition: { id: hit.id } });
        touched.add(op.key);
        res.transitioned.push({ key: op.key, to: op.to });
        log({ kind: 'transitioned', key: op.key, to: op.to });
      } else if (op.op === 'upload') {
        const card = cardByLocal().get(op.local_id);
        const key = cleanKey(card?.meta.jira_key);
        if (!key) throw new Error('card has no Jira key (create failed?)');
        if (isDoneMeta(card.jiraMeta)) {
          res.skipped.push({ key, reason: 'Done card, image not uploaded' });
          continue;
        }
        const abs = path.join(card.folderAbs, op.file);
        const size = fs.statSync(abs).size;
        const live = (await client.get(`/rest/api/3/issue/${key}`, { fields: 'attachment' }))?.fields?.attachment ?? [];
        let att = live.find((a) => a.filename === op.filename && a.size === size);
        let note = att ? 'already on the issue' : '';
        if (!att) {
          try {
            att = (await client.attach(key, abs, op.filename))?.[0];
          } catch (err) {
            await sleep(2000);
            const again = (await client.get(`/rest/api/3/issue/${key}`, { fields: 'attachment' }))?.fields?.attachment ?? [];
            att = again.find((a) => a.filename === op.filename && a.size === size);
            if (!att) throw err;
            note = 'uploaded despite error';
          }
        }
        const mfPath = path.join(card.folderAbs, 'images', 'manifest.json');
        let entries = [];
        try {
          entries = JSON.parse(fs.readFileSync(mfPath, 'utf8'));
        } catch {
          entries = [];
        }
        const ent = entries.find((e) => e.path === op.file);
        const upd = { filename: op.filename, sha256: op.sha256, jira_attachment_id: String(att.id), status: 'in_jira', path: op.file };
        if (ent) Object.assign(ent, upd);
        else entries.push(upd);
        writeJson(mfPath, entries);
        const atts = Array.isArray(card.meta.attachments) ? [...card.meta.attachments] : [];
        if (!atts.some((a) => a.sha256 === op.sha256)) {
          atts.push({ filename: op.filename, sha256: op.sha256 });
          setMeta(card, { attachments: atts });
        }
        touched.add(key);
        res.uploaded.push({ key, file: op.filename, attachment_id: String(att.id), note });
        log({ kind: 'uploaded', key, file: op.filename, attachment_id: String(att.id), note });
      } else if (op.op === 'sprint' || op.op === 'backlog') {
        const p = op.op === 'sprint' ? `/rest/agile/1.0/sprint/${op.sprint_id}/issue` : '/rest/agile/1.0/backlog/issue';
        for (let i = 0; i < op.keys.length; i += 50) await client.write('POST', p, { issues: op.keys.slice(i, i + 50) });
        op.keys.forEach((k) => touched.add(k));
        res.sprint.push({ op: op.op, keys: op.keys });
        log({ kind: op.op, keys: op.keys, sprint_id: op.sprint_id ?? null });
      } else if (op.op === 'rank') {
        const cards = cardByLocal();
        const keys = op.local_ids.map((lid) => cleanKey(cards.get(lid)?.meta.jira_key)).filter(Boolean);
        for (let i = 1; i < keys.length; i += 1) {
          await client.write('PUT', '/rest/agile/1.0/issue/rank', { issues: [keys[i]], rankAfterIssue: keys[i - 1] });
        }
        for (const lid of op.local_ids) {
          const c = cards.get(lid);
          if (c?.hasLocal && Number.isInteger(c.meta.order)) setMeta(c, { jira_order: c.meta.order });
        }
        res.ranked.push({ parent: op.parent, keys });
        log({ kind: 'ranked', parent: op.parent, keys });
      }
    } catch (err) {
      fail(op, err);
    }
  }

  // Read back every touched issue, refresh its Jira copy and compare.
  if (touched.size) {
    const extra = [fieldIds.storyPoints, fieldIds.sprint].filter(Boolean);
    const keys = [...touched];
    const tree = loadTree(dir);
    const byKey = new Map(tree.all.map((c) => [cleanKey(c.meta.jira_key), c]));
    for (let i = 0; i < keys.length; i += 80) {
      const got = await client.search(`key in (${keys.slice(i, i + 80).join(',')})`, ['summary', 'status', 'issuetype', 'parent', 'labels', 'description', 'attachment', 'updated', ...extra]);
      for (const issue of got) {
        const card = byKey.get(issue.key);
        if (!card) continue;
        const { meta, body } = await writeJiraCopy(card, issue, fieldIds, { client, sprintId: jira.sprint_id, images: false });
        const diffs = [];
        if (String(meta.summary).trim() !== String(card.meta.summary).trim()) diffs.push('summary');
        if (normalizeBody(body) !== normalizeBody(card.body)) diffs.push('description');
        if (JSON.stringify(labelsOf(meta)) !== JSON.stringify(labelsOf(card.meta))) diffs.push('labels');
        if (card.kind !== 'epic' && fieldIds.storyPoints && pointsOf(meta) !== pointsOf(card.meta)) diffs.push('story_points');
        res.verify.push({ key: issue.key, ok: diffs.length === 0, diffs });
      }
    }
  }
  assignIds(dir);
  writeJson(path.join(cardsRoot(dir), 'manifest.json'), buildManifest(dir));
  log({ kind: 'summary', ...Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v.length])) });
  return { ...res, log: logPath };
}

/**
 * Turn a plan into Atlassian MCP tool calls. Steps the MCP cannot do are
 * marked `needs: "user-key"` with what to do instead.
 *
 * @param {ReturnType<typeof planPush>} plan
 * @param {{ all: any[] }} tree
 */
export function mcpPlan(plan, tree, index = {}) {
  const jira = plan.jira ?? {};
  const items = index.items ?? {};
  const byLocal = new Map(tree.all.map((c) => [c.meta.local_id, c]));
  const cloudId = jira.cloud_id || jira.site || '<cloudId from getAccessibleAtlassianResources>';
  const fid = index.field_ids ?? jira.field_ids ?? {};
  const steps = [];
  let deferred = 0;
  for (const op of plan.ops) {
    const card = op.local_id ? byLocal.get(op.local_id) : null;
    if (op.op === 'create') {
      if (op.parent_local_id && !op.parent_key) {
        deferred += 1;
        continue; // parent not created yet: next round
      }
      const additional = { labels: op.labels };
      if (op.story_points !== null && fid.storyPoints) additional[fid.storyPoints] = op.story_points;
      if (op.sprint && fid.sprint) additional[fid.sprint] = op.sprint;
      steps.push({
        op: 'create',
        local_id: op.local_id,
        precheck: {
          tool: 'searchJiraIssuesUsingJql',
          arguments: { cloudId, fields: ['summary', 'parent'], jql: `project = "${jira.project_key ?? '<PROJECT_KEY>'}"${op.parent_key ? ` AND parent = ${op.parent_key}` : ''} AND summary ~ "${String(op.summary).replace(/[^\p{L}\p{N} ]+/gu, ' ').trim().slice(0, 200)}" AND created >= -14d` },
          rule: 'if an issue with exactly this summary exists, do not create; run the `then` command with its key',
        },
        tool: 'createJiraIssue',
        arguments: {
          cloudId,
          projectKey: jira.project_key ?? '<PROJECT_KEY>',
          issueTypeName: op.issuetype,
          summary: op.summary,
          contentFormat: 'adf',
          description: bodyToAdf(card.body),
          ...(op.parent_key ? { parent: op.parent_key } : {}),
          additional_fields: additional,
        },
        then: `record ${op.local_id} --key <new key> --id <new id>`,
        ...(op.story_points !== null && !fid.storyPoints ? { note: 'story points field id unknown; set it by hand or run pull with the user key once' } : {}),
      });
    } else if (op.op === 'update') {
      const fields = {};
      if (op.fields.includes('summary')) fields.summary = card.meta.summary;
      if (op.fields.includes('description')) fields.description = bodyToAdf(card.body);
      if (op.fields.includes('labels')) fields.labels = op.values.labels;
      if (op.fields.includes('story_points')) {
        if (fid.storyPoints) fields[fid.storyPoints] = op.values.story_points;
      }
      if (op.fields.includes('parent')) fields.parent = { key: op.values.parent };
      steps.push({ op: 'update', key: op.key, tool: 'editJiraIssue', arguments: { cloudId, issueIdOrKey: op.key, contentFormat: 'adf', fields }, before: `getJiraIssue: skip if the status category is Done; if fields.updated is newer than ${items[op.local_id]?.jira_updated ?? 'the last pull'}, stop and run import-jira/pull first` });
    } else if (op.op === 'transition') {
      steps.push({ op: 'transition', key: op.key, tool: 'transitionJiraIssue', arguments: { cloudId, issueIdOrKey: op.key, transition: { id: `<id of the transition to "${op.to}" from getTransitionsForJiraIssue>` } } });
    } else if (op.op === 'sprint') {
      if (fid.sprint) {
        for (const k of op.keys) steps.push({ op: 'sprint', key: k, tool: 'editJiraIssue', arguments: { cloudId, issueIdOrKey: k, fields: { [fid.sprint]: op.sprint_id } }, note: 'sets the Sprint field; works on most sites, else use the key or the board' });
      } else steps.push({ op: 'sprint', keys: op.keys, needs: 'user-key', instead: 'drag the issues into the sprint on the board, or set JIRA_EMAIL/JIRA_API_TOKEN and run push --apply' });
    } else {
      steps.push({ op: op.op, ...(op.key ? { key: op.key } : {}), ...(op.keys ? { keys: op.keys } : {}), ...(op.filename ? { file: `${op.folder}/${op.file}` } : {}), needs: 'user-key', instead: op.op === 'upload' ? 'attach the file in the Jira UI, then run pull' : op.op === 'rank' ? 'drag the cards into this order on the board' : 'use the Jira UI' });
    }
  }
  return { cloud_id: cloudId, steps, deferred_creates: deferred, rerun: deferred ? 'after recording the new keys, run push --mcp-plan again for the children' : null };
}

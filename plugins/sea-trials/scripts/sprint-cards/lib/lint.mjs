/**
 * Card-format checks (see references/shared/sprint-card-format.md).
 *
 * Checked: front matter fields and values, section headings and order,
 * a code example in every subtask How section, the number of checks,
 * and rules 2, 4, 6, 7, 8, 9, 11, 16 and 17. Cards that are Done in Jira
 * keep their Jira text and are skipped (rule 15).
 *
 * Viewer format (sprint-plan-viewer FORMAT.md, checked on every card,
 * Done included): folder names, a Jira key never sitting in a `LOCAL`
 * folder (the viewer hides the key and sprint of any card whose path
 * contains `LOCAL`), the alias keys `key`/`parent`, `plan_number`, no
 * `# Title` first line, and the Jira copy next to a keyed card.
 */
import path from 'node:path';
import { auditNumbering } from './numbering.mjs';
import { CARD_KEYS } from './frontmatter.mjs';

export const SECTIONS = {
  epic: ['Goal', 'Scope', 'Stories'],
  story: ['Context', 'Acceptance criteria', 'Out of scope', 'Dependencies'],
  subtask: ['What and why', 'Where', 'How', 'Done when'],
};

const CHECK_LIMITS = {
  story: { section: 'Acceptance criteria', min: 3, max: 15 },
  subtask: { section: 'Done when', min: 2, max: 10 },
};

/** Heuristic rules: reported, but they do not fail the lint. */
export const WARN_RULES = new Set(['rule-8', 'rule-16', 'viewer-order', 'viewer-jira-copy']);

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
/** Folder names the viewer expects; `KEY` is a Jira key or `LOCAL`/`LOCAL-NN`. */
export const FOLDER_RE = {
  epic: /^\d{2}-epic-(?:[A-Z][A-Z0-9_]*-\d+|LOCAL(?:-[0-9.]+)?)-[a-z0-9][a-z0-9-]*$/,
  story: /^\d{2}-story-(?:[A-Z][A-Z0-9_]*-\d+|LOCAL(?:-[0-9.]+)?)-[a-z0-9][a-z0-9-]*$/,
  subtask: /^\d{2}-(?:[A-Z][A-Z0-9_]*-\d+|LOCAL(?:-[0-9.]+)?)-[a-z0-9][a-z0-9-]*$/,
};
const PLAN_NUMBER_RE = { epic: /^[SE]\d+$/, story: /^\d+$/, subtask: /^\d+\.\d+$/ };
const TYPES = { epic: /^Epic$/, story: /^(Story|Bug)$/, subtask: /^(Sub-task|Subtask)$/ };

/**
 * Viewer-format checks. They run on every card with a local file, Done
 * cards included, because the viewer reads all of them.
 */
export function lintViewerFormat(card) {
  const out = [];
  const add = (rule, message) => out.push({ folder: card.folder, kind: card.kind, rule, severity: WARN_RULES.has(rule) ? 'warn' : 'error', message });
  const m = card.meta;
  const name = path.posix.basename(card.folder);
  if (!FOLDER_RE[card.kind].test(name)) {
    const want = card.kind === 'subtask' ? 'NN-<KEY>-<slug>' : `NN-${card.kind}-<KEY>-<slug>`;
    add('viewer', `folder name "${name}" is not ${want} (KEY = Jira key or LOCAL, slug = lowercase letters, digits and -)`);
  }
  const jk = m.jira_key ?? null;
  if (jk && /LOCAL/.test(card.folder)) {
    add('viewer', `has jira_key ${jk} but its path contains LOCAL, so the viewer shows it as local-only; rename the folder to use ${jk} (and any LOCAL parent folder)`);
  } else if (jk && KEY_RE.test(String(jk)) && !name.includes(String(jk))) {
    add('viewer', `folder name does not carry its jira_key ${jk}`);
  }
  for (const k of ['key', 'type', 'parent', 'order', 'plan_number', 'jira_order']) {
    if (!(k in m)) add('viewer', `missing field \`${k}\``);
  }
  if ('key' in m && (m.key ?? null) !== jk) add('viewer', `key must equal jira_key (${jk ?? 'null'})`);
  if ('parent' in m && (m.parent ?? null) !== (m.parent_jira_key ?? null)) add('viewer', `parent must equal parent_jira_key (${m.parent_jira_key ?? 'null'})`);
  if (m.type && !TYPES[card.kind].test(String(m.type))) add('viewer', `type "${m.type}" does not fit a ${card.kind} card`);
  if (m.plan_number !== null && m.plan_number !== undefined && !PLAN_NUMBER_RE[card.kind].test(String(m.plan_number))) {
    add('viewer', `plan_number "${m.plan_number}" is not ${card.kind === 'epic' ? 'S1 or E1' : card.kind === 'story' ? "'N'" : "'N.M'"}`);
  }
  if (m.order !== null && m.order !== undefined && !(Number.isInteger(m.order) && m.order >= 1)) add('viewer', 'order must be a whole number from 1');
  if (/^\s*#\s/.test(card.body ?? '')) add('viewer', 'body must not start with a "# Title" line (the viewer drops it; the title is `summary`)');
  if (jk && card.jiraMeta === null) add('viewer-jira-copy', `has jira_key ${jk} but no ${card.kind}.jira.md; run pull or import-jira so the viewer can compare`);
  const known = Object.keys(m).filter((k) => CARD_KEYS.includes(k));
  const sorted = [...known].sort((a, b) => CARD_KEYS.indexOf(a) - CARD_KEYS.indexOf(b));
  if (known.join('|') !== sorted.join('|')) add('viewer-order', 'front matter keys are not in the card key order (ids and lint rewrite them)');
  return out;
}

const STATUS_CATEGORIES = new Set(['new', 'indeterminate', 'done']);
const TOOL_WORDS = /\b(seamless(?:ly)?|robust(?:ly)?|leverag(?:e|es|ed|ing)|ensur(?:e|es|ed|ing)|delv(?:e|es|ed|ing)|utiliz(?:e|es|ed|ing)|streamlin(?:e|ed|es|ing)|cutting-edge|game-changer)\b/i;
const HEDGE_WORDS = /\b(TBD|TODO|maybe|optional(?:ly)?|should|could|consider|perhaps|might)\b/i;
const DATE_RE = /\b(?:(?:jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{4}-\d{2}-\d{2}|next (?:week|month|sprint)|this (?:week|month)|(?:wait|after)\s+\d+\s+(?:day|days|week|weeks|hour|hours))\b/i;
const ROUTE_PARAM_RE = /`[^`\s]*\/(?::[a-z_]+|<[a-z_]+>)(?:[/`?])/i;

function stripCode(body) {
  return body
    .replace(/```[\s\S]*?```/g, (m) => '\n'.repeat((m.match(/\n/g) ?? []).length))
    .replace(/`[^`\n]*`/g, '``');
}

function stripQuoted(line) {
  return line.replace(/"[^"\n]*"/g, '""').replace(/“[^”\n]*”/g, '""');
}

/** Split a body into `{ intro, sections: [{ title, text, line }] }`. */
export function splitSections(body) {
  const lines = body.split('\n');
  const sections = [];
  const intro = [];
  let cur = null;
  let inFence = false;
  lines.forEach((l, i) => {
    if (/^\s*(```|~~~)/.test(l)) inFence = !inFence;
    const m = !inFence && /^##\s+(.+?)\s*$/.exec(l);
    if (m && !l.startsWith('###')) {
      cur = { title: m[1], lines: [], line: i + 1 };
      sections.push(cur);
    } else if (cur) cur.lines.push(l);
    else intro.push(l);
  });
  return {
    intro: intro.join('\n'),
    sections: sections.map((s) => ({ title: s.title, text: s.lines.join('\n'), line: s.line })),
  };
}

function isDone(card) {
  const sc = String(card.jiraMeta?.status_category ?? '').toLowerCase();
  return sc === 'done';
}

/**
 * Lint one card. Returns problems as `{ folder, rule, message, line? }`.
 *
 * @param {import('./tree.mjs').Card} card
 * @param {{ maxPoints?: number, sprintName?: string|null }} [o]
 */
export function lintCard(card, o = {}) {
  const out = [];
  const add = (rule, message, line) => out.push({ folder: card.folder, kind: card.kind, rule, severity: WARN_RULES.has(rule) ? 'warn' : 'error', message, ...(line ? { line } : {}) });
  if (!card.hasLocal) {
    add('files', `missing ${card.kind}.local.md`);
    return out;
  }
  out.push(...lintViewerFormat(card));
  if (isDone(card)) return out; // rule 15
  const m = card.meta;
  const maxPoints = o.maxPoints ?? 8;

  // Front matter.
  for (const k of ['local_id', 'jira_key', 'jira_id', 'parent_local_id', 'parent_jira_key', 'type', 'summary', 'status', 'status_category', 'story_points', 'labels', 'sprint', 'attachments']) {
    if (!(k in m)) add('front-matter', `missing field \`${k}\``);
  }
  if (m.local_id && !/^loc-([A-Z][A-Z0-9_]*-\d+|[0-9a-f]{8,12})$/.test(String(m.local_id))) add('front-matter', `local_id \`${m.local_id}\` is not loc-<KEY> or loc-<hex>`);
  if (m.jira_key !== null && m.jira_key !== undefined && !/^[A-Z][A-Z0-9_]*-\d+$/.test(String(m.jira_key))) add('front-matter', `jira_key \`${m.jira_key}\` is not a Jira key or null`);
  if (m.status_category && !STATUS_CATEGORIES.has(String(m.status_category))) add('front-matter', `status_category must be new, indeterminate or done`);
  if (card.kind === 'epic') {
    if (m.story_points !== null && m.story_points !== undefined) add('front-matter', 'an epic has story_points: null');
    if (m.parent_local_id) add('rule-11', 'an epic has no parent');
  } else {
    const sp = m.story_points;
    if (card.kind === 'story' && !(Number.isInteger(sp) && sp >= 1 && sp <= maxPoints)) add('front-matter', `story_points must be a whole number from 1 to ${maxPoints}`);
    if (card.kind === 'subtask' && sp !== null && sp !== undefined && !(Number.isInteger(sp) && sp >= 1 && sp <= maxPoints)) add('front-matter', `story_points must be null or 1 to ${maxPoints}`);
    if (!m.parent_local_id) add('rule-11', 'parent_local_id is missing');
    else if (card.parentCard && m.parent_local_id !== card.parentCard.meta.local_id) add('rule-11', `parent_local_id ${m.parent_local_id} does not match the parent card ${card.parentCard.meta.local_id}`);
  }
  if (!Array.isArray(m.labels)) add('front-matter', 'labels must be a list');
  if (Array.isArray(m.attachments)) {
    const seen = new Set();
    for (const a of m.attachments) {
      if (a?.sha256 && seen.has(a.sha256)) add('front-matter', `attachment ${a.filename} is listed twice (same sha256)`);
      if (a?.sha256) seen.add(a.sha256);
    }
  }
  const summary = String(m.summary ?? '');
  if (!summary.trim()) add('front-matter', 'summary is empty');
  if (card.kind === 'story' && !/^User Story \d+: \S/.test(summary)) add('rule-9', 'story summary must start with "User Story N: "');
  if (card.kind !== 'story' && /^User Story \d+/i.test(summary)) add('rule-9', `${card.kind} titles have no number`);
  if (o.sprintName !== undefined && m.sprint !== null && m.sprint !== undefined && o.sprintName && m.sprint !== o.sprintName) add('front-matter', `sprint is "${m.sprint}", expected "${o.sprintName}" or null`);

  // Body.
  const body = card.body ?? '';
  if (/^\s*##\s+Description\b/.test(body)) add('sections', 'body must not start with "## Description"');
  const { intro, sections } = splitSections(body);
  const want = SECTIONS[card.kind];
  const titles = sections.map((s) => s.title);
  const extra = titles.filter((t) => !want.includes(t));
  for (const t of extra) add('sections', `heading "## ${t}" is not allowed for a ${card.kind}`);
  const missing = want.filter((t) => !titles.includes(t));
  for (const t of missing) add('sections', `missing "## ${t}"`);
  const ordered = titles.filter((t) => want.includes(t));
  if (!missing.length && ordered.join('|') !== want.join('|')) add('sections', `sections must be in this order: ${want.join(', ')}`);
  if (card.kind === 'story' || card.kind === 'subtask') {
    if (card.kind === 'story') {
      const first = intro.split('\n').find((l) => l.trim());
      if (!first || !/^As an? .+, I want .+ so that .+/.test(first.trim())) add('sections', 'first line must be "As a <role>, I want <thing> so that <reason>."');
    } else if (intro.trim()) add('sections', 'a subtask body starts with "## What and why"');
    const lim = CHECK_LIMITS[card.kind];
    const sec = sections.find((s) => s.title === lim.section);
    if (sec) {
      const items = sec.text.split('\n').filter((l) => /^\s*[-*]\s/.test(l));
      const boxes = items.filter((l) => /^\s*-\s\[[ xX]\]\s\S/.test(l));
      if (boxes.length < lim.min || boxes.length > lim.max) add('checks', `"${lim.section}" has ${boxes.length} checks, needs ${lim.min} to ${lim.max}`);
      if (items.length !== boxes.length) add('rule-4', `every line under "${lim.section}" must be a "- [ ]" checkbox`);
    }
  }
  if (card.kind === 'subtask') {
    const how = sections.find((s) => s.title === 'How');
    if (how && !/```/.test(how.text)) add('code-example', 'the How section needs a code example (a fenced code block)');
    const what = sections.find((s) => s.title === 'What and why');
    if (what) {
      const sentences = what.text.replace(/`[^`]*`/g, 'x').split(/[.!]\s+|\.$/m).filter((x) => x.trim()).length;
      if (sentences > 3) add('rule-16', `"What and why" has ${sentences} sentences, keep it to 1 to 3`);
    }
    const where = sections.find((s) => s.title === 'Where');
    if (where && !/`[^`]+`/.test(where.text)) add('rule-16', '"Where" must list exact file paths in backticks');
  }
  if (card.kind === 'epic') {
    const goal = sections.find((s) => s.title === 'Goal');
    if (goal && !/This epic is done when:/.test(goal.text)) add('sections', 'Goal must contain "This epic is done when:"');
    const scope = sections.find((s) => s.title === 'Scope');
    if (scope && (!/In this epic:/.test(scope.text) || !/Not in this epic:/.test(scope.text))) add('sections', 'Scope must contain "In this epic:" and "Not in this epic:"');
  }

  // Line rules, outside code.
  const plain = stripCode(body).split('\n');
  plain.forEach((l, i) => {
    const ln = i + 1;
    if (/[\u2013\u2014]/.test(l)) add('rule-2', 'no em or en dashes', ln);
    if (/\[\[FILL/.test(l)) add('placeholder', 'template text left in the card ([[FILL: ...]])', ln);
    if (TOOL_WORDS.test(l)) add('rule-3', `tool-sounding word "${TOOL_WORDS.exec(l)[0]}"`, ln);
    const q = stripQuoted(l);
    if (HEDGE_WORDS.test(q)) add('rule-6', `hedge or open item "${HEDGE_WORDS.exec(q)[0]}"; write the decision as a fact or move it to OPEN-QUESTIONS.md`, ln);
    if (/\?/.test(q.replace(/https?:\/\/\S+/g, ''))) add('rule-6', 'question mark outside quoted screen text', ln);
    if (/!\[[^\]]*\]\([^)]*\)/.test(l)) add('rule-7', 'no images inside the body', ln);
    else if (/\[[^\]]+\]\([^)]+\)/.test(l)) add('rule-7', 'no Markdown links; write the URL as plain text', ln);
    if (DATE_RE.test(l)) add('rule-17', `no calendar dates or waiting periods ("${DATE_RE.exec(l)[0]}")`, ln);
  });
  body.split('\n').forEach((l, i) => {
    if (ROUTE_PARAM_RE.test(l)) add('rule-8', 'write a changing value as {name}, for example /items/{id}', i + 1);
  });
  return out;
}

/**
 * Lint every card plus tree-wide numbering.
 *
 * @param {{ all: any[], epics: any[] }} tree
 */
export function lintTree(tree, o = {}) {
  const problems = [];
  for (const c of tree.all) problems.push(...lintCard(c, o));
  const audit = auditNumbering(tree);
  const E = { severity: 'error' };
  for (const g of audit.gaps) problems.push({ ...E, folder: g.folder ?? g.epic, rule: 'rule-9', message: g.missing ? `numbering gap: ${g.missing} is missing` : `plan_number ${g.plan_number}, expected ${g.expected}` });
  for (const d of audit.duplicates) problems.push({ ...E, folder: d.folders[1], rule: 'rule-9', message: `User Story ${d.number} is used twice` });
  for (const p of audit.parent_mismatches) problems.push({ ...E, folder: p.folder, rule: 'rule-11', message: `parent_local_id ${p.parent_local_id}, expected ${p.expected}` });
  const seen = new Map();
  for (const c of tree.all) {
    const id = c.meta.local_id;
    if (!id) continue;
    if (seen.has(id)) problems.push({ ...E, folder: c.folder, rule: 'front-matter', message: `local_id ${id} is also used by ${seen.get(id)}` });
    else seen.set(id, c.folder);
  }
  return { problems, audit };
}

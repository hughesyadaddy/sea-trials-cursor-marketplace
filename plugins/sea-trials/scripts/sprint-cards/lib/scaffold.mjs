/** `init` (new sprint folder) and `new` (new card from a template). */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderCard } from './frontmatter.mjs';
import { slugify } from './convert.mjs';
import { assignIds } from './ids.mjs';
import { renumber } from './numbering.mjs';
import { cardsRoot, loadTree, readIndex, writeJson, writeText } from './tree.mjs';
import { normalizeSite } from './auth.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The card format spec ships once, in skills/_sources. */
const FORMAT_CANDIDATES = [
  path.resolve(HERE, '..', '..', '..', 'skills', '_sources', 'sprint-card-format.md'),
  path.resolve(HERE, '..', '..', '..', 'skills', 'st-sprint-plan', 'references', 'shared', 'sprint-card-format.md'),
];
export const FORMAT_SOURCE = FORMAT_CANDIDATES.find((p) => fs.existsSync(p)) ?? FORMAT_CANDIDATES[0];

export const TEMPLATES = {
  epic: `## Goal

[[FILL: one paragraph, what is true for users or the team when this epic ships.]]

This epic is done when:

- [[FILL: a result anyone can check.]]

## Scope

In this epic:

- [[FILL: work this epic contains.]]

Not in this epic:

- [[FILL: work this epic does not contain, and where it lives.]]

## Stories

- [[FILL: filled from the story cards by the skill.]]
`,
  story: `As a [[FILL: role]], I want [[FILL: thing]] so that [[FILL: reason]].

## Context

[[FILL: what changes and why, in 1 to 3 plain sentences.]]

Files:

- \`[[FILL: path/to/file]]\`, function \`[[FILL: name]]\` (line [[FILL: N]])

How: [[FILL: the main change, naming the models, fields, routes and JSON.]]

## Acceptance criteria

- [ ] Given [[FILL]], when [[FILL]], then [[FILL]].
- [ ] Given [[FILL]], when [[FILL]], then [[FILL]].
- [ ] Given [[FILL]], when [[FILL]], then [[FILL]].

## Out of scope

- [[FILL: work this story does not do, and where it lives.]]

## Dependencies

- None.
`,
  subtask: `## What and why

[[FILL: what changes and why it is needed, in 1 to 3 sentences.]]

## Where

- \`[[FILL: path/to/file.ts]]\`, function \`[[FILL: name]]\` (line [[FILL: N]]) - [[FILL: what changes there]]

## How

[[FILL: the change in plain steps.]]

\`\`\`ts
// [[FILL: short before and after snippet, or a sketch of the new file]]
\`\`\`

## Done when

- [ ] Given [[FILL]], when [[FILL]], then [[FILL]].
- [ ] [[FILL: a command]] exits 0.
`,
};

/**
 * Create a sprint folder (idempotent: existing files are kept).
 *
 * @param {string} dir
 * @param {{ site?: string, cloudId?: string, projectKey?: string, boardId?: number, sprintId?: number, sprintName?: string }} jira
 */
export function init(dir, jira = {}) {
  const sdir = path.resolve(dir);
  const root = cardsRoot(sdir);
  fs.mkdirSync(root, { recursive: true });
  const created = [];
  const put = (rel, text) => {
    const p = path.join(sdir, rel);
    if (fs.existsSync(p)) return;
    writeText(p, text);
    created.push(rel);
  };
  if (fs.existsSync(FORMAT_SOURCE)) put('CARD-FORMAT.md', fs.readFileSync(FORMAT_SOURCE, 'utf8'));
  put('SPRINT-CHANGES.md', '# Sprint changes\n\nOne line per change to the plan, newest first. Each line says what changed and why.\n');
  put('OPEN-QUESTIONS.md', '# Open questions\n\nAnything still open goes here, never into a card. Each item names the card and the decision that is needed.\n\nNo open items.\n');
  put('.gitignore', 'compare/.state/\ncompare/manifest.json\njira-snapshot-*/\nPUSH-LOG-*.jsonl\nPUSH-BACKUP-*.jsonl\n**/images/jira/\n**/.up-*/\n');
  put('README.md', `# ${path.basename(sdir)}\n\nSprint cards in the card format (see CARD-FORMAT.md).\n\n- Cards: \`compare/NN-epic-<KEY>-<slug>/\` with stories and \`subtasks/\` inside.\n- View: \`node <plugin>/scripts/sprint-cards/cli.mjs serve ${path.basename(sdir)}\` then open the printed URL.\n- Check: \`... cli.mjs lint ${path.basename(sdir)}\`\n- Push: \`... cli.mjs push ${path.basename(sdir)}\` (dry run), then \`--apply\`.\n`);
  const idx = readIndex(sdir) ?? { version: 2, jira: {}, pulled_at: null, items: {} };
  idx.jira = { ...idx.jira, ...connectFields(jira) };
  writeJson(path.join(root, 'index.json'), idx);
  return { dir: sdir, created, jira: idx.jira };
}

/** Clean `connect` / `init` flags into the index `jira` block. */
export function connectFields(j) {
  const out = {};
  if (j.site) out.site = normalizeSite(j.site);
  if (j.cloudId) out.cloud_id = String(j.cloudId);
  if (j.projectKey) {
    if (!/^[A-Z][A-Z0-9_]+$/.test(j.projectKey)) throw new Error(`project key ${j.projectKey} is not a Jira project key`);
    out.project_key = j.projectKey;
  }
  if (j.boardId !== undefined && j.boardId !== null) out.board_id = Number(j.boardId);
  if (j.sprintId !== undefined && j.sprintId !== null) out.sprint_id = Number(j.sprintId);
  if (j.sprintName) out.sprint_name = String(j.sprintName);
  return out;
}

function nextSeq(dir) {
  let n = 0;
  try {
    for (const e of fs.readdirSync(dir)) {
      const m = /^(\d+)-/.exec(e);
      if (m) n = Math.max(n, Number(m[1]));
    }
  } catch {
    // empty dir
  }
  return String(n + 1).padStart(2, '0');
}

/**
 * New card from a template, placed last under its parent.
 *
 * @param {string} dir sprint dir
 * @param {'epic'|'story'|'subtask'} kind
 * @param {{ title: string, parent?: string, points?: number, labels?: string[], rand?: () => string }} o
 */
export function newCard(dir, kind, o) {
  if (!['epic', 'story', 'subtask'].includes(kind)) throw new Error('kind must be epic, story or subtask');
  if (!o.title) throw new Error('--title is required');
  const root = cardsRoot(dir);
  const tree = loadTree(dir);
  const idx = readIndex(dir) ?? {};
  let parent = null;
  if (kind !== 'epic') {
    parent = tree.all.find((c) => c.meta.local_id === o.parent || c.meta.jira_key === o.parent || c.folder === o.parent);
    if (!parent) throw new Error(`--parent ${o.parent ?? '(missing)'} is not a card (use its local_id, Jira key or folder)`);
    if (kind === 'story' && parent.kind !== 'epic') throw new Error('a story goes under an epic');
    if (kind === 'subtask' && parent.kind !== 'story') throw new Error('a subtask goes under a story');
  }
  const localId = `loc-${(o.rand ?? (() => crypto.randomBytes(4).toString('hex')))()}`;
  const base = kind === 'epic' ? root : kind === 'story' ? parent.folderAbs : path.join(parent.folderAbs, 'subtasks');
  const seq = nextSeq(base);
  const folder = path.join(base, kind === 'epic' ? `${seq}-epic-LOCAL-${slugify(o.title)}` : kind === 'story' ? `${seq}-story-LOCAL-${slugify(o.title)}` : `${seq}-LOCAL-${slugify(o.title)}`);
  const meta = {
    local_id: localId,
    jira_key: null,
    jira_id: null,
    parent_local_id: parent?.meta.local_id ?? null,
    parent_jira_key: parent?.meta.jira_key ?? null,
    key: null,
    type: { epic: 'Epic', story: 'Story', subtask: 'Sub-task' }[kind],
    parent: parent?.meta.jira_key ?? null,
    summary: o.title,
    status: 'To Do',
    status_category: 'new',
    story_points: kind === 'epic' ? null : (o.points ?? (kind === 'story' ? 3 : null)),
    labels: o.labels ?? [],
    sprint: kind === 'story' ? (idx.jira?.sprint_name ?? null) : null,
    attachments: [],
    order: 9999,
  };
  writeText(path.join(folder, `${kind}.local.md`), renderCard(meta, TEMPLATES[kind]));
  // Renumber so the new card takes the next number with no gaps.
  const t2 = loadTree(dir);
  const changed = new Set(renumber(t2));
  for (const c of t2.all) {
    if (!changed.has(c.folder) || !c.hasLocal) continue;
    const body = fs.readFileSync(c.localPath, 'utf8');
    const { body: b } = parseBody(body);
    writeText(c.localPath, renderCard(c.meta, b));
  }
  assignIds(dir);
  return { local_id: localId, folder: path.relative(root, folder).split(path.sep).join('/') };
}

function parseBody(text) {
  const end = text.indexOf('\n---\n', 3);
  return { body: end === -1 ? text : text.slice(end + 5).replace(/^\n+/, '') };
}

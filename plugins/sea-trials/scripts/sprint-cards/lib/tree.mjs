/**
 * Read the card tree of a sprint folder.
 *
 *   <sprint>/compare/NN-epic-<KEY>-<slug>/epic.local.md
 *   <sprint>/compare/NN-epic-.../NN-story-<KEY>-<slug>/story.local.md
 *   <sprint>/compare/NN-epic-.../NN-story-.../subtasks/NN-<KEY>-<slug>/subtask.local.md
 *
 * Each card folder may also hold `<kind>.jira.md` (read-only Jira copy)
 * and `images/manifest.json`. Folders starting with `_` or `.` are not
 * cards (`_unmatched_local/` is reported separately).
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCard } from './frontmatter.mjs';

export const KINDS = ['epic', 'story', 'subtask'];
export const CARDS_DIR = 'compare';

/** Resolve the cards root from a sprint dir or a cards dir. */
export function cardsRoot(dir) {
  const abs = path.resolve(dir);
  if (path.basename(abs) === CARDS_DIR) return abs;
  return path.join(abs, CARDS_DIR);
}

/** Sprint dir (parent of compare/). */
export function sprintDir(dir) {
  const root = cardsRoot(dir);
  return path.dirname(root);
}

function listDirs(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('_'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  } catch {
    return [];
  }
}

function readIf(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @typedef {object} Card
 * @property {'epic'|'story'|'subtask'} kind
 * @property {string} folder  relative to the cards root, `/` separated
 * @property {string} localPath absolute path of `<kind>.local.md`
 * @property {string} jiraPath  absolute path of `<kind>.jira.md`
 * @property {Record<string, any>} meta
 * @property {string} body
 * @property {Record<string, any>|null} jiraMeta
 * @property {string|null} jiraBody
 * @property {Array<object>} images  entries of images/manifest.json
 * @property {Card|null} parentCard
 * @property {Card[]} children
 * @property {number} folderSeq  1-based position among sibling folders
 */

function loadCard(root, folderAbs, kind, parentCard, folderSeq) {
  const localPath = path.join(folderAbs, `${kind}.local.md`);
  const jiraPath = path.join(folderAbs, `${kind}.jira.md`);
  const lt = readIf(localPath);
  const jt = readIf(jiraPath);
  if (lt === null && jt === null) return null;
  const local = lt === null ? null : parseCard(lt);
  const jira = jt === null ? null : parseCard(jt);
  return {
    kind,
    folder: path.relative(root, folderAbs).split(path.sep).join('/'),
    folderAbs,
    localPath,
    jiraPath,
    hasLocal: lt !== null,
    meta: local ? local.meta : { ...(jira?.meta ?? {}) },
    body: local ? local.body : '',
    jiraMeta: jira ? jira.meta : null,
    jiraBody: jira ? jira.body : null,
    images: readJson(path.join(folderAbs, 'images', 'manifest.json'), []),
    parentCard,
    children: [],
    folderSeq,
  };
}

/**
 * Load every card under the cards root, in folder order.
 *
 * @param {string} dir sprint dir or cards dir
 * @returns {{ root: string, epics: Card[], all: Card[], unmatched: string[] }}
 */
export function loadTree(dir) {
  const root = cardsRoot(dir);
  const epics = [];
  const all = [];
  listDirs(root).forEach((eName, ei) => {
    const eAbs = path.join(root, eName);
    const epic = loadCard(root, eAbs, 'epic', null, ei + 1);
    if (!epic) return;
    epics.push(epic);
    all.push(epic);
    listDirs(eAbs)
      .filter((n) => n !== 'images' && n !== 'subtasks')
      .forEach((sName, si) => {
        const sAbs = path.join(eAbs, sName);
        const story = loadCard(root, sAbs, 'story', epic, si + 1);
        if (!story) return;
        epic.children.push(story);
        all.push(story);
        listDirs(path.join(sAbs, 'subtasks')).forEach((tName, ti) => {
          const st = loadCard(root, path.join(sAbs, 'subtasks', tName), 'subtask', story, ti + 1);
          if (!st) return;
          story.children.push(st);
          all.push(st);
        });
      });
  });
  const unmatchedDir = path.join(root, '_unmatched_local');
  const unmatched = fs.existsSync(unmatchedDir) ? listDirs(unmatchedDir) : [];
  return { root, epics, all, unmatched };
}

/** Sort siblings by `order`, then plan number, then folder. */
export function bySiblingOrder(a, b) {
  const oa = Number.isInteger(a.meta.order) ? a.meta.order : 1e6 + a.folderSeq;
  const ob = Number.isInteger(b.meta.order) ? b.meta.order : 1e6 + b.folderSeq;
  if (oa !== ob) return oa - ob;
  return a.folder.localeCompare(b.folder, 'en', { numeric: true });
}

export function readIndex(dir) {
  const idx = readJson(path.join(cardsRoot(dir), 'index.json'), null);
  // plan.json is the viewer's settings file. Fill what index.json lacks.
  const pj = readJson(path.join(sprintDir(dir), 'plan.json'), null)?.jira;
  if (!idx || !pj || typeof pj !== 'object') return idx;
  const jira = { ...(idx.jira ?? {}) };
  const take = (to, ...from) => { if (jira[to] == null) for (const f of from) if (pj[f] != null && pj[f] !== '') { jira[to] = pj[f]; break; } };
  take('site', 'site');
  take('cloud_id', 'cloud_id', 'cloudId');
  take('project_key', 'project', 'projectKey');
  take('board_id', 'board_id', 'boardId');
  take('sprint_id', 'sprint_id', 'sprintId');
  take('sprint_name', 'sprint_name', 'sprintName');
  idx.jira = jira;
  const fid = { ...(idx.field_ids ?? {}) };
  if (!fid.storyPoints && pj.story_points_field) fid.storyPoints = pj.story_points_field;
  if (!fid.sprint && pj.sprint_field) fid.sprint = pj.sprint_field;
  if (Object.keys(fid).length) idx.field_ids = fid;
  return idx;
}

/**
 * Mirror the Jira settings into plan.json so sprint-plan-viewer reads the
 * same site, project, board, sprint and field ids. Other keys are kept.
 */
export function writePlanJson(dir, jira = {}, fieldIds = {}) {
  const p = path.join(sprintDir(dir), 'plan.json');
  const pj = readJson(p, null) ?? {};
  const cur = pj.jira && typeof pj.jira === 'object' ? pj.jira : {};
  const next = { ...cur };
  const put = (k, v) => { if (v !== undefined && v !== null && v !== '') next[k] = v; };
  put('site', jira.site);
  put('cloud_id', jira.cloud_id);
  put('project', jira.project_key);
  put('board_id', jira.board_id);
  put('sprint_id', jira.sprint_id);
  put('sprint_name', jira.sprint_name);
  put('story_points_field', fieldIds.storyPoints);
  put('sprint_field', fieldIds.sprint);
  if (!pj.title && jira.sprint_name) pj.title = jira.sprint_name;
  if (JSON.stringify(next) === JSON.stringify(cur) && fs.existsSync(p)) return p;
  pj.jira = next;
  writeJson(p, pj);
  return p;
}

export function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

/** Write a text file atomically. */
export function writeText(p, text) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

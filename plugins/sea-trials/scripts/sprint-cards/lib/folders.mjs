/**
 * Rename card folders that still say `LOCAL` after the card got a Jira key.
 *
 * The sprint-plan-viewer treats any card whose path contains `LOCAL` as
 * local-only: it hides the card's Jira key and sprint. So once `record`,
 * `push --apply` or a pull gives a card its key, its folder (and the
 * folders of its children, which sit under it) must carry the key.
 *
 * Children are renamed before parents so every path stays valid while
 * the renames run. A dry run by default; nothing is renamed without
 * `apply: true`. Identity lives in the front matter, so a rename never
 * changes a card's `local_id`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { cardsRoot, loadTree } from './tree.mjs';

const KEY_RE = /^[A-Z][A-Z0-9_]*-\d+$/;
const LOCAL_IN_NAME = /^(\d{2}-(?:epic-|story-)?)LOCAL(?:-[0-9.]+)?(?=-)/;

/**
 * @param {string} dir sprint dir or cards dir
 * @returns {{ renames: Array<{ from: string, to: string, key: string }>, skipped: Array<{ folder: string, reason: string }> }}
 */
export function planFolderRenames(dir) {
  const tree = loadTree(dir);
  const renames = [];
  const skipped = [];
  for (const c of tree.all) {
    const key = c.meta.jira_key ?? null;
    if (!key || !KEY_RE.test(String(key))) continue;
    const name = path.posix.basename(c.folder);
    if (!LOCAL_IN_NAME.test(name)) continue;
    const next = name.replace(LOCAL_IN_NAME, `$1${key}`);
    const parent = path.posix.dirname(c.folder);
    const to = parent === '.' ? next : `${parent}/${next}`;
    if (fs.existsSync(path.join(path.dirname(c.folderAbs), next))) {
      skipped.push({ folder: c.folder, reason: `${to} already exists` });
      continue;
    }
    renames.push({ from: c.folder, to, key: String(key) });
  }
  // Deepest first, so a parent rename never moves a folder still to be renamed.
  renames.sort((a, b) => b.from.split('/').length - a.from.split('/').length || a.from.localeCompare(b.from));
  return { renames, skipped };
}

/** Plan, then rename when `apply` is set. */
export function renameLocalFolders(dir, { apply = false } = {}) {
  const plan = planFolderRenames(dir);
  if (apply) {
    const root = cardsRoot(dir);
    for (const r of plan.renames) {
      fs.renameSync(path.join(root, r.from), path.join(path.dirname(path.join(root, r.from)), path.posix.basename(r.to)));
    }
  }
  return { ...plan, applied: apply };
}

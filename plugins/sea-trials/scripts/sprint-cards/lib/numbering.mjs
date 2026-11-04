/**
 * Sibling order and plan numbers.
 *
 *   - `order` is the 1-based position under the parent. Drag-reorder in
 *     the viewer sets it (and `_order_custom: true`).
 *   - Stories under an epic are numbered 1..n with no gaps: the summary
 *     starts with `User Story N: ` and `plan_number` is `'N'`.
 *   - Subtasks under story N are `'N.M'` in order. Subtask and epic
 *     titles carry no number.
 *   - `jira_order` is the position Jira had at the last pull; it is only
 *     filled when missing.
 */
import { bySiblingOrder } from './tree.mjs';

export const STORY_PREFIX_RE = /^User Story\s+\d+\s*:\s*/i;

/** Remove a leading `User Story N:` from a title. */
export function stripStoryPrefix(summary) {
  return String(summary ?? '').replace(STORY_PREFIX_RE, '');
}

function isDone(c) {
  const sc = (c.jiraMeta?.status_category ?? c.meta.status_category ?? '').toLowerCase();
  return sc === 'done';
}

/**
 * Pure step: renumber a tree in place (meta objects are mutated).
 * Done cards keep their Jira title (rule: Done cards keep their Jira text),
 * but still take a position so numbers have no gaps.
 *
 * @param {{ epics: import('./tree.mjs').Card[] }} tree
 * @returns {string[]} folders whose meta changed
 */
export function renumber(tree) {
  const changed = new Set();
  const set = (c, k, v) => {
    if (c.meta[k] !== v) {
      c.meta[k] = v;
      changed.add(c.folder);
    }
  };
  const epics = [...tree.epics].sort(bySiblingOrder);
  epics.forEach((e, ei) => {
    set(e, 'order', ei + 1);
    if (e.meta.jira_order === undefined || e.meta.jira_order === null) set(e, 'jira_order', ei + 1);
    if (!e.meta.plan_number) set(e, 'plan_number', `E${ei + 1}`);
    const stories = [...e.children].sort(bySiblingOrder);
    stories.forEach((s, si) => {
      const n = si + 1;
      set(s, 'order', n);
      set(s, 'plan_number', String(n));
      if (s.meta.jira_order === undefined || s.meta.jira_order === null) set(s, 'jira_order', n);
      if (!isDone(s)) set(s, 'summary', `User Story ${n}: ${stripStoryPrefix(s.meta.summary)}`);
      const subs = [...s.children].sort(bySiblingOrder);
      subs.forEach((t, ti) => {
        set(t, 'order', ti + 1);
        set(t, 'plan_number', `${n}.${ti + 1}`);
        if (t.meta.jira_order === undefined || t.meta.jira_order === null) set(t, 'jira_order', ti + 1);
      });
    });
  });
  return [...changed];
}

/**
 * Report numbering problems without changing anything.
 *
 * @returns {{ gaps: object[], duplicates: object[], parent_mismatches: object[], title_mismatches: object[] }}
 */
export function auditNumbering(tree) {
  const gaps = [];
  const duplicates = [];
  const parentMismatches = [];
  const titleMismatches = [];
  for (const e of tree.epics) {
    const stories = [...e.children].sort(bySiblingOrder);
    const nums = stories.map((s) => {
      const m = /^User Story\s+(\d+)\s*:/i.exec(String(s.meta.summary ?? ''));
      return m ? Number(m[1]) : null;
    });
    const seen = new Map();
    nums.forEach((n, i) => {
      const s = stories[i];
      if (n === null) {
        // A Done story keeps its Jira title and still holds its place.
        if (isDone(s)) {
          if (!seen.has(i + 1)) seen.set(i + 1, s.folder);
          return;
        }
        titleMismatches.push({ folder: s.folder, summary: s.meta.summary, note: 'story title does not start with "User Story N: "' });
        return;
      }
      if (seen.has(n)) duplicates.push({ epic: e.folder, number: n, folders: [seen.get(n), s.folder] });
      else seen.set(n, s.folder);
    });
    const present = [...seen.keys()].sort((a, b) => a - b);
    for (let k = 1; k <= (present.at(-1) ?? 0); k += 1) {
      if (!seen.has(k)) gaps.push({ epic: e.folder, missing: `User Story ${k}` });
    }
    for (const s of stories) {
      if (s.meta.parent_local_id && s.meta.parent_local_id !== e.meta.local_id) {
        parentMismatches.push({ folder: s.folder, parent_local_id: s.meta.parent_local_id, expected: e.meta.local_id });
      }
      const sn = String(s.meta.plan_number ?? '');
      [...s.children].sort(bySiblingOrder).forEach((t, ti) => {
        if (t.meta.parent_local_id && t.meta.parent_local_id !== s.meta.local_id) {
          parentMismatches.push({ folder: t.folder, parent_local_id: t.meta.parent_local_id, expected: s.meta.local_id });
        }
        const want = `${sn}.${ti + 1}`;
        if (sn && t.meta.plan_number && String(t.meta.plan_number) !== want) {
          gaps.push({ story: s.folder, folder: t.folder, plan_number: t.meta.plan_number, expected: want });
        }
      });
    }
  }
  return { gaps, duplicates, parent_mismatches: parentMismatches, title_mismatches: titleMismatches };
}

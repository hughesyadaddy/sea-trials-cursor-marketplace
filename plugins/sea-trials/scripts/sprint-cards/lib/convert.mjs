/** Jira issue JSON (REST or MCP getJiraIssue shape) to card front matter + body. */
import { adfToMarkdown } from '../../sprint/adf-to-md.mjs';
import { normalizeBody } from './frontmatter.mjs';

const MEDIA = new Set(['media', 'mediaSingle', 'mediaGroup', 'mediaInline']);

/** Drop embedded images: the card keeps them as attachments (rule 7). */
export function stripMedia(node) {
  if (Array.isArray(node)) return node.filter((n) => !(n && MEDIA.has(n.type))).map(stripMedia);
  if (node && typeof node === 'object') {
    const out = { ...node };
    if (Array.isArray(node.content)) out.content = stripMedia(node.content);
    return out;
  }
  return node;
}

/** Description (ADF object, ADF JSON string or markdown string) to a card body. */
export function descriptionToBody(desc) {
  if (!desc) return '';
  let d = desc;
  if (typeof d === 'string') {
    const t = d.trim();
    if (t.startsWith('{')) {
      try {
        d = JSON.parse(t);
      } catch {
        return normalizeBody(d);
      }
    } else return normalizeBody(d.replace(/^##\s+Description\s*\n+/, ''));
  }
  const md = adfToMarkdown(stripMedia(d), { warn: () => {} });
  return normalizeBody(md.replace(/^##\s+Description\s*\n+/, ''));
}

/** Sprint name to show for an issue: the tracked sprint when it is one of them, else the open one. */
export function sprintNameOf(sprints, trackedId) {
  const list = Array.isArray(sprints) ? sprints : [];
  if (!list.length) return null;
  const tracked = list.find((s) => String(s.id) === String(trackedId));
  if (tracked) return tracked.name;
  const open = list.find((s) => s.state === 'active') ?? list.find((s) => s.state === 'future');
  return (open ?? list.at(-1)).name ?? null;
}

/**
 * @param {object} issue `{ id, key, fields }`
 * @param {{ storyPoints?: string|null, sprint?: string|null }} fieldIds
 * @param {{ sprintId?: number|string|null, attachments?: Array<{filename: string, sha256: string}> }} [o]
 */
export function issueToCard(issue, fieldIds = {}, o = {}) {
  const f = issue.fields ?? {};
  const sp = fieldIds.storyPoints ? f[fieldIds.storyPoints] : null;
  const type = f.issuetype?.name ?? null;
  const meta = {
    jira_key: issue.key,
    jira_id: issue.id === undefined || issue.id === null ? null : String(issue.id),
    parent_jira_key: f.parent?.key ?? null,
    key: issue.key,
    type,
    parent: f.parent?.key ?? null,
    summary: f.summary ?? '',
    status: f.status?.name ?? null,
    status_category: f.status?.statusCategory?.key ?? null,
    story_points: sp === null || sp === undefined ? null : Number.isInteger(sp) ? sp : Number(sp),
    labels: [...(f.labels ?? [])].sort(),
    sprint: fieldIds.sprint ? sprintNameOf(f[fieldIds.sprint], o.sprintId) : null,
    attachments: (o.attachments ?? []).map((a) => ({ filename: a.filename, sha256: a.sha256 })),
  };
  return { meta, body: descriptionToBody(f.description), updated: f.updated ?? null };
}

/** Lower-case slug for folder names. */
export function slugify(s, max = 60) {
  return String(s ?? '')
    .replace(/^User Story\s+\d+\s*:\s*/i, 'user-story-')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/, '') || 'card';
}

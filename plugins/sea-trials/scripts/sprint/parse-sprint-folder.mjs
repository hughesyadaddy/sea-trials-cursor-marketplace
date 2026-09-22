#!/usr/bin/env node
/**
 * Sprint folder → JSON payload for the Jira uploader.
 *
 * Folder convention (`sprint_planning/<sprint>/`):
 *   00-epic.md            any file starting with `00` and containing `epic`
 *   01-us1-<slug>.md      story files: NN[-letter]-usN[letter]-slug.md
 *   NN_<slug>.md          legacy story files (id = NN)
 *   sprint.json           optional Jira config (projectKey, epicKey, ...)
 *   jira_state.json       optional, written by the uploader (keys + hashes)
 *
 * Story file: `# Title`, optional metadata lines right after the title
 * (`**Jira:** STD-1 | **SP:** 5`, `**Blocked by:** US3`, `**Labels:** a`,
 * `**Assignee:** name`, `**Kind:** verify`), description, then subtasks
 * as `## Subtask 1.1: Title` or `### Subtask 1.1: Title` under
 * `## Subtasks`. Paths listed under `## Files to touch` (story) or
 * `**Files to change**` (subtask) are exposed as `files`.
 *
 * Usage:
 *   node parse-sprint-folder.mjs <dir> [--out payload.json] [--lint] [--diff]
 *
 * `--lint` prints dev-ready card violations and exits 1 on any error.
 * `--diff` prints create/update/unchanged against jira_state.json.
 * Without either flag the payload JSON is printed (or written to --out).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const EPIC_FILE_RE = /^00.*epic.*\.md$/i;
const STORY_FILE_RE = /^\d{2}(?:-[a-z])?-us(\d+[a-z]?)-.*\.md$/i;
const LEGACY_FILE_RE = /^(\d{2})_.+\.md$/;
const META_LINE_RE = /^\*\*[A-Za-z][\w ]*:\*\*/;
const KNOWN_META = new Set([
  'jira',
  'jira key',
  'sp',
  'story points',
  'points',
  'blocked by',
  'labels',
  'assignee',
  'kind',
]);
// `## Files to touch`, `## Files`, `## Touches` headings and the bold
// `**Files to change**` label used inside subtasks.
const FILES_SECTION_RE =
  /^(?:#{2,6}\s+|\*\*)(files(?:\s+to\s+(?:touch|change))?|touches)(?:\*\*)?\s*:?\s*$/i;
const BOLD_LABEL_RE = /^\*\*[^*]+\*\*\s*:?\s*$/;
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/;
const CODE_SPAN_RE = /`([^`\n]+)`/;
const PATHISH_RE = /^(?:\.{0,2}\/)?[\w@.-]+(?:\/[\w@.-]+)*\/?$/;
const SUBTASK_H2_RE = /^##\s+Subtask\s+([\w.]+?):\s*(.*?)\s*$/i;
const SUBTASK_H3_RE = /^###\s+Subtask\s+([\w.]+?):\s*(.*?)\s*$/i;
const SUBTASKS_HEADING_RE = /^##\s+Subtasks?\s*$/i;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*$/;
const TASK_ITEM_RE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const OPEN_TASK_RE = /^\s*[-*+]\s+\[ \]\s+\S/;
const AC_HEADING_RE = /^(#{2,6})\s+(acceptance criteria|ac)\s*$/i;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

// `[x](foo.md)` links, or bare `docs/plan/foo.md` style paths.
const MD_LINK_RE = new RegExp(
  '\\]\\([^)\\s]*\\.md(?:#[^)\\s]*)?\\)' +
    '|(?:^|[\\s(`\'"])(?:\\.{1,2}/)?(?:[\\w.-]+/)+[\\w.-]+\\.md\\b',
);

const VAGUE_RULES = [
  [/\bmaybe\b/i, 'maybe'],
  [/\bconsider\b/i, 'consider'],
  [/\bmight want to\b/i, 'might want to'],
  [/\bexplore whether\b/i, 'explore whether'],
  [/\binvestigate if\b/i, 'investigate if'],
  [/\bTBD\b/, 'TBD'],
  [/TODO:/, 'TODO:'],
  [/\blook into\b/i, 'look into'],
  [/^\s*[-*+]\s+\[[ xX]\]\s+research\b/i, 'Research (task item)'],
];

const AI_TELL_RULES = [
  [/\bClaude\b/, 'Claude'],
  [/\bCursor\b/, 'Cursor'],
  [/\bChatGPT\b/i, 'ChatGPT'],
  [/\bCopilot\b/, 'Copilot'],
  [/\bAs an AI\b/i, 'As an AI'],
  [/\bLLMs?\b/, 'LLM'],
  [/\bsubagents?\b/i, 'subagent'],
  [/\bTask\(/, 'Task('],
];

const MAX_TASK_ITEM_CHARS = 200;
const MAX_STORY_DESCRIPTION_CHARS = 6000;

// ===========================================================================
// TEXT HELPERS
// ===========================================================================

/** @param {string} text */
function normalize(text) {
  return (text ?? '').replace(/\r\n?/g, '\n');
}

/** sha256 of trimmed, LF-normalized markdown. */
export function contentHash(markdown) {
  return createHash('sha256')
    .update(normalize(markdown).trim(), 'utf8')
    .digest('hex');
}

/** Strip a `US`/`us` prefix so `US3` → `3`, `us3a` → `3a`. */
function normalizeStoryId(raw) {
  return raw.trim().replace(/^us/i, '');
}

/** Parse `**Key:** value | **Key2:** value2` into a key→value map. */
function parseMetaLine(line) {
  const out = {};
  const re = /\*\*([A-Za-z][\w ]*?):\*\*\s*([^|]*)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    out[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return out;
}

function splitList(value) {
  return value
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A metadata line is bold-key/value pairs whose keys are ALL known, so a
 * `**Goal:** ...` opener stays in the description.
 */
function metaOf(line) {
  const t = line.trim();
  if (!META_LINE_RE.test(t)) return null;
  const parsed = parseMetaLine(t);
  const keys = Object.keys(parsed);
  if (!keys.length || !keys.every((k) => KNOWN_META.has(k))) return null;
  return parsed;
}

/**
 * Pull the metadata block that directly follows a title (blank lines
 * allowed in between). Returns the metadata and the remaining lines.
 */
function extractMeta(lines) {
  const meta = {};
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  for (;;) {
    const parsed = i < lines.length ? metaOf(lines[i]) : null;
    if (!parsed) break;
    Object.assign(meta, parsed);
    i += 1;
  }
  const rest = Object.keys(meta).length ? lines.slice(i) : lines;
  return { meta, rest };
}

function metaFields(meta) {
  const sp = meta.sp ?? meta['story points'] ?? meta.points;
  const blocked = meta['blocked by'];
  return {
    jiraKey: meta.jira ?? meta['jira key'] ?? null,
    storyPoints: sp !== undefined && sp !== '' ? Number(sp) : null,
    blockedBy: blocked ? splitList(blocked).map(normalizeStoryId) : [],
    labels: meta.labels ? splitList(meta.labels) : [],
    assignee: meta.assignee ?? null,
    kind: meta.kind ? meta.kind.toLowerCase() : null,
  };
}

/**
 * Paths listed under a files section (`## Files to touch`, `## Files`,
 * `## Touches`, or the bold `**Files to change**` label inside a
 * subtask). Each list item contributes its first code span, or its
 * first token when it has no code span and looks like a path. The
 * section ends at the next heading or bold label. Fenced code is
 * ignored. Order is kept; duplicates are dropped.
 *
 * @param {string} text story or subtask markdown
 * @returns {string[]}
 */
export function extractFiles(text) {
  const out = [];
  let inFence = false;
  let inSection = false;
  for (const raw of normalize(text).split('\n')) {
    if (FENCE_RE.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw.trim();
    if (FILES_SECTION_RE.test(line)) {
      inSection = true;
      continue;
    }
    if (!inSection) continue;
    if (HEADING_RE.test(line) || BOLD_LABEL_RE.test(line)) {
      inSection = false;
      continue;
    }
    const item = LIST_ITEM_RE.exec(line);
    if (!item) continue;
    const code = CODE_SPAN_RE.exec(item[1]);
    let candidate = code ? code[1].trim() : item[1].split(/\s+/)[0];
    candidate = candidate.replace(/^\(|[),;:]+$/g, '');
    if (!candidate || !PATHISH_RE.test(candidate)) continue;
    if (!code && !candidate.includes('/') && !/\.\w+$/.test(candidate)) {
      continue;
    }
    if (!out.includes(candidate)) out.push(candidate);
  }
  return out;
}

/** Title from the first H1 line; falls back to `fallback`. */
function splitTitle(lines, fallback) {
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  const m = /^#\s+(.*?)\s*$/.exec(lines[i] ?? '');
  if (!m) return { title: fallback, rest: lines };
  return { title: m[1].trim(), rest: lines.slice(i + 1) };
}

function slugFromFile(file) {
  return path
    .basename(file, '.md')
    .replace(/^\d{2}(?:-[a-z])?[-_](?:us\d+[a-z]?-)?/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

// ===========================================================================
// STORY PARSING
// ===========================================================================

function subtaskHeader(line) {
  const m = SUBTASK_H2_RE.exec(line) ?? SUBTASK_H3_RE.exec(line);
  if (!m) return null;
  return { id: m[1], title: m[2], level: line.startsWith('###') ? 3 : 2 };
}

/**
 * Parse one story markdown file.
 *
 * @param {string} text
 * @param {{ id: string, file: string }} info
 */
export function parseStory(text, info) {
  const lines = normalize(text).split('\n');
  const { title, rest } = splitTitle(lines, slugFromFile(info.file));
  const { meta, rest: body } = extractMeta(rest);

  const description = [];
  const subtasks = [];
  let current = null;
  let inFence = false;
  let inSubtasksSection = false;

  for (const line of body) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (!inFence) {
      const header = subtaskHeader(line);
      if (header) {
        current = { ...header, lines: [] };
        subtasks.push(current);
        continue;
      }
      if (SUBTASKS_HEADING_RE.test(line.trim())) {
        inSubtasksSection = true;
        current = null;
        continue;
      }
      const h = HEADING_RE.exec(line);
      if (h && current && h[1].length <= current.level) {
        current = null;
        inSubtasksSection = false;
      }
    }
    if (current) current.lines.push(line);
    else if (!inSubtasksSection) description.push(line);
  }

  const desc = description.join('\n').trim();
  return {
    id: info.id,
    file: info.file,
    summary: title,
    description: desc,
    hash: contentHash(desc),
    ...metaFields(meta),
    files: extractFiles(desc),
    subtasks: subtasks.map((s) => {
      const { meta: sm, rest: sBody } = extractMeta(s.lines);
      const sDesc = sBody.join('\n').trim();
      const fields = metaFields(sm);
      return {
        id: s.id,
        title: s.title,
        summary: s.title,
        description: sDesc,
        hash: contentHash(sDesc),
        storyPoints: fields.storyPoints,
        blockedBy: fields.blockedBy,
        files: extractFiles(sDesc),
      };
    }),
  };
}

/**
 * Parse the epic file. Summary is the H1 text without a leading `Epic:`.
 *
 * @param {string} text
 * @param {string} file
 */
export function parseEpic(text, file) {
  const lines = normalize(text).split('\n');
  const { title, rest } = splitTitle(lines, slugFromFile(file));
  const { rest: body } = extractMeta(rest);
  const description = body.join('\n').trim();
  return {
    summary: title.replace(/^epic\s*:\s*/i, '').trim(),
    description,
    hash: contentHash(description),
    file,
  };
}

/** Story id from a filename, or null when it is not a story file. */
export function storyIdFromFile(file) {
  if (EPIC_FILE_RE.test(file)) return null;
  const us = STORY_FILE_RE.exec(file);
  if (us) return normalizeStoryId(us[1]);
  const legacy = LEGACY_FILE_RE.exec(file);
  if (legacy) return legacy[1];
  return null;
}

function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Load a sprint folder into a structured payload.
 *
 * @param {string} dir
 * @returns {{
 *   dir: string,
 *   config: object,
 *   epic: { summary: string, description: string, file: string }|null,
 *   stories: object[],
 *   state: { epic?: object, stories: object },
 * }}
 */
export function loadSprint(dir) {
  const entries = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  const epicFile = entries.find((f) => EPIC_FILE_RE.test(f));
  const epic = epicFile
    ? parseEpic(fs.readFileSync(path.join(dir, epicFile), 'utf8'), epicFile)
    : null;

  const stories = [];
  for (const file of entries) {
    const id = storyIdFromFile(file);
    if (id === null) continue;
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    stories.push(parseStory(text, { id, file }));
  }

  const config = readJsonIfExists(path.join(dir, 'sprint.json')) ?? {};
  const state = readJsonIfExists(path.join(dir, 'jira_state.json')) ?? {};
  state.stories ??= {};

  return { dir, config, epic, stories, state };
}

/**
 * Compare card hashes with `jira_state.json` so the uploader only touches
 * cards whose markdown changed.
 *
 * @param {ReturnType<typeof loadSprint>} sprint
 * @returns {{ create: object[], update: object[], unchanged: object[] }}
 */
export function diffAgainstState(sprint) {
  const out = { create: [], update: [], unchanged: [] };
  const place = (entry, saved, hash) => {
    if (!saved?.key) out.create.push(entry);
    else if (saved.hash !== hash) out.update.push({ ...entry, key: saved.key });
    else out.unchanged.push({ ...entry, key: saved.key });
  };

  if (sprint.epic) {
    place(
      { kind: 'epic', id: 'epic', summary: sprint.epic.summary },
      sprint.state.epic,
      sprint.epic.hash ?? contentHash(sprint.epic.description),
    );
  }
  for (const story of sprint.stories) {
    const saved = sprint.state.stories?.[story.id];
    place(
      { kind: 'story', id: story.id, summary: story.summary },
      saved,
      story.hash ?? contentHash(story.description),
    );
    for (const sub of story.subtasks) {
      place(
        {
          kind: 'subtask',
          id: sub.id,
          storyId: story.id,
          summary: sub.summary,
        },
        saved?.subtasks?.[sub.id],
        sub.hash ?? contentHash(sub.description),
      );
    }
  }
  return out;
}

// ===========================================================================
// LINT
// ===========================================================================

/** Lines of `text` with fenced code blocks blanked out (keeps numbering). */
function proseLines(text) {
  let inFence = false;
  return normalize(text)
    .split('\n')
    .map((line) => {
      if (FENCE_RE.test(line)) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    });
}

function hasOpenTaskItem(text) {
  return normalize(text)
    .split('\n')
    .some((l) => OPEN_TASK_RE.test(l));
}

/** Body of the acceptance-criteria section, or null when absent. */
function acceptanceSection(description) {
  const lines = proseLines(description);
  let level = 0;
  const out = [];
  for (const line of lines) {
    const ac = AC_HEADING_RE.exec(line.trim());
    if (!level) {
      if (ac) level = ac[1].length;
      continue;
    }
    const h = HEADING_RE.exec(line);
    if (h && h[1].length <= level) break;
    out.push(line);
  }
  return level ? out.join('\n') : null;
}

function snippet(line) {
  const t = line.trim();
  return t.length > 60 ? `${t.slice(0, 57)}...` : t;
}

/** Text rules shared by epic, story and subtask bodies. */
function lintText(text, where, findings) {
  const prose = proseLines(text);
  const all = normalize(text).split('\n');

  prose.forEach((line, i) => {
    if (!line) return;
    if (MD_LINK_RE.test(line)) {
      findings.push({
        level: 'error',
        where,
        message:
          `line ${i + 1}: links to a markdown file ` +
          `(cards must be self-contained): ${snippet(line)}`,
      });
    }
    for (const [re, label] of VAGUE_RULES) {
      if (re.test(line)) {
        findings.push({
          level: 'error',
          where,
          message: `line ${i + 1}: non-actionable "${label}": ${snippet(line)}`,
        });
      }
    }
    const task = TASK_ITEM_RE.exec(line);
    if (task && task[2].length > MAX_TASK_ITEM_CHARS) {
      findings.push({
        level: 'warn',
        where,
        message:
          `line ${i + 1}: task item is ${task[2].length} chars ` +
          `(max ${MAX_TASK_ITEM_CHARS})`,
      });
    }
  });

  all.forEach((line, i) => {
    for (const [re, label] of AI_TELL_RULES) {
      if (re.test(line)) {
        findings.push({
          level: 'error',
          where,
          message: `line ${i + 1}: AI tell "${label}": ${snippet(line)}`,
        });
      }
    }
  });
}

/**
 * Enforce dev-ready card rules.
 *
 * @param {ReturnType<typeof loadSprint>} sprint
 * @returns {Array<{ level: 'error'|'warn', where: string, message: string }>}
 */
export function lintSprint(sprint) {
  const findings = [];

  if (sprint.epic) {
    lintText(sprint.epic.description, `epic (${sprint.epic.file})`, findings);
  }

  for (const story of sprint.stories) {
    const where = `story ${story.id} (${story.file})`;
    lintText(story.description, where, findings);

    const ac = acceptanceSection(story.description);
    if (ac === null) {
      findings.push({
        level: 'error',
        where,
        message: 'missing "## Acceptance criteria" section',
      });
    } else if (!hasOpenTaskItem(ac)) {
      findings.push({
        level: 'error',
        where,
        message: 'acceptance criteria has no "- [ ]" item',
      });
    }

    if (story.description.length > MAX_STORY_DESCRIPTION_CHARS) {
      findings.push({
        level: 'warn',
        where,
        message:
          `description is ${story.description.length} chars ` +
          `(> ${MAX_STORY_DESCRIPTION_CHARS}, hard to read in Jira)`,
      });
    }
    if (story.subtasks.length === 0) {
      findings.push({ level: 'warn', where, message: 'story has no subtasks' });
    }

    for (const sub of story.subtasks) {
      const subWhere = `${where} subtask ${sub.id}`;
      lintText(sub.description, subWhere, findings);
      if (!hasOpenTaskItem(sub.description)) {
        findings.push({
          level: 'error',
          where: subWhere,
          message: 'subtask has no "- [ ]" item',
        });
      }
      if (story.storyPoints !== null && sub.storyPoints === null) {
        findings.push({
          level: 'warn',
          where: subWhere,
          message: 'subtask has no **SP:** while the story has SP',
        });
      }
      proseLines(sub.description).forEach((line, i) => {
        const h = HEADING_RE.exec(line);
        if (h && h[1].length > 3) {
          findings.push({
            level: 'warn',
            where: subWhere,
            message: `line ${i + 1}: heading deeper than H3 inside a subtask`,
          });
        }
      });
    }
  }

  return findings;
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lint' || arg === '--diff') out[arg.slice(2)] = true;
    else if (arg.startsWith('--')) out[arg.slice(2)] = argv[++i];
    else out.positional.push(arg);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.positional[0];
  if (!dir || !fs.existsSync(dir)) {
    process.stderr.write(
      'usage: parse-sprint-folder.mjs <dir> [--out payload.json] ' +
        '[--lint] [--diff]\n',
    );
    process.exit(2);
  }
  const sprint = loadSprint(dir);
  let exitCode = 0;

  if (args.lint) {
    const findings = lintSprint(sprint);
    for (const f of findings) {
      const level = f.level.toUpperCase();
      process.stdout.write(`${level} ${f.where}: ${f.message}\n`);
    }
    const errors = findings.filter((f) => f.level === 'error').length;
    process.stdout.write(
      `lint: ${errors} error(s), ${findings.length - errors} warning(s)\n`,
    );
    if (errors) exitCode = 1;
  }

  if (args.diff) {
    const diff = diffAgainstState(sprint);
    for (const bucket of ['create', 'update', 'unchanged']) {
      process.stdout.write(`${bucket} (${diff[bucket].length}):\n`);
      for (const e of diff[bucket]) {
        const key = e.key ? ` ${e.key}` : '';
        process.stdout.write(`  ${e.kind} ${e.id}${key}: ${e.summary}\n`);
      }
    }
  }

  if (args.out) {
    fs.writeFileSync(args.out, `${JSON.stringify(sprint, null, 2)}\n`);
    process.stderr.write(`wrote ${args.out}\n`);
  } else if (!args.lint && !args.diff) {
    process.stdout.write(`${JSON.stringify(sprint, null, 2)}\n`);
  }

  process.exit(exitCode);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

#!/usr/bin/env node
/**
 * Markdown → Atlassian Document Format (ADF) converter.
 *
 * Produces a `{ type: 'doc', version: 1, content }` document that Jira
 * Cloud accepts for issue descriptions and comments. Only Node stdlib.
 *
 * Usage:
 *   node md-to-adf.mjs <file.md> [--section "## Heading"] [--strip-h1]
 *     [--out file.json] [--pretty]
 *   cat file.md | node md-to-adf.mjs -
 *
 * `--section` keeps only the body under the given heading (exclusive)
 * until the next heading of the same or a higher level. `--strip-h1`
 * removes the first H1 line. The CLI validates the result with
 * `validateAdf` and exits 1 (errors on stderr) when the doc is invalid.
 *
 * Intentional degradations:
 *   - Images `![alt](url)` become a link whose text is the alt (or the
 *     URL). ADF `media` nodes need an uploaded attachment id, which a
 *     converter cannot mint, so a link is the honest fallback.
 *   - HTML other than `<br>` is stripped down to its inner text.
 *   - Setext headings are not supported (a `---` line is a rule).
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const TASK_RE = /^\[([ xX])\]\s+(.*)$/;
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const MENTION_RE = /^@\[([^\]]+)\]\(accountId:([^)\s]+)\)/;
const BR_RE = /^<br\s*\/?>/i;
const AUTOLINK_RE = /^<(https?:\/\/[^\s<>]+)>/;
const HTML_TAG_RE =
  /^(?:<!--[\s\S]*?-->|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>)/;
const BARE_URL_RE = /^https?:\/\/[^\s<>]+/;

const PANEL_TYPES = {
  NOTE: 'info',
  TIP: 'success',
  IMPORTANT: 'note',
  WARNING: 'warning',
  CAUTION: 'error',
};

const PANEL_ALLOWED = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'taskList',
  'codeBlock',
  'rule',
]);

const PANEL_FORBIDDEN = new Set([
  'table',
  'expand',
  'nestedExpand',
  'blockquote',
  'panel',
]);

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
  'date',
  'status',
]);

const LIST_ITEM_FIRST = new Set(['paragraph', 'codeBlock', 'mediaSingle']);
const TASK_STATES = new Set(['TODO', 'DONE']);
const PANEL_TYPE_SET = new Set([
  'info',
  'note',
  'tip',
  'success',
  'warning',
  'error',
]);

// ===========================================================================
// LINE HELPERS
// ===========================================================================

/** @param {string} md */
function normalizeLines(md) {
  return md.replace(/\r\n?/g, '\n').split('\n');
}

/** @param {string[]} lines */
function skipFrontmatter(lines) {
  if (lines[0]?.trim() !== '---') return lines;
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') return lines.slice(i + 1);
  }
  return lines;
}

/** @param {string} line */
function isBlank(line) {
  return line.trim() === '';
}

/** Leading indentation in columns (tab = next multiple of 4). */
function indentWidth(line) {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
  }
  return w;
}

/** Remove up to `cols` columns of leading indentation. */
function stripIndent(line, cols) {
  let w = 0;
  let i = 0;
  while (i < line.length && w < cols) {
    const ch = line[i];
    if (ch === ' ') w += 1;
    else if (ch === '\t') w += 4 - (w % 4);
    else break;
    i += 1;
  }
  return line.slice(i);
}

/** @param {string[]} lines @param {number} i */
function nextNonBlank(lines, i) {
  let j = i;
  while (j < lines.length && isBlank(lines[j])) j += 1;
  return j;
}

// ===========================================================================
// BLOCK DETECTION
// ===========================================================================

/**
 * @returns {{ char: string, len: number, indent: number, lang?: string }
 *   |null}
 */
function fenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  const char = m[2][0];
  const info = m[3].trim();
  if (char === '`' && info.includes('`')) return null;
  const lang = info.split(/\s+/)[0] || undefined;
  return { char, len: m[2].length, indent: m[1].length, lang };
}

function fenceClose(line, open) {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return Boolean(m && m[1][0] === open.char && m[1].length >= open.len);
}

/** @returns {{ level: number, text: string }|null} */
function headingMatch(line) {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
  if (!m) return null;
  const text = (m[2] ?? '').replace(/(?:^|\s+)#+\s*$/, '').trim();
  return { level: m[1].length, text };
}

function isRule(line) {
  return /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(line);
}

function quoteMatch(line) {
  const m = /^ {0,3}> ?(.*)$/.exec(line);
  return m ? m[1] : null;
}

/**
 * @returns {{
 *   indent: number, ordered: boolean, text: string, width: number,
 *   start?: number,
 * }|null}
 */
function matchItem(line) {
  const b = /^(\s*)([-*+])(?:( +)(.*)|$)/.exec(line);
  if (b) {
    const spaces = b[3] ? Math.min(b[3].length, 4) : 1;
    return {
      indent: indentWidth(line),
      ordered: false,
      text: (b[4] ?? '').trim(),
      width: 1 + spaces,
    };
  }
  const o = /^(\s*)(\d{1,9})([.)])(?:( +)(.*)|$)/.exec(line);
  if (o) {
    const spaces = o[4] ? Math.min(o[4].length, 4) : 1;
    return {
      indent: indentWidth(line),
      ordered: true,
      start: Number(o[2]),
      text: (o[5] ?? '').trim(),
      width: o[2].length + 1 + spaces,
    };
  }
  return null;
}

function isTableSep(line) {
  return (
    line.includes('|') &&
    /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/.test(line)
  );
}

/** Split a pipe-table row into trimmed cell strings. */
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i += 1;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  cells.push(cur.trim());
  return cells;
}

function isTableStart(lines, i) {
  const head = lines[i];
  const sep = lines[i + 1];
  if (!head?.includes('|') || sep === undefined || !isTableSep(sep)) {
    return false;
  }
  return splitRow(head).length === splitRow(sep).length;
}

function isBlockStart(lines, i) {
  const line = lines[i];
  return Boolean(
    headingMatch(line) ||
      fenceOpen(line) ||
      isRule(line) ||
      quoteMatch(line) !== null ||
      matchItem(line) ||
      isTableStart(lines, i),
  );
}

// ===========================================================================
// INLINE PARSER
// ===========================================================================

function textNode(text, marks) {
  const node = { type: 'text', text };
  if (marks.length) node.marks = marks.map((m) => structuredClone(m));
  return node;
}

function addMark(marks, mark) {
  return [...marks.filter((m) => m.type !== mark.type), mark];
}

/** `code` may only be combined with `link`. */
function codeMarks(marks) {
  return [...marks.filter((m) => m.type === 'link'), { type: 'code' }];
}

function mergeText(nodes) {
  const out = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (
      node.type === 'text' &&
      prev?.type === 'text' &&
      JSON.stringify(prev.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      prev.text += node.text;
    } else {
      out.push(node);
    }
  }
  return out.filter((n) => n.type !== 'text' || n.text.length > 0);
}

/** `[text](href "title")` starting at `src[i] === '['`. */
function matchLink(src, i) {
  let depth = 0;
  let j = i;
  for (; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  if (j >= src.length || src[j + 1] !== '(') return null;
  const text = src.slice(i + 1, j);
  let k = j + 2;
  let pdepth = 1;
  let dest = '';
  while (k < src.length) {
    const ch = src[k];
    if (ch === '\\') {
      dest += src[k + 1] ?? '';
      k += 2;
      continue;
    }
    if (ch === '(') pdepth += 1;
    else if (ch === ')') {
      pdepth -= 1;
      if (pdepth === 0) break;
    }
    dest += ch;
    k += 1;
  }
  if (k >= src.length) return null;
  const m = /^\s*<?([^\s>]*)>?(?:\s+(?:"([^"]*)"|'([^']*)'))?\s*$/.exec(dest);
  if (!m) return null;
  return { text, href: m[1], title: m[2] ?? m[3], end: k + 1 };
}

function linkMark(href, title) {
  const mark = { type: 'link', attrs: { href } };
  if (title) mark.attrs.title = title;
  return mark;
}

/** Emphasis / strong / strike delimiter run starting at `src[i]`. */
function matchDelim(src, i) {
  const ch = src[i];
  let run = 0;
  while (src[i + run] === ch) run += 1;
  if (ch === '~' && run !== 2) return null;
  const next = src[i + run];
  if (next === undefined || /\s/.test(next)) return null;
  if (ch === '_' && i > 0 && /\w/.test(src[i - 1])) return null;

  const findClose = (len) => {
    const delim = ch.repeat(len);
    let from = i + run;
    for (;;) {
      const pos = src.indexOf(delim, from);
      if (pos < 0) return null;
      const before = src[pos - 1];
      const after = src[pos + len];
      const badRun = after === ch || before === ch;
      const badBefore = /\s/.test(before) || before === '\\';
      const badWord = ch === '_' && after !== undefined && /\w/.test(after);
      if (badRun || badBefore || badWord || pos === i + run) {
        from = pos + 1;
        continue;
      }
      return pos;
    }
  };

  const marksFor = (len) => {
    if (ch === '~') return [{ type: 'strike' }];
    if (len === 1) return [{ type: 'em' }];
    if (len === 2) return [{ type: 'strong' }];
    return [{ type: 'strong' }, { type: 'em' }];
  };

  for (const len of [run, 2, 1]) {
    if (len > run) continue;
    if (ch === '~' && len !== 2) continue;
    const pos = findClose(len);
    if (pos === null) continue;
    return {
      lead: run - len,
      marks: marksFor(len),
      inner: src.slice(i + len + (run - len), pos),
      end: pos + len,
    };
  }
  return null;
}

/** Trim trailing punctuation that is almost never part of a bare URL. */
function trimUrl(url) {
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if ('.,;:!?\'"'.includes(last)) {
      u = u.slice(0, -1);
    } else if (last === ')' && !u.includes('(')) {
      u = u.slice(0, -1);
    } else {
      break;
    }
  }
  return u;
}

/** Strip one enclosing space from a code span (CommonMark). */
function trimCode(code) {
  if (
    code.length >= 2 &&
    code.startsWith(' ') &&
    code.endsWith(' ') &&
    code.trim() !== ''
  ) {
    return code.slice(1, -1);
  }
  return code;
}

/**
 * Parse inline markdown into ADF inline nodes. `\n` in `src` is a
 * hard line break (paragraphs are soft-joined with spaces before this).
 */
function parseInline(src, ctx, marks = []) {
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(textNode(buf, marks));
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const rest = src.slice(i);

    if (ch === '\\' && ESCAPABLE.test(src[i + 1] ?? '')) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (ch === '\n') {
      flush();
      out.push({ type: 'hardBreak' });
      i += 1;
      continue;
    }
    if (ch === '`') {
      const run = /^`+/.exec(rest)[0];
      let pos = src.indexOf(run, i + run.length);
      while (pos >= 0 && src[pos + run.length] === '`') {
        pos = src.indexOf(run, pos + run.length + 1);
      }
      if (pos >= 0) {
        flush();
        const code = trimCode(src.slice(i + run.length, pos));
        if (code) out.push(textNode(code, codeMarks(marks)));
        i = pos + run.length;
      } else {
        buf += run;
        i += run.length;
      }
      continue;
    }
    if (ch === '<') {
      const br = BR_RE.exec(rest);
      if (br) {
        flush();
        out.push({ type: 'hardBreak' });
        i += br[0].length;
        continue;
      }
      const auto = AUTOLINK_RE.exec(rest);
      if (auto) {
        flush();
        out.push(textNode(auto[1], addMark(marks, linkMark(auto[1]))));
        i += auto[0].length;
        continue;
      }
      const tag = HTML_TAG_RE.exec(rest);
      if (tag) {
        i += tag[0].length;
        continue;
      }
    }
    if (ch === '@' && src[i + 1] === '[') {
      const m = MENTION_RE.exec(rest);
      if (m) {
        flush();
        out.push({
          type: 'mention',
          attrs: { id: m[2], text: `@${m[1]}`, userType: 'DEFAULT' },
        });
        i += m[0].length;
        continue;
      }
    }
    if (ch === '!' && src[i + 1] === '[') {
      const link = matchLink(src, i + 1);
      if (link && link.href) {
        flush();
        const label = link.text.trim() || link.href;
        out.push(textNode(label, addMark(marks, linkMark(link.href))));
        i = link.end;
        continue;
      }
    }
    if (ch === '[') {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const inner = link.href
          ? addMark(marks, linkMark(link.href, link.title))
          : marks;
        out.push(...parseInline(link.text, ctx, inner));
        i = link.end;
        continue;
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const d = matchDelim(src, i);
      if (d) {
        buf += ch.repeat(d.lead);
        flush();
        let inner = marks;
        for (const m of d.marks) inner = addMark(inner, m);
        out.push(...parseInline(d.inner, ctx, inner));
        i = d.end;
        continue;
      }
      let run = 0;
      while (src[i + run] === ch) run += 1;
      buf += ch.repeat(run);
      i += run;
      continue;
    }
    if (ch === 'h' && (i === 0 || /[\s(\[]/.test(src[i - 1]))) {
      const m = BARE_URL_RE.exec(rest);
      if (m) {
        const url = trimUrl(m[0]);
        flush();
        out.push(textNode(url, addMark(marks, linkMark(url))));
        i += url.length;
        continue;
      }
    }
    buf += ch;
    i += 1;
  }
  flush();
  const merged = mergeText(out);
  while (merged[merged.length - 1]?.type === 'hardBreak') merged.pop();
  while (merged[0]?.type === 'hardBreak') merged.shift();
  return merged;
}

// ===========================================================================
// BLOCK PARSER
// ===========================================================================

function parseFence(lines, i, open) {
  const body = [];
  let j = i + 1;
  while (j < lines.length && !fenceClose(lines[j], open)) {
    body.push(stripIndent(lines[j], open.indent));
    j += 1;
  }
  const node = { type: 'codeBlock' };
  if (open.lang) node.attrs = { language: open.lang };
  const text = body.join('\n');
  if (text) node.content = [{ type: 'text', text }];
  return { nodes: [node], next: Math.min(j + 1, lines.length) };
}

function headingNode(h, ctx) {
  const node = { type: 'heading', attrs: { level: h.level } };
  const content = parseInline(h.text, ctx);
  if (content.length) node.content = content;
  return node;
}

function parseTable(lines, i, ctx) {
  const header = splitRow(lines[i]);
  const cols = header.length;
  const rows = [header];
  let j = i + 2;
  const endsTable = (line) =>
    isBlank(line) ||
    Boolean(headingMatch(line) || fenceOpen(line)) ||
    isRule(line) ||
    quoteMatch(line) !== null ||
    Boolean(matchItem(line));
  while (j < lines.length && !endsTable(lines[j])) {
    const cells = splitRow(lines[j]);
    while (cells.length < cols) cells.push('');
    rows.push(cells.slice(0, cols));
    j += 1;
  }
  const content = rows.map((cells, r) => ({
    type: 'tableRow',
    content: cells.map((text) =>
      cellNode(r === 0 ? 'tableHeader' : 'tableCell', text, ctx),
    ),
  }));
  return {
    nodes: [
      {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'default' },
        content,
      },
    ],
    next: j,
  };
}

function cellNode(type, text, ctx) {
  const tm = TASK_RE.exec(text);
  if (tm) {
    const inline = parseInline(tm[2], ctx);
    if (inline.length) {
      return {
        type,
        content: [
          {
            type: 'taskList',
            attrs: { localId: ctx.id() },
            content: [taskItem(tm[1], inline, ctx)],
          },
        ],
      };
    }
  }
  const inline = parseInline(text, ctx);
  return {
    type,
    content: [
      inline.length
        ? { type: 'paragraph', content: inline }
        : { type: 'paragraph' },
    ],
  };
}

function taskItem(stateChar, content, ctx) {
  return {
    type: 'taskItem',
    attrs: { localId: ctx.id(), state: stateChar === ' ' ? 'TODO' : 'DONE' },
    content,
  };
}

function parseQuote(lines, i, ctx) {
  const inner = [];
  let j = i;
  while (j < lines.length) {
    const q = quoteMatch(lines[j]);
    if (q === null) break;
    inner.push(q);
    j += 1;
  }
  const alert = inner.length ? ALERT_RE.exec(inner[0].trim()) : null;
  const body = alert ? inner.slice(1) : inner;
  const content = parseBlocks(body, ctx);
  if (!content.length) return { nodes: [], next: j };
  if (alert && content.every((n) => PANEL_ALLOWED.has(n.type))) {
    return {
      nodes: [
        {
          type: 'panel',
          attrs: { panelType: PANEL_TYPES[alert[1].toUpperCase()] },
          content,
        },
      ],
      next: j,
    };
  }
  return { nodes: [{ type: 'blockquote', content }], next: j };
}

function parseParagraph(lines, i, ctx) {
  const parts = [];
  let j = i;
  while (j < lines.length && !isBlank(lines[j])) {
    if (j > i && isBlockStart(lines, j)) break;
    parts.push(lines[j]);
    j += 1;
  }
  const content = parseInline(joinSoft(parts), ctx);
  const blank = content.every((n) => n.type === 'text' && !n.text.trim());
  return {
    nodes: blank ? [] : [{ type: 'paragraph', content }],
    next: j,
  };
}

/** Soft-wrap join; two trailing spaces or a backslash force a hardBreak. */
function joinSoft(parts) {
  let out = '';
  parts.forEach((raw, k) => {
    const last = k === parts.length - 1;
    const hard = !last && /(?: {2,}|\\)$/.test(raw);
    let t = raw.trim();
    if (hard && t.endsWith('\\')) t = t.slice(0, -1).trimEnd();
    out += t;
    if (!last) out += hard ? '\n' : ' ';
  });
  return out.trim();
}

function parseList(lines, i, ctx) {
  const first = matchItem(lines[i]);
  const { indent, ordered } = first;
  const items = [];
  while (i < lines.length) {
    if (isBlank(lines[i])) {
      const j = nextNonBlank(lines, i);
      const nm = j < lines.length ? matchItem(lines[j]) : null;
      if (nm && nm.indent === indent && nm.ordered === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const m = matchItem(lines[i]);
    if (!m || m.indent !== indent || m.ordered !== ordered) break;
    const contentIndent = indent + m.width;
    const body = [m.text];
    i += 1;
    let prevBlank = false;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        const j = nextNonBlank(lines, i);
        if (j >= lines.length || indentWidth(lines[j]) < contentIndent) {
          break;
        }
        while (i < j) {
          body.push('');
          i += 1;
        }
        prevBlank = true;
        continue;
      }
      const w = indentWidth(l);
      if (w > indent) {
        body.push(stripIndent(l, Math.min(w, contentIndent)));
        i += 1;
        prevBlank = false;
        continue;
      }
      if (!prevBlank && !isBlockStart(lines, i)) {
        body.push(l.trim());
        i += 1;
        continue;
      }
      break;
    }
    items.push({ text: m.text, body, start: m.start });
  }
  return { nodes: buildLists(items, ordered, ctx), next: i };
}

/** Split a run of items into task lists and plain lists. */
function buildLists(items, ordered, ctx) {
  const nodes = [];
  let run = [];
  let runTask = null;
  const flush = () => {
    if (!run.length) return;
    if (runTask) nodes.push(...buildTaskList(run, ctx));
    else nodes.push(buildPlainList(run, ordered, ctx));
    run = [];
  };
  for (const item of items) {
    const isTask = TASK_RE.test(item.text);
    if (runTask !== null && isTask !== runTask) flush();
    runTask = isTask;
    run.push(item);
  }
  flush();
  return nodes;
}

function buildPlainList(run, ordered, ctx) {
  const content = run.map((item) => {
    const blocks = parseBlocks(item.body, ctx);
    if (!blocks.length) blocks.push({ type: 'paragraph' });
    if (!LIST_ITEM_FIRST.has(blocks[0].type)) {
      blocks.unshift({ type: 'paragraph' });
    }
    return { type: 'listItem', content: blocks };
  });
  const node = { type: ordered ? 'orderedList' : 'bulletList', content };
  if (ordered && run[0].start !== 1) node.attrs = { order: run[0].start };
  return node;
}

/**
 * taskItem content is inline-only, so any block nested under a task item
 * (a nested task list, a bullet list, a code block) is hoisted to a
 * sibling after the taskList. A nested taskList may not be the first
 * child of a taskList, so flattening one level is the safe shape.
 */
function buildTaskList(run, ctx) {
  const listId = ctx.id();
  const items = [];
  const after = [];
  for (const item of run) {
    const m = TASK_RE.exec(item.text);
    const blocks = parseBlocks([m[2], ...item.body.slice(1)], ctx);
    let inline = [];
    if (blocks[0]?.type === 'paragraph') inline = blocks.shift().content ?? [];
    if (inline.length) items.push(taskItem(m[1], inline, ctx));
    after.push(...blocks);
  }
  const nodes = [];
  if (items.length) {
    nodes.push({
      type: 'taskList',
      attrs: { localId: listId },
      content: items,
    });
  }
  nodes.push(...after);
  return nodes;
}

function parseBlocks(lines, ctx) {
  const nodes = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    let r;
    const fence = fenceOpen(line);
    const h = headingMatch(line);
    if (fence) r = parseFence(lines, i, fence);
    else if (h) {
      r = { nodes: [headingNode(h, ctx)], next: i + 1 };
    } else if (isRule(line)) {
      r = { nodes: [{ type: 'rule' }], next: i + 1 };
    } else if (isTableStart(lines, i)) r = parseTable(lines, i, ctx);
    else if (quoteMatch(line) !== null) r = parseQuote(lines, i, ctx);
    else if (matchItem(line)) r = parseList(lines, i, ctx);
    else r = parseParagraph(lines, i, ctx);
    nodes.push(...r.nodes);
    i = Math.max(r.next, i + 1);
  }
  return nodes;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Convert markdown to an ADF document.
 *
 * @param {string} markdown
 * @param {{ idFactory?: () => string }} [opts] `idFactory` overrides the
 *   UUID generator used for `taskList` / `taskItem` `localId`s.
 * @returns {{ type: 'doc', version: 1, content: object[] }}
 */
export function markdownToAdf(markdown, opts = {}) {
  const ctx = { id: opts.idFactory ?? randomUUID };
  const lines = skipFrontmatter(normalizeLines(markdown ?? ''));
  return { type: 'doc', version: 1, content: parseBlocks(lines, ctx) };
}

/** Byte length of the serialized document. */
export function adfSize(doc) {
  return Buffer.byteLength(JSON.stringify(doc), 'utf8');
}

/**
 * Body of the section under `headingLine` (e.g. `## Acceptance criteria`),
 * exclusive of the heading, up to the next heading of the same or higher
 * level. Headings inside fenced code are ignored. Returns `null` when the
 * heading is not found.
 *
 * @param {string} markdown
 * @param {string} headingLine
 * @returns {string|null}
 */
export function extractSection(markdown, headingLine) {
  const want = headingMatch(headingLine.trim());
  if (!want) {
    throw new Error('section must be a heading line like "## Title"');
  }
  const wantText = want.text.toLowerCase();
  const lines = normalizeLines(markdown ?? '');
  let fence = null;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence) {
      if (fenceClose(line, fence)) fence = null;
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open;
      continue;
    }
    const h = headingMatch(line);
    if (!h) continue;
    if (start < 0) {
      if (h.level === want.level && h.text.toLowerCase() === wantText) {
        start = i + 1;
      }
    } else if (h.level <= want.level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/**
 * Remove the first `# H1` line (frontmatter is left alone).
 *
 * @param {string} markdown
 * @returns {string}
 */
export function stripFirstH1(markdown) {
  const lines = normalizeLines(markdown ?? '');
  const idx = lines.findIndex((l) => headingMatch(l)?.level === 1);
  if (idx < 0) return lines.join('\n');
  lines.splice(idx, 1);
  return lines.join('\n');
}

// ===========================================================================
// VALIDATOR
// ===========================================================================

/**
 * Light structural validation against the ADF rules Jira actually
 * enforces. Returns an array of error strings; empty means OK.
 *
 * @param {unknown} doc
 * @returns {string[]}
 */
export function validateAdf(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') return ['doc must be an object'];
  if (doc.type !== 'doc') errors.push('doc.type must be "doc"');
  if (doc.version !== 1) errors.push('doc.version must be 1');
  if (!Array.isArray(doc.content)) {
    errors.push('doc.content must be an array');
    return errors;
  }
  doc.content.forEach((n, i) => walkNode(n, `content[${i}]`, errors));
  return errors;
}

function markTypes(node) {
  return (node.marks ?? []).map((m) => m.type);
}

function walkNode(node, path, errors) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') {
    errors.push(`${path}: node must have a string type`);
    return;
  }
  const kids = node.content;
  const has = (k) => Object.hasOwn(node, k);
  if (has('content') && !Array.isArray(kids)) {
    errors.push(`${path}: content must be an array`);
    return;
  }

  switch (node.type) {
    case 'text':
      if (typeof node.text !== 'string' || node.text.length === 0) {
        errors.push(`${path}: text must be non-empty`);
      }
      {
        const types = markTypes(node);
        const clash = ['strong', 'em', 'strike'].filter((t) =>
          types.includes(t),
        );
        if (types.includes('code') && clash.length) {
          errors.push(
            `${path}: code mark cannot combine with ${clash.join(', ')}`,
          );
        }
      }
      break;
    case 'heading': {
      const level = node.attrs?.level;
      if (!Number.isInteger(level) || level < 1 || level > 6) {
        errors.push(`${path}: heading level must be an integer 1..6`);
      }
      break;
    }
    case 'paragraph':
      if (has('content') && kids.length === 0) {
        errors.push(`${path}: paragraph content must not be empty`);
      }
      break;
    case 'codeBlock':
      if (has('content')) {
        if (kids.length > 1) {
          errors.push(`${path}: codeBlock must hold a single text node`);
        }
        kids.forEach((k, i) => {
          if (k.type !== 'text') {
            errors.push(`${path}.content[${i}]: codeBlock child must be text`);
          } else if (k.marks?.length) {
            errors.push(`${path}.content[${i}]: codeBlock text has marks`);
          }
        });
      }
      break;
    case 'rule':
      if (has('content') || has('attrs')) {
        errors.push(`${path}: rule takes no content or attrs`);
      }
      break;
    case 'bulletList':
    case 'orderedList':
      if (!kids?.length) errors.push(`${path}: list must have items`);
      kids?.forEach((k, i) => {
        if (k.type !== 'listItem') {
          errors.push(`${path}.content[${i}]: list child must be listItem`);
        }
      });
      break;
    case 'listItem':
      if (!kids?.length) errors.push(`${path}: listItem must have content`);
      else if (!LIST_ITEM_FIRST.has(kids[0].type)) {
        errors.push(
          `${path}: listItem first child must be paragraph/codeBlock`,
        );
      }
      break;
    case 'taskList':
      if (typeof node.attrs?.localId !== 'string' || !node.attrs.localId) {
        errors.push(`${path}: taskList requires attrs.localId`);
      }
      if (!kids?.length) errors.push(`${path}: taskList must have items`);
      kids?.forEach((k, i) => {
        if (k.type === 'taskList' && i === 0) {
          errors.push(`${path}.content[0]: nested taskList cannot be first`);
        } else if (k.type !== 'taskItem' && k.type !== 'taskList') {
          errors.push(`${path}.content[${i}]: taskList child ${k.type}`);
        }
      });
      break;
    case 'taskItem':
      if (typeof node.attrs?.localId !== 'string' || !node.attrs.localId) {
        errors.push(`${path}: taskItem requires attrs.localId`);
      }
      if (!TASK_STATES.has(node.attrs?.state)) {
        errors.push(`${path}: taskItem state must be TODO or DONE`);
      }
      kids?.forEach((k, i) => {
        if (!INLINE_TYPES.has(k.type)) {
          errors.push(
            `${path}.content[${i}]: taskItem may only hold inline nodes`,
          );
        }
      });
      break;
    case 'table': {
      let width = -1;
      kids?.forEach((row, i) => {
        if (row.type !== 'tableRow') {
          errors.push(`${path}.content[${i}]: table child must be tableRow`);
          return;
        }
        const n = row.content?.length ?? 0;
        if (width < 0) width = n;
        else if (n !== width) {
          errors.push(
            `${path}.content[${i}]: row has ${n} cells, want ${width}`,
          );
        }
        row.content?.forEach((cell, c) => {
          if (cell.type !== 'tableHeader' && cell.type !== 'tableCell') {
            errors.push(`${path}.content[${i}].content[${c}]: bad cell`);
          }
        });
      });
      break;
    }
    case 'panel':
      if (!PANEL_TYPE_SET.has(node.attrs?.panelType)) {
        errors.push(`${path}: panel has invalid panelType`);
      }
      if (!kids?.length) errors.push(`${path}: panel must have content`);
      kids?.forEach((k, i) => {
        if (PANEL_FORBIDDEN.has(k.type)) {
          errors.push(`${path}.content[${i}]: panel cannot contain ${k.type}`);
        }
      });
      break;
    case 'blockquote':
      if (!kids?.length) errors.push(`${path}: blockquote must have content`);
      break;
    default:
      break;
  }

  kids?.forEach((k, i) => walkNode(k, `${path}.content[${i}]`, errors));
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strip-h1' || arg === '--pretty') {
      out[arg.slice(2).replace(/-/g, '_')] = true;
    } else if (arg.startsWith('--')) {
      out[arg.slice(2).replace(/-/g, '_')] = argv[++i];
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = args.positional[0];
  if (!input) {
    process.stderr.write(
      'usage: md-to-adf.mjs <file.md|-> [--section "## Heading"] ' +
        '[--strip-h1] [--out file.json] [--pretty]\n',
    );
    process.exit(2);
  }
  let md = fs.readFileSync(input === '-' ? 0 : input, 'utf8');
  if (args.section) {
    const section = extractSection(md, args.section);
    if (section === null) {
      process.stderr.write(`section not found: ${args.section}\n`);
      process.exit(1);
    }
    md = section;
  }
  if (args.strip_h1) md = stripFirstH1(md);
  const doc = markdownToAdf(md);
  const errors = validateAdf(doc);
  if (errors.length) {
    process.stderr.write(`invalid ADF (${errors.length} error(s)):\n`);
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    process.exit(1);
  }
  const json = args.pretty
    ? JSON.stringify(doc, null, 2)
    : JSON.stringify(doc);
  if (args.out) {
    fs.writeFileSync(args.out, `${json}\n`);
    process.stderr.write(`wrote ${args.out} (${adfSize(doc)} bytes)\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

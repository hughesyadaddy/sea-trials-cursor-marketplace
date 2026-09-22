#!/usr/bin/env node
/**
 * Atlassian Document Format (ADF) → Markdown, the inverse of
 * `md-to-adf.mjs`.
 *
 * The output uses exactly the markdown dialect `md-to-adf.mjs` parses,
 * so `markdownToAdf(adfToMarkdown(doc))` reproduces `doc` for every
 * node `md-to-adf.mjs` can emit (modulo `localId`s and edge whitespace
 * inside marks; see `normaliseAdf`). Only Node stdlib.
 *
 * Usage:
 *   node adf-to-md.mjs <file.json|->          markdown on stdout
 *   node adf-to-md.mjs --check <file.md>      md→adf→md→adf must agree
 *
 * `--check` exits 1 and prints the first differing node path with a
 * `-`/`+` pair when the two ADF trees differ.
 *
 * Node coverage: doc, paragraph, heading, text (strong, em, code,
 * strike, link; underline and other marks are dropped), bulletList /
 * orderedList (nested, `order`), taskList / taskItem, codeBlock,
 * blockquote, rule, table (header row from `tableHeader` cells; pipes
 * escaped), panel (`> [!NOTE]` alerts), mention, hardBreak (`<br>`),
 * emoji, inlineCard, date, status. Unknown nodes render their text
 * content and warn on stderr; nothing throws.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { markdownToAdf, validateAdf } from './md-to-adf.mjs';

// ===========================================================================
// CONSTANTS
// ===========================================================================

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'mention',
  'emoji',
  'inlineCard',
  'date',
  'status',
]);

const LIST_TYPES = new Set(['bulletList', 'orderedList', 'taskList']);

/** Inverse of `PANEL_TYPES` in md-to-adf.mjs. */
const ALERT_FOR_PANEL = {
  info: 'NOTE',
  success: 'TIP',
  tip: 'TIP',
  note: 'IMPORTANT',
  warning: 'WARNING',
  error: 'CAUTION',
};

/** Outer-to-inner wrapping order for text marks. */
const MARK_ORDER = ['link', 'strong', 'em', 'strike'];
const IGNORED_MARKS = new Set(['underline', 'textColor', 'subsup']);

/** Invisible block that keeps two same-type lists from merging. */
const LIST_SEPARATOR = '<!-- -->';

/**
 * A document that opens with `---` reads as YAML frontmatter in
 * md-to-adf.mjs, so a leading rule is written with the `***` form.
 */
const LEADING_RULE_RE = /^---(?=\n|$)/;

// ===========================================================================
// TEXT ESCAPING
// ===========================================================================

function isWord(ch) {
  return ch !== undefined && /\w/.test(ch);
}

/**
 * Escape plain text so `md-to-adf.mjs` reads it back verbatim.
 *
 * @param {string} text
 * @param {{ inTable?: boolean, inLink?: boolean, heading?: boolean }} ctx
 * @param {{ first?: boolean, last?: boolean }} pos position in its line
 */
export function escapeText(text, ctx = {}, pos = {}) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    if (ch === '\n') out += '<br>';
    else if ('\\*`[<'.includes(ch)) out += `\\${ch}`;
    else if (ch === ']' && ctx.inLink) out += '\\]';
    else if (ch === '|' && ctx.inTable) out += '\\|';
    else if (ch === '~' && (prev === '~' || next === '~')) out += '\\~';
    else if (ch === '_' && !(isWord(prev) && isWord(next))) out += '\\_';
    else if ((ch === '@' || ch === '!') && next === '[') out += `\\${ch}`;
    else if (
      ch === ':' &&
      text.slice(i, i + 3) === '://' &&
      /\bhttps?$/.test(text.slice(0, i))
    ) {
      out += '\\:';
    } else out += ch;
  }
  if (pos.first) out = escapeLineStart(out);
  if (pos.last && ctx.heading) out = out.replace(/#(?=\s*$)/, '\\#');
  return out;
}

/** Escape a leading run that would open a block (heading, list, quote). */
function escapeLineStart(s) {
  if (/^#/.test(s)) return `\\${s}`;
  if (/^>/.test(s)) return `\\${s}`;
  if (/^[-+](\s|$)/.test(s) || /^(?:-\s*){3,}$/.test(s)) return `\\${s}`;
  const num = /^(\d{1,9})([.)])(\s|$)/.exec(s);
  if (num) return `${num[1]}\\${s.slice(num[1].length)}`;
  return s;
}

/** Inline code span with a fence longer than any backtick run inside. */
function codeSpan(text, ctx) {
  let body = text.replace(/\n/g, ' ');
  if (ctx.inTable) body = body.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...(body.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = /^[ `]|[ `]$/.test(body) ? ' ' : '';
  return `${fence}${pad}${body}${pad}${fence}`;
}

// ===========================================================================
// INLINE RENDERING
// ===========================================================================

function markTypes(node) {
  return (node.marks ?? []).map((m) => m.type);
}

function hasMark(node, mark) {
  return (node.marks ?? []).some(
    (m) => m.type === mark.type && JSON.stringify(m.attrs ?? {}) === JSON.stringify(mark.attrs ?? {}),
  );
}

function withoutMark(node, mark) {
  return { ...node, marks: (node.marks ?? []).filter((m) => !(m.type === mark.type)) };
}

function wrappableMark(node, ctx) {
  const marks = node.marks ?? [];
  for (const m of marks) {
    if (!MARK_ORDER.includes(m.type) && m.type !== 'code' && !IGNORED_MARKS.has(m.type)) {
      ctx.warn(`dropping unknown mark "${m.type}"`);
    }
  }
  for (const type of MARK_ORDER) {
    const found = marks.find((m) => m.type === type);
    if (found) return found;
  }
  return null;
}

function linkDestination(mark) {
  const href = String(mark.attrs?.href ?? '')
    .replace(/ /g, '%20')
    .replace(/[()]/g, '\\$&');
  const title = mark.attrs?.title;
  if (!title) return href;
  const quoted = title.includes('"') ? `'${title.replace(/'/g, '&#39;')}'` : `"${title}"`;
  return `${href} ${quoted}`;
}

function wrap(mark, inner, run, ctx) {
  switch (mark.type) {
    case 'strong':
      return `**${inner}**`;
    case 'em':
      return `*${inner}*`;
    case 'strike':
      return `~~${inner}~~`;
    case 'link': {
      const href = String(mark.attrs?.href ?? '');
      const bare =
        run.length === 1 &&
        run[0].type === 'text' &&
        (run[0].marks ?? []).every((m) => m.type === 'link') &&
        run[0].text === href &&
        !mark.attrs?.title &&
        /^https?:\/\/[^\s<>]+$/.test(href);
      if (bare) return `<${href}>`;
      return `[${inner}](${linkDestination(mark)})`;
    }
    default:
      return inner;
  }
}

function renderAtom(node, ctx) {
  const attrs = node.attrs ?? {};
  switch (node.type) {
    case 'hardBreak':
      return '<br>';
    case 'mention': {
      const name = String(attrs.text ?? attrs.id ?? '').replace(/^@/, '');
      if (attrs.id) return `@[${name}](accountId:${attrs.id})`;
      return escapeText(`@${name}`, ctx);
    }
    case 'emoji':
      return escapeText(String(attrs.shortName ?? attrs.text ?? ''), ctx);
    case 'inlineCard': {
      const url = String(attrs.url ?? attrs.data?.url ?? '');
      if (/^https?:\/\/[^\s<>]+$/.test(url)) return `<${url}>`;
      return escapeText(url, ctx);
    }
    case 'date': {
      const ts = Number(attrs.timestamp);
      const text = Number.isFinite(ts)
        ? new Date(ts).toISOString().slice(0, 10)
        : String(attrs.timestamp ?? '');
      return escapeText(text, ctx);
    }
    case 'status':
      return escapeText(String(attrs.text ?? ''), ctx);
    default:
      ctx.warn(`unknown inline node "${node.type}"; kept its text`);
      return escapeText(textContent(node), ctx);
  }
}

/** Plain text of any subtree (for unknown nodes). */
function textContent(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return String(node.text ?? '');
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention' || node.type === 'status' || node.type === 'emoji') {
    return String(node.attrs?.text ?? node.attrs?.shortName ?? '');
  }
  return (node.content ?? []).map(textContent).join('');
}

/**
 * Append `piece` to `out`, escaping a trailing character of `out` that
 * would fuse with the start of `piece` into new syntax (`@` + `[link]`
 * → mention, `!` + `[link]` → image, `~` + `~~x~~` → dead run, ...).
 */
function joinSafe(out, piece) {
  if (!out || !piece) return out + piece;
  const last = out[out.length - 1];
  const escaped = out.length > 1 && out[out.length - 2] === '\\';
  if (escaped) return out + piece;
  const fuses =
    (piece[0] === '[' && (last === '@' || last === '!')) ||
    ('*~_'.includes(last) && piece[0] === last);
  return fuses ? `${out.slice(0, -1)}\\${last}${piece}` : out + piece;
}

/**
 * Render inline nodes. Consecutive text nodes sharing a mark are
 * wrapped once (`**bold *both* bold**`), and whitespace at the edge of
 * a wrapped run is moved outside the delimiters so the run re-parses.
 *
 * @param {object[]} nodes
 * @param {object} ctx
 * @param {{ lineStart?: boolean }} pos
 */
export function renderInlines(nodes, ctx, pos = {}) {
  let out = '';
  let i = 0;
  const list = nodes ?? [];
  while (i < list.length) {
    const node = list[i];
    const first = pos.lineStart && out === '';
    if (node.type !== 'text') {
      out = joinSafe(out, renderAtom(node, ctx));
      i += 1;
      continue;
    }
    const mark = wrappableMark(node, ctx);
    if (!mark) {
      const last = i === list.length - 1;
      const piece = markTypes(node).includes('code')
        ? codeSpan(String(node.text ?? ''), ctx)
        : escapeText(String(node.text ?? ''), ctx, { first, last: last && pos.last });
      out = joinSafe(out, piece);
      i += 1;
      continue;
    }
    let j = i;
    while (j < list.length && list[j].type === 'text' && hasMark(list[j], mark)) {
      j += 1;
    }
    const run = list.slice(i, j);
    const innerCtx = mark.type === 'link' ? { ...ctx, inLink: true } : ctx;
    const inner = renderInlines(
      run.map((n) => withoutMark(n, mark)),
      innerCtx,
      { last: pos.last && j === list.length },
    );
    const lead = /^\s*/.exec(inner)[0];
    const trail = /\s*$/.exec(inner)[0];
    const core = inner.trim();
    out = joinSafe(out, lead + (core ? wrap(mark, core, run, ctx) : '') + trail);
    i = j;
  }
  return out;
}

// ===========================================================================
// BLOCK RENDERING
// ===========================================================================

function indentLines(text, indent) {
  return text
    .split('\n')
    .map((l) => (l === '' ? '' : `${indent}${l}`))
    .join('\n');
}

function quoteLines(text) {
  return text
    .split('\n')
    .map((l) => (l === '' ? '>' : `> ${l}`))
    .join('\n');
}

function renderCodeBlock(node) {
  const text = (node.content ?? []).map((n) => String(n.text ?? '')).join('');
  const longest = Math.max(2, ...(text.match(/`{3,}/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const lang = node.attrs?.language ? String(node.attrs.language) : '';
  return text ? `${fence}${lang}\n${text}\n${fence}` : `${fence}${lang}\n${fence}`;
}

function renderHeading(node, ctx) {
  const level = Math.min(6, Math.max(1, Number(node.attrs?.level) || 1));
  const text = renderInlines(node.content, { ...ctx, heading: true }, {
    lineStart: true,
    last: true,
  });
  return text ? `${'#'.repeat(level)} ${text}` : '#'.repeat(level);
}

function renderListItem(item, marker, ctx) {
  const blocks = item.type === 'listItem'
    ? renderBlocks(item.content ?? [], ctx, { lineStart: true })
    : [renderBlock(item, ctx, { lineStart: true })];
  if (!blocks.length) return marker.trimEnd();
  const indent = ' '.repeat(marker.length);
  let out = '';
  blocks.forEach((block, k) => {
    if (k === 0) {
      const [head, ...rest] = block.split('\n');
      out += head ? `${marker}${head}` : marker.trimEnd();
      if (rest.length) out += `\n${indentLines(rest.join('\n'), indent)}`;
      return;
    }
    const prevIsList = item.content?.[k - 1] && LIST_TYPES.has(item.content[k - 1].type);
    const thisIsList = item.content?.[k] && LIST_TYPES.has(item.content[k].type);
    const gap = thisIsList && !prevIsList ? '\n' : '\n\n';
    out += `${gap}${indentLines(block, indent)}`;
  });
  return out;
}

function renderList(node, ctx) {
  const ordered = node.type === 'orderedList';
  const start = ordered ? Number(node.attrs?.order ?? 1) : 1;
  return (node.content ?? [])
    .map((item, k) => renderListItem(item, ordered ? `${start + k}. ` : '- ', ctx))
    .join('\n');
}

function renderTaskList(node, ctx) {
  const lines = [];
  for (const item of node.content ?? []) {
    if (item.type === 'taskItem') {
      const box = item.attrs?.state === 'DONE' ? '[x]' : '[ ]';
      const text = renderInlines(item.content, ctx, { lineStart: true });
      lines.push(text ? `- ${box} ${text}` : `- ${box} `);
    } else if (item.type === 'taskList') {
      lines.push(indentLines(renderTaskList(item, ctx), '  '));
    } else {
      ctx.warn(`unexpected "${item.type}" inside taskList; rendered as a block`);
      lines.push(indentLines(renderBlock(item, ctx, { lineStart: true }), '  '));
    }
  }
  return lines.join('\n');
}

function renderCell(cell, ctx) {
  const cellCtx = { ...ctx, inTable: true };
  const parts = [];
  for (const block of cell.content ?? []) {
    if (block.type === 'paragraph') {
      parts.push(renderInlines(block.content, cellCtx, { lineStart: true }));
    } else if (block.type === 'taskList') {
      const items = (block.content ?? []).filter((n) => n.type === 'taskItem');
      if (items.length !== (block.content ?? []).length || items.length > 1) {
        ctx.warn('table cell task list with several items flattened to one');
      }
      parts.push(
        items
          .map((it) => {
            const box = it.attrs?.state === 'DONE' ? '[x]' : '[ ]';
            return `${box} ${renderInlines(it.content, cellCtx)}`;
          })
          .join('<br>'),
      );
    } else {
      ctx.warn(`table cell holds "${block.type}"; flattened to one line`);
      parts.push(renderBlock(block, cellCtx, { lineStart: true }).replace(/\n/g, '<br>'));
    }
  }
  return parts.filter((p) => p !== '').join('<br>');
}

function renderTable(node, ctx) {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (!rows.length) return '';
  const matrix = rows.map((r) => (r.content ?? []).map((c) => renderCell(c, ctx)));
  const cols = Math.max(1, ...matrix.map((r) => r.length));
  const headerCells = rows[0].content ?? [];
  if (!headerCells.every((c) => c.type === 'tableHeader')) {
    ctx.warn('table first row is not all tableHeader; markdown needs a header row');
  }
  const line = (cells) => {
    const padded = [...cells];
    while (padded.length < cols) padded.push('');
    return `| ${padded.join(' | ')} |`;
  };
  const out = [line(matrix[0]), `| ${Array(cols).fill('---').join(' | ')} |`];
  for (const row of matrix.slice(1)) out.push(line(row));
  return out.join('\n');
}

function renderPanel(node, ctx) {
  const alert = ALERT_FOR_PANEL[node.attrs?.panelType];
  const body = renderBlocks(node.content ?? [], ctx, { lineStart: true }).join('\n\n');
  if (!alert) {
    ctx.warn(`panel type "${node.attrs?.panelType}" has no alert; rendered as blockquote`);
    return quoteLines(body);
  }
  return `> [!${alert}]\n${quoteLines(body)}`;
}

/**
 * @param {object} node
 * @param {object} ctx
 * @param {{ lineStart?: boolean }} pos
 * @returns {string}
 */
function renderBlock(node, ctx, pos = {}) {
  const lineStart = pos.lineStart ?? true;
  switch (node.type) {
    case 'paragraph':
      return renderInlines(node.content, ctx, { lineStart, last: true });
    case 'heading':
      return renderHeading(node, ctx);
    case 'codeBlock':
      return renderCodeBlock(node);
    case 'rule':
      return '---';
    case 'blockquote':
      return quoteLines(renderBlocks(node.content ?? [], ctx, { lineStart: true }).join('\n\n'));
    case 'panel':
      return renderPanel(node, ctx);
    case 'bulletList':
    case 'orderedList':
      return renderList(node, ctx);
    case 'taskList':
      return renderTaskList(node, ctx);
    case 'listItem':
      return renderListItem(node, '- ', ctx);
    case 'taskItem':
      return renderTaskList({ type: 'taskList', content: [node] }, ctx);
    case 'table':
      return renderTable(node, ctx);
    case 'expand':
    case 'nestedExpand': {
      ctx.warn(`"${node.type}" has no markdown form; rendered its content inline`);
      const title = node.attrs?.title ? `**${escapeText(String(node.attrs.title), ctx)}**` : '';
      const body = renderBlocks(node.content ?? [], ctx, { lineStart: true });
      return [title, ...body].filter(Boolean).join('\n\n');
    }
    case 'mediaSingle':
    case 'mediaGroup':
    case 'media': {
      ctx.warn(`"${node.type}" cannot be expressed; rendered alt text or url`);
      const medias = node.type === 'media' ? [node] : node.content ?? [];
      return medias
        .map((m) => {
          const alt = m.attrs?.alt ?? m.attrs?.id ?? '';
          const url = m.attrs?.url;
          return url ? `[${escapeText(String(alt || url), ctx)}](${url})` : escapeText(String(alt), ctx);
        })
        .join('<br>');
    }
    default: {
      ctx.warn(`unknown node "${node.type}"; kept its text content`);
      const kids = node.content ?? [];
      if (kids.length && kids.every((k) => INLINE_TYPES.has(k.type) || k.type === 'text')) {
        return renderInlines(kids, ctx, { lineStart, last: true });
      }
      if (kids.length) return renderBlocks(kids, ctx, { lineStart: true }).join('\n\n');
      return escapeText(textContent(node), ctx, { first: lineStart });
    }
  }
}

/**
 * Render sibling blocks. Two adjacent lists of the same type get an
 * invisible `<!-- -->` separator so they do not merge when re-parsed.
 *
 * @returns {string[]} one markdown string per block (separators included)
 */
function renderBlocks(nodes, ctx, pos = {}) {
  const out = [];
  let prevType = null;
  for (const node of nodes ?? []) {
    if (!node || typeof node !== 'object') continue;
    if (LIST_TYPES.has(node.type) && node.type === prevType) out.push(LIST_SEPARATOR);
    const md = renderBlock(node, ctx, pos);
    out.push(md);
    prevType = node.type;
  }
  return out;
}

// ===========================================================================
// PUBLIC API
// ===========================================================================

/**
 * Convert an ADF document (or a bare content array) to markdown.
 *
 * @param {object|object[]} adf
 * @param {{ warn?: (msg: string) => void }} [opts] `warn` receives
 *   degradation notices; defaults to stderr.
 * @returns {string} markdown without a trailing newline
 */
export function adfToMarkdown(adf, opts = {}) {
  const ctx = {
    warn: opts.warn ?? ((m) => process.stderr.write(`[adf-to-md] ${m}\n`)),
  };
  let content;
  if (Array.isArray(adf)) content = adf;
  else if (adf && typeof adf === 'object') content = adf.content ?? [];
  else content = [];
  return renderBlocks(content, ctx, { lineStart: true })
    .filter((block) => block !== '')
    .join('\n\n')
    .replace(LEADING_RULE_RE, '***')
    .replace(/\s+$/, '');
}

// ===========================================================================
// NORMALISE / COMPARE
// ===========================================================================

function isInlineNode(n) {
  return INLINE_TYPES.has(n?.type);
}

function sortMarks(marks) {
  return [...marks].sort((a, b) => {
    const ka = JSON.stringify([a.type, a.attrs ?? {}]);
    const kb = JSON.stringify([b.type, b.attrs ?? {}]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

function sameMarks(a, b) {
  return JSON.stringify(a.marks ?? []) === JSON.stringify(b.marks ?? []);
}

/** Split edge whitespace out of marked text, merge, trim the ends. */
function normaliseInlines(nodes) {
  const split = [];
  for (const raw of nodes) {
    if (raw.type !== 'text' || !(raw.marks?.length)) {
      split.push(raw);
      continue;
    }
    // Sort before merging so [strong, em] and [em, strong] fuse.
    const n = { ...raw, marks: sortMarks(raw.marks) };
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(n.text);
    if (m[1]) split.push({ type: 'text', text: m[1] });
    if (m[2]) split.push({ ...n, text: m[2] });
    if (m[3]) split.push({ type: 'text', text: m[3] });
  }
  const merged = [];
  for (const n of split) {
    const prev = merged[merged.length - 1];
    if (n.type === 'text' && prev?.type === 'text' && sameMarks(prev, n)) {
      prev.text += n.text;
    } else merged.push(structuredClone(n));
  }
  const trimEdge = (idx, re) => {
    const n = merged[idx];
    if (n?.type === 'text') n.text = n.text.replace(re, '');
  };
  trimEdge(0, /^\s+/);
  trimEdge(merged.length - 1, /\s+$/);
  return merged.filter((n) => !(n.type === 'text' && n.text === ''));
}

/**
 * Canonical form for round-trip comparison: drops `localId`s, sorts
 * marks, moves whitespace at the edge of marked text out of the mark,
 * merges adjacent equal text nodes, trims paragraph edges, and removes
 * empty `content` / `attrs`.
 *
 * @param {object} node
 * @returns {object}
 */
export function normaliseAdf(node) {
  const n = structuredClone(node);
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (x.attrs && typeof x.attrs === 'object') {
      delete x.attrs.localId;
      if (!Object.keys(x.attrs).length) delete x.attrs;
    }
    if (Array.isArray(x.marks)) {
      x.marks = sortMarks(x.marks);
      if (!x.marks.length) delete x.marks;
    }
    if (Array.isArray(x.content)) {
      if (x.type !== 'codeBlock' && x.content.some(isInlineNode)) {
        x.content = normaliseInlines(x.content);
      }
      x.content.forEach(walk);
      if (!x.content.length) delete x.content;
    }
  };
  walk(n);
  return n;
}

/**
 * First differing path between two values, or null when deep-equal.
 *
 * @returns {{ path: string, expected: unknown, actual: unknown }|null}
 */
export function firstDifference(expected, actual, at = 'doc') {
  if (expected === actual) return null;
  const te = typeof expected;
  const ta = typeof actual;
  if (te !== 'object' || ta !== 'object' || expected === null || actual === null) {
    return { path: at, expected, actual };
  }
  if (Array.isArray(expected) !== Array.isArray(actual)) {
    return { path: at, expected, actual };
  }
  if (Array.isArray(expected)) {
    const len = Math.max(expected.length, actual.length);
    for (let i = 0; i < len; i += 1) {
      const d = firstDifference(expected[i], actual[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const k of keys) {
    const d = firstDifference(expected[k], actual[k], `${at}.${k}`);
    if (d) return d;
  }
  return null;
}

/**
 * md → adf → md → adf; the two ADF trees must agree once normalised.
 *
 * @param {string} markdown
 * @param {{ warn?: (msg: string) => void }} [opts]
 * @returns {{ ok: boolean, diff: ReturnType<typeof firstDifference>,
 *   markdown: string, first: object, second: object, errors: string[] }}
 */
export function checkRoundTrip(markdown, opts = {}) {
  const first = markdownToAdf(markdown);
  const regenerated = adfToMarkdown(first, opts);
  const second = markdownToAdf(regenerated);
  const errors = validateAdf(second);
  const diff = firstDifference(normaliseAdf(first), normaliseAdf(second));
  return {
    ok: diff === null && errors.length === 0,
    diff,
    markdown: regenerated,
    first,
    second,
    errors,
  };
}

// ===========================================================================
// CLI
// ===========================================================================

function usage() {
  process.stderr.write(
    'usage: adf-to-md.mjs <file.json|->\n' +
      '       adf-to-md.mjs --check <file.md>\n',
  );
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) {
    usage();
    process.exit(2);
  }
  if (argv[0] === '--check') {
    const file = argv[1];
    if (!file) {
      usage();
      process.exit(2);
    }
    const md = fs.readFileSync(file === '-' ? 0 : file, 'utf8');
    const result = checkRoundTrip(md);
    if (result.ok) {
      process.stderr.write(
        `[adf-to-md] round-trip OK (${result.first.content.length} block(s))\n`,
      );
      return;
    }
    if (result.errors.length) {
      process.stderr.write('[adf-to-md] regenerated ADF is invalid:\n');
      for (const e of result.errors) process.stderr.write(`  ${e}\n`);
    }
    if (result.diff) {
      process.stderr.write(`[adf-to-md] round-trip mismatch at ${result.diff.path}\n`);
      process.stderr.write(`- ${JSON.stringify(result.diff.expected)}\n`);
      process.stderr.write(`+ ${JSON.stringify(result.diff.actual)}\n`);
    }
    process.exit(1);
  }
  const input = argv[0];
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(input === '-' ? 0 : input, 'utf8'));
  } catch (err) {
    process.stderr.write(`[adf-to-md] cannot read ADF JSON: ${err.message}\n`);
    process.exit(1);
  }
  process.stdout.write(`${adfToMarkdown(doc)}\n`);
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

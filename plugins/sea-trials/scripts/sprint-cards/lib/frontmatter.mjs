/**
 * Card files: YAML front matter between two `---` lines, then the body.
 *
 * Only the YAML subset that card files use is supported: scalars
 * (null, true/false, integers, plain, 'single' and "double" quoted
 * strings), flow lists (`[]`, `[a, b]`), block lists of scalars and
 * block lists of flat maps (`attachments`). That keeps the tool free of
 * dependencies and makes the output byte-stable.
 */

/** Front matter keys in the fixed order every card uses. */
export const CARD_KEYS = [
  'local_id',
  'jira_key',
  'jira_id',
  'parent_local_id',
  'parent_jira_key',
  'key',
  'type',
  'parent',
  'summary',
  'status',
  'status_category',
  'story_points',
  'labels',
  'sprint',
  'attachments',
  'order',
  'plan_number',
  'jira_order',
];

/** Keys that must always be written as quoted strings. */
const STRING_KEYS = new Set(['jira_id', 'plan_number']);

function parseScalar(raw) {
  const s = raw.trim();
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '[]') return [];
  if (s === '{}') return {};
  if (/^-?\d+$/.test(s) && s.length < 16) return Number(s);
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return splitFlow(inner).map(parseScalar);
  }
  return s;
}

function splitFlow(inner) {
  const out = [];
  let cur = '';
  let q = null;
  for (const ch of inner) {
    if (q) {
      cur += ch;
      if (ch === q) q = null;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      cur += ch;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Split a card file into `{ meta, body, hasFrontMatter }`.
 *
 * @param {string} text
 */
export function parseCard(text) {
  const src = text.replace(/\r\n?/g, '\n');
  if (!src.startsWith('---\n')) return { meta: {}, body: src, hasFrontMatter: false };
  const end = src.indexOf('\n---\n', 3);
  const endAtEof = src.endsWith('\n---') ? src.length - 4 : -1;
  const stop = end !== -1 ? end : endAtEof;
  if (stop === -1) return { meta: {}, body: src, hasFrontMatter: false };
  const fm = src.slice(4, stop);
  const body = src.slice(stop + 5).replace(/^\n+/, '');
  return { meta: parseYamlBlock(fm), body, hasFrontMatter: true };
}

/** @param {string} fm */
export function parseYamlBlock(fm) {
  const meta = {};
  const lines = fm.split('\n');
  let curKey = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const top = /^([A-Za-z_][A-Za-z0-9_]*):(?:\s(.*)|)$/.exec(line);
    if (top) {
      curKey = top[1];
      const rest = top[2] ?? '';
      meta[curKey] = rest.trim() === '' ? null : parseScalar(rest);
      continue;
    }
    if (curKey === null) continue;
    const item = /^(\s*)-\s?(.*)$/.exec(line);
    if (item) {
      if (!Array.isArray(meta[curKey])) meta[curKey] = [];
      const content = item[2];
      const kv = /^([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(content);
      if (kv && !/^['"]/.test(content)) {
        const obj = { [kv[1]]: parseScalar(kv[2]) };
        const childIndent = item[1].length + 2;
        while (i + 1 < lines.length) {
          const nx = lines[i + 1];
          const m = /^(\s+)([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$/.exec(nx);
          if (!m || m[1].length < childIndent) break;
          obj[m[2]] = parseScalar(m[3]);
          i += 1;
        }
        meta[curKey].push(obj);
      } else meta[curKey].push(parseScalar(content));
      continue;
    }
    // Plain multi-line continuation of the previous scalar.
    if (/^\s+\S/.test(line) && typeof meta[curKey] === 'string') {
      meta[curKey] = `${meta[curKey]} ${line.trim()}`;
    }
  }
  return meta;
}

function needsQuote(s) {
  return (
    s === ''
    || /^[\s]|[\s]$/.test(s)
    || /^(null|true|false|~|yes|no|on|off)$/i.test(s)
    || /^-?\d+(\.\d+)?$/.test(s)
    || /^[-?:,[\]{}#&*!|>'"%@`]/.test(s)
    || /: |\s#/.test(s)
    || /[\n\t]/.test(s)
  );
}

/** Render a scalar the way PyYAML safe_dump does for card files. */
export function renderScalar(v, forceString = false) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true';
  if (v === false) return 'false';
  if (typeof v === 'number') return forceString ? `'${v}'` : String(v);
  const s = String(v);
  if (/[\n\t]/.test(s)) return JSON.stringify(s);
  if (forceString || needsQuote(s)) return `'${s.replace(/'/g, "''")}'`;
  return s;
}

function renderValue(key, v) {
  if (Array.isArray(v)) {
    if (!v.length) return `${key}: []`;
    const out = [`${key}:`];
    for (const it of v) {
      if (it && typeof it === 'object') {
        const entries = Object.entries(it);
        entries.forEach(([k, val], idx) => {
          out.push(`${idx === 0 ? '- ' : '  '}${k}: ${renderScalar(val)}`);
        });
      } else out.push(`- ${renderScalar(it)}`);
    }
    return out.join('\n');
  }
  const forceString = STRING_KEYS.has(key) && typeof v === 'number';
  return `${key}: ${renderScalar(v, forceString)}`;
}

/**
 * Render front matter in the fixed card key order, then any extra keys
 * in their existing order.
 *
 * @param {Record<string, unknown>} meta
 */
export function renderFrontMatter(meta) {
  const keys = [
    ...CARD_KEYS.filter((k) => k in meta),
    ...Object.keys(meta).filter((k) => !CARD_KEYS.includes(k)),
  ];
  return keys.map((k) => renderValue(k, meta[k])).join('\n');
}

/** Normalise a body: LF, no trailing spaces, single blank lines, one final newline. */
export function normalizeBody(body) {
  let s = (body ?? '').replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  const out = [];
  let inFence = false;
  for (const raw of lines) {
    const line = inFence ? raw : raw.replace(/[ \t]+$/, '');
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line === '' && out.length && out[out.length - 1] === '') continue;
    out.push(line);
  }
  s = out.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  return s ? `${s}\n` : '';
}

/** @param {Record<string, unknown>} meta @param {string} body */
export function renderCard(meta, body) {
  return `---\n${renderFrontMatter(meta)}\n---\n\n${normalizeBody(body)}`;
}

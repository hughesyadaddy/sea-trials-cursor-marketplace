/**
 * Transitive local-import closure of a JavaScript module.
 *
 * A CI lane's pass-cache fingerprint has to cover every input its steps
 * read. Entry points are easy to remember and their imports are not:
 * `guardrails-analyze-packages.mjs` was listed in `LANE_INFRA_GLOBS`
 * while the two helpers it delegates target selection and execution to
 * were not, so a push touching only a helper matched no lane and changed
 * no fingerprint. A later in-scope push could then restore a sentinel
 * recorded under the old helper behaviour and skip the lane.
 *
 * Deriving the closure from the source keeps that list from drifting
 * again, rather than asking a reviewer to notice a missing entry.
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * Matches `from '...'`, `import '...'`, and `import('...')`, in single
 * quotes, double quotes, or a backtick template.
 */
const SPECIFIER_RE =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)(['"`])([^'"`]+)\1/g;

/**
 * A dynamic `import(` whose argument is not a plain string literal.
 *
 * Matched so the walker can fail CLOSED. Skipping these would leave the
 * coverage test green while a real dependency went unfingerprinted —
 * exactly the stale-sentinel failure the guard exists to prevent.
 */
const OPAQUE_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*(?!['"`])/g;

/**
 * Mark indices that are inside comments or string literals.
 *
 * @param {string} source
 * @returns {Uint8Array} 1 = executable code, 0 = comment/string
 */
export function buildCodeMask(source) {
  const mask = new Uint8Array(source.length).fill(1);
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      for (let j = i; j < source.length && source[j] !== '\n'; j += 1) {
        mask[j] = 0;
      }
      i += 2;
      continue;
    }

    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        mask[i] = 0;
        i += 1;
      }
      if (i < source.length) {
        mask[i] = 0;
        mask[i + 1] = 0;
        i += 2;
      }
      continue;
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      mask[i] = 0;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          mask[i] = 0;
          if (i + 1 < source.length) mask[i + 1] = 0;
          i += 2;
          continue;
        }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          mask[i] = 0;
          mask[i + 1] = 0;
          i += 2;
          let depth = 1;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
          }
          continue;
        }
        mask[i] = 0;
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return mask;
}

/**
 * @param {Uint8Array} mask
 * @param {number} index
 */
function startsInCode(mask, index) {
  return index >= 0 && index < mask.length && mask[index] === 1;
}

/**
 * Strip comments and string literals so import regexes cannot match
 * examples embedded in docs or error messages.
 *
 * @param {string} source
 * @returns {string}
 */
export function stripCommentsAndStrings(source) {
  const mask = buildCodeMask(source);
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    out += mask[i] ? source[i] : ' ';
  }
  return out;
}

/**
 * @param {string} source
 * @returns {{ specifiers: string[], opaque: string[] }}
 */
export function scanSpecifiers(source) {
  const specifiers = new Set();
  const opaque = new Set();
  const mask = buildCodeMask(source);

  for (const match of source.matchAll(SPECIFIER_RE)) {
    if (!startsInCode(mask, match.index ?? 0)) continue;
    const [, quote, spec] = match;
    // A substituted template cannot be resolved statically. Treat it as
    // opaque rather than as the literal text, which would otherwise
    // resolve to a path that does not exist and look like a typo.
    if (quote === '`' && spec.includes('${')) {
      opaque.add(spec);
      continue;
    }
    if (spec.startsWith('./') || spec.startsWith('../')) {
      specifiers.add(spec);
    }
  }

  for (const match of source.matchAll(OPAQUE_DYNAMIC_IMPORT_RE)) {
    if (!startsInCode(mask, match.index ?? 0)) continue;
    opaque.add(source.slice(match.index, match.index + 40).split('\n')[0]);
  }

  return {
    specifiers: [...specifiers].sort(),
    opaque: [...opaque].sort(),
  };
}

/**
 * @param {string} source
 * @returns {string[]} relative specifiers only
 */
export function relativeSpecifiers(source) {
  return scanSpecifiers(source).specifiers;
}

/**
 * Repo-relative paths the entry module reads at import time, including
 * the entry itself.
 *
 * Unresolvable specifiers are reported rather than skipped: a silent
 * skip is how a dependency goes unfingerprinted in the first place.
 *
 * @param {string} entry repo-relative path
 * @param {string} repoRoot
 * @returns {{ files: string[], unresolved: string[] }}
 */
export function localImportClosure(entry, repoRoot) {
  const files = new Set();
  const unresolved = [];
  const queue = [entry];

  while (queue.length > 0) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) {
      unresolved.push(rel);
      continue;
    }
    files.add(rel);

    const source = fs.readFileSync(abs, 'utf8');
    const { specifiers, opaque } = scanSpecifiers(source);
    for (const expr of opaque) {
      unresolved.push(`${rel}: unparseable import ${expr}`);
    }
    for (const spec of specifiers) {
      const resolvedAbs = path.resolve(path.dirname(abs), spec);
      const next = path.relative(repoRoot, resolvedAbs);
      if (next.startsWith('..')) {
        unresolved.push(spec);
        continue;
      }
      queue.push(next);
    }
  }

  return { files: [...files].sort(), unresolved };
}

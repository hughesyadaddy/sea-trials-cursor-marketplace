//
// The one brand-scanning engine. Consumed by
// scripts/ci/marketing-brand-leak-guard.test.mjs and
// scripts/whitelabel/leak-guard.test.mjs.
//
// Dependency-free (`node:*` only, explicit extensions) so it runs in a CI
// lane with no pnpm install.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Repo-relative tracked paths under `roots`, filtered by extension.
 *
 * `git ls-files` — NOT a filesystem walk. It gets .gitignore, nested
 * node_modules, build output, Pods and every future generated tree for
 * free, and makes the file set byte-identical between a dirty developer
 * worktree and a fresh CI checkout.
 */
export function trackedFiles(repoRoot, roots, extensions) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...roots], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const wanted = new Set(extensions);
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => wanted.has(path.extname(f)))
    .sort();
}

const LINE_COMMENT = {
  dart: ['//'], ts: ['//'], sql: ['--'], sh: ['#'],
  yaml: ['#'], env: ['#'], text: [], css: [], kotlin: ['//'],
};
const BLOCK_LANGS = new Set(['dart', 'ts', 'sql', 'css', 'kotlin']);
// Kotlin's raw string is `"""…"""`; `'''` is not Kotlin syntax but costs
// nothing to accept, since three adjacent char literals cannot occur.
const TRIPLE_LANGS = new Set(['dart', 'kotlin']);
// Quotes that do NOT end at newline in these languages (multi-line strings)
const MULTILINE_QUOTES = {
  ts: new Set(['`']),          // template literals
  sql: new Set(["'"]),         // multi-line strings
  sh: new Set(["'", '"']),     // multi-line strings
};
// Languages where # comment requires whitespace or line-start before it
const HASH_NEEDS_SPACE = new Set(['sh', 'yaml', 'env']);
// Unquoted shell control operators, after which a `#` still starts a word
// and therefore a comment. `{`/`}` are deliberately absent: `${#ARRAY[@]}`
// is parameter expansion, not an operator.
const SH_COMMENT_BOUNDARY = new Set([';', '&', '|', '(', ')']);

/**
 * Helper: Check if a valid heredoc starts at position i in source.
 * Returns {isHeredoc: true, terminatorWord, isDash, wordEnd} if valid, {isHeredoc: false} otherwise.
 * Also verifies that the terminator line exists later in the source.
 */
function tryParseHeredoc(source, i, n) {
  // Must be exactly << (not <<< or other)
  if (!source.startsWith('<<', i)) return { isHeredoc: false };
  if (i > 0 && source[i - 1] === '<') return { isHeredoc: false };  // <<<
  if (i + 2 < n && source[i + 2] === '<') return { isHeredoc: false };  // <<<

  let j = i + 2;
  const isDash = source[j] === '-';
  if (isDash) j++;

  // Skip whitespace/tabs after << or <<-
  while (j < n && /[ \t]/.test(source[j])) j++;

  // Shell accepts <<\EOF — the backslash is not part of the delimiter word.
  if (j < n && source[j] === '\\') j++;

  // Extract terminator: either quoted or unquoted WORD
  let terminator = '';
  let quoteChar = null;

  if (j < n && (source[j] === '"' || source[j] === "'")) {
    quoteChar = source[j];
    j++;
    while (j < n && source[j] !== quoteChar) {
      terminator += source[j];
      j++;
    }
    if (j < n && source[j] === quoteChar) j++;  // closing quote
  } else {
    // Unquoted terminator: shell accepts <<\EOF (backslash is not part of WORD)
    if (source[j] === '\\' && j + 1 < n && /[A-Za-z_]/.test(source[j + 1])) {
      j += 1;
    }
    // The WORD must still START as an identifier, so `<<$VAR` (expansion)
    // and `<<3` are not mistaken for delimiters.
    if (j >= n || !/[A-Za-z_]/.test(source[j])) {
      return { isHeredoc: false };  // Invalid WORD start
    }
    // …but the rest of it is a shell WORD, not an identifier: bash accepts
    // `<<END-HTML`, `<<_end.marker`, `<<EOF:1` (verified 2026-09-17). Stop
    // only at whitespace or a metacharacter that genuinely ends the word,
    // so `read -ra X <<< "$Y"` and `cat <<EOF >out` keep parsing as today.
    while (j < n && !/[\s;|&<>()'"$`\\]/.test(source[j])) {
      terminator += source[j];
      j++;
    }
  }

  if (!terminator) return { isHeredoc: false };

  // Now verify that the terminator line actually exists later in the source
  let searchIdx = j;
  // Skip to end of the redirect line
  while (searchIdx < n && source[searchIdx] !== '\n') searchIdx++;
  if (searchIdx < n) searchIdx++;  // Skip the newline

  // Look for the terminator line
  while (searchIdx < n) {
    let lineContent = '';
    while (searchIdx < n && source[searchIdx] !== '\n') {
      lineContent += source[searchIdx];
      searchIdx++;
    }

    let checkLine = lineContent;
    if (isDash) {
      checkLine = lineContent.replace(/^\t+/, '');
    }

    if (checkLine === terminator) {
      // Found it!
      return { isHeredoc: true, terminatorWord: terminator, isDash, wordEnd: j };
    }

    if (searchIdx < n) searchIdx++;  // Skip newline
  }

  // Terminator not found
  return { isHeredoc: false };
}

// Characters after which a `/` can only begin an expression, so it opens a
// regex literal rather than a division. Anything else — an identifier, a
// digit, `)`, `]`, `}`, a quote — is left as division, except a `)` that
// closes an if/while/for header (see isControlFlowHeader).
const REGEX_PRECEDERS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>', '{', ';',
]);
// Keywords after which a `/` is likewise a regex, not a division.
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void',
  'instanceof', 'do', 'else', 'yield', 'await',
]);

/** The last non-whitespace character already emitted, or '' at the start. */
function lastSignificant(out) {
  for (let k = out.length - 1; k >= 0; k -= 1) {
    if (!/\s/.test(out[k])) return out[k];
  }
  return '';
}

/** Index of the `)` that closes the `(` at `openIdx`, or -1. */
function matchingParenClose(s, openIdx) {
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * True when `out` is an if/while/for condition whose closing `)` is the
 * last non-whitespace character — i.e. the next token is the statement
 * body, so a `/` there starts a regex, not a division.
 */
function isControlFlowHeader(out) {
  const s = out.trimEnd();
  if (!s.endsWith(')')) return false;
  const re = /(?:^|[^A-Za-z0-9_$])(?:if|while|for)\s*\(/g;
  let match;
  while ((match = re.exec(s)) !== null) {
    const open = match.index + match[0].length - 1;
    if (matchingParenClose(s, open) === s.length - 1) return true;
  }
  return false;
}

/**
 * If a JS/TS regex literal starts at `i`, return the index just past it
 * (flags included); otherwise -1.
 *
 * `/[/*]/` is a valid regex whose `/*` is NOT a block-comment opener, and
 * reading it as one discards the file up to the next `*​/` — or, when there
 * is none, everything after it, hiding every later tenant-visible literal.
 *
 * The recognition is deliberately one-sided. Where the `/` is ambiguous
 * this returns -1 and the character falls through to the existing lexer,
 * so a missed regex behaves exactly as this engine did before; only an
 * unambiguous regex start changes anything. That keeps the failure mode at
 * "no worse than today" instead of "swallows code that used to be scanned".
 */
function tryParseRegexLiteral(source, i, n, out) {
  const next = source[i + 1];
  // `//` opens a line comment and `/*` a block comment; neither can be a
  // regex (an empty regex is written `/(?:)/`), so comments are untouched.
  if (next === undefined || next === '/' || next === '*') return -1;

  const prev = lastSignificant(out);
  if (prev !== '' && !REGEX_PRECEDERS.has(prev)) {
    // `if (ready) /re/` is a legal brace-less body: lastSignificant is `)`,
    // which is also the close of `foo()` in `foo() / bar` (division). Only
    // treat `)` as a regex start when that paren group is an if/while/for
    // header whose `)` is at the end of `out`.
    const controlFlowBody = prev === ')' && isControlFlowHeader(out);
    if (!controlFlowBody) {
      if (!/[A-Za-z_$]/.test(prev)) return -1;
      const word = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(out.trimEnd());
      if (!word || !REGEX_KEYWORDS.has(word[0])) return -1;
    }
  }

  let j = i + 1;
  let inClass = false;
  while (j < n) {
    const c = source[j];
    // A regex literal cannot span a newline. Bailing out here is what makes
    // a misjudged `/` harmless: it reverts to the previous behaviour.
    if (c === '\n') return -1;
    if (c === '\\') { j += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      j += 1;
      while (j < n && /[dgimsuvy]/.test(source[j])) j += 1;  // flags
      return j;
    }
    j += 1;
  }
  return -1;
}

/**
 * Removes comments while tracking string state, so a `//` inside a string
 * literal (a URL, or jq's alternative operator) is preserved. Line count
 * is preserved so `file:line` citations stay accurate.
 *
 * Handles per-language multi-line strings (e.g., backticks in TS, quotes in SQL/sh).
 * Handles shell heredocs (<<WORD, <<-WORD) where body is copied verbatim.
 * In sh/yaml/env, # only starts a comment after whitespace or at line start.
 * In sh, `$(` inside a "…" string opens a command-substitution frame that
 * is lexed as ordinary sh (its own quotes and # comments) until the
 * matching `)`, which returns to the enclosing string. Frames nest, and
 * `$((` arithmetic is covered by the same parenthesis depth count.
 */
export function stripComments(source, lang) {
  const lineMarkers = LINE_COMMENT[lang] ?? [];
  const multilineQuotes = MULTILINE_QUOTES[lang] ?? new Set();
  const hashNeedsSpace = HASH_NEEDS_SPACE.has(lang);
  const n = source.length;
  let out = '';
  let i = 0;
  let quote = null;
  let lineStart = true;  // Track if we're at the start of a line (after \n)
  let prevChar = '';    // Track previous character for whitespace checks

  // Pending heredoc state: set when we recognize a heredoc, cleared after body is output
  let pendingHeredoc = null;  // {terminatorWord, isDash}
  let dollarQuote = null;  // sql: $tag$ … $tag$

  // sh command-substitution frames opened by `$(` inside a "…" string.
  // Each remembers the quote to restore and its unquoted paren depth.
  const frames = [];  // [{enclosing, depth}]

  while (i < n) {
    const c = source[i];

    // Handle pending heredoc body at newline boundaries (not inside multi-line quotes)
    if (pendingHeredoc && c === '\n' && !quote) {
      out += '\n'; i++;

      // Copy heredoc body verbatim until we find the terminator line
      while (i < n) {
        let lineContent = '';
        while (i < n && source[i] !== '\n') {
          lineContent += source[i];
          i++;
        }

        let checkLine = lineContent;
        if (pendingHeredoc.isDash) {
          checkLine = lineContent.replace(/^\t+/, '');
        }

        out += lineContent;
        if (i < n) { out += '\n'; i++; }

        if (checkLine === pendingHeredoc.terminatorWord) break;
      }

      pendingHeredoc = null;
      lineStart = true;
      prevChar = '\n';
      continue;
    }

    // sh: an unquoted backslash escapes the next character (\" \' \# \( \)),
    // so it can neither open a quote, start a comment nor move a command-
    // substitution frame's paren depth. A backslash-newline continuation
    // leaves the newline to the normal flow, so line count and heredoc body
    // handling are unchanged.
    if (lang === 'sh' && !quote && c === '\\' && i + 1 < n && source[i + 1] !== '\n') {
      out += source.slice(i, i + 2); i += 2; lineStart = false; prevChar = source[i - 1];
      continue;
    }

    // Try to recognize a heredoc in the main lexing flow (when not in a quote)
    if (lang === 'sh' && !quote) {
      const heredocInfo = tryParseHeredoc(source, i, n);
      if (heredocInfo.isHeredoc) {
        const { terminatorWord, isDash, wordEnd } = heredocInfo;

        // Output up to the end of the WORD
        out += source.slice(i, wordEnd);
        i = wordEnd;

        // Set pending heredoc state and continue lexing the rest of the line normally
        pendingHeredoc = { terminatorWord, isDash };
        lineStart = false;
        prevChar = source[wordEnd - 1];
        continue;
      }
    }

    if (quote) {
      if (quote.length === 3 && source.startsWith(quote, i)) {
        out += quote; i += 3; quote = null; continue;
      }
      if (quote.length === 1) {
        // In sh, backslashes are literal inside single quotes.
        if (c === '\\' && i + 1 < n && !(lang === 'sh' && quote === "'")) {
          out += source.slice(i, i + 2); i += 2; prevChar = source[i-1]; continue;
        }
        if (lang === 'sh' && quote === '"' && source.startsWith('$(', i)) {
          frames.push({ enclosing: quote, depth: 1 });
          out += '$('; i += 2; quote = null; lineStart = false; prevChar = '('; continue;
        }
        if (c === quote) { out += c; i += 1; quote = null; prevChar = c; continue; }
        // Only reset quote on newline if this quote doesn't support multi-line
        if (c === '\n' && !multilineQuotes.has(quote)) { out += c; i += 1; quote = null; lineStart = true; prevChar = c; continue; }
      }
      out += c; i += 1; prevChar = c; continue;
    }

    // Regex literals before comment rules: their `/*` is not a comment.
    if (lang === 'ts' && c === '/') {
      const end = tryParseRegexLiteral(source, i, n, out);
      if (end !== -1) {
        out += source.slice(i, end);
        i = end; lineStart = false; prevChar = source[end - 1];
        continue;
      }
    }

    if (BLOCK_LANGS.has(lang) && source.startsWith('/*', i)) {
      i += 2;
      while (i < n && !source.startsWith('*/', i)) {
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2; continue;
    }

    // SQL dollar-quoted strings ($tag$…$tag$): preserve HTML `--` inside.
    if (lang === 'sql' && c === '$') {
      let tagEnd = i + 1;
      while (tagEnd < n && source[tagEnd] !== '$') tagEnd += 1;
      if (tagEnd < n) {
        const tag = source.slice(i + 1, tagEnd);
        const close = `$${tag}$`;
        const bodyStart = tagEnd + 1;
        const closeIdx = source.indexOf(close, bodyStart);
        if (closeIdx !== -1) {
          out += source.slice(i, closeIdx + close.length);
          i = closeIdx + close.length;
          prevChar = source[i - 1];
          lineStart = false;
          continue;
        }
      }
    }

    // Handle line comments with language-specific rules for #
    let isCommentStart = false;
    for (const marker of lineMarkers) {
      if (source.startsWith(marker, i)) {
        // For # in sh/yaml/env, only strip if at line start or after whitespace
        if (marker === '#' && hashNeedsSpace) {
          // `#` opens a comment when it starts a word, so any unquoted
          // control operator before it ends the command just as whitespace
          // does. Verified against bash on 2026-09-17: `;` `&` `|` `(` `)`
          // all make `true<op># x` a comment; `{` does NOT, because
          // `${#ARRAY[@]}` is parameter expansion and 77 tracked builder
          // lines depend on it staying code.
          const afterControl = SH_COMMENT_BOUNDARY.has(prevChar);
          if (!lineStart && !/\s/.test(prevChar) && !afterControl) {
            break;  // Not a comment, # is in the middle of a token
          }
        }
        isCommentStart = true;
        break;
      }
    }
    if (isCommentStart) {
      while (i < n && source[i] !== '\n') i += 1;
      lineStart = true;
      prevChar = '';
      continue;
    }

    if (lang === 'sql' && c === '$') {
      let j = i + 1;
      let tag = '';
      while (j < n && /[A-Za-z0-9_]/.test(source[j])) {
        tag += source[j];
        j += 1;
      }
      if (tag && j < n && source[j] === '$') {
        dollarQuote = `$${tag}$`;
        out += dollarQuote; i += dollarQuote.length; prevChar = source[i - 1]; continue;
      }
    }

    if (TRIPLE_LANGS.has(lang) && (source.startsWith("'''", i) || source.startsWith('"""', i))) {
      quote = source.slice(i, i + 3); out += quote; i += 3; prevChar = source[i-1]; continue;
    }
    if (c === "'" || c === '"' || c === '`') { out += c; quote = c; i += 1; prevChar = c; continue; }

    // Unquoted parens inside a command-substitution frame track its depth;
    // the matching `)` closes the frame and resumes the enclosing string.
    if (frames.length > 0 && (c === '(' || c === ')')) {
      const frame = frames[frames.length - 1];
      frame.depth += c === '(' ? 1 : -1;
      if (frame.depth === 0) {
        frames.pop();
        out += c; i += 1; quote = frame.enclosing; lineStart = false; prevChar = c;
        continue;
      }
    }

    out += c; i += 1;
    if (c === '\n') {
      lineStart = true;
      prevChar = c;
    } else {
      lineStart = false;
      prevChar = c;
    }
  }
  return out;
}

const LANG_BY_EXT = {
  '.dart': 'dart',
  '.ts': 'ts', '.tsx': 'ts', '.js': 'ts', '.mjs': 'ts',
  '.kt': 'kotlin',
  '.css': 'css',
  '.sql': 'sql',
  '.sh': 'sh',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.env': 'env',
};

export function langFor(relativePath) {
  return LANG_BY_EXT[path.extname(relativePath)] ?? 'text';
}

// Dart has no `from` keyword; TS side-effect imports have no `from` either.
// TS/JS: only real module specifiers skip. `export const/function/class/
// default/type/enum` that happen to contain the English word "from"
// before a quote (`"Sea Trials from " + source`) must stay scannable —
// the previous `export\b.*\bfrom\s*['"`]` treated that as export-from
// (Codex review of PR #1655).
const MODULE_LINE = {
  dart: /^\s*(import|export|part)\b|^\s*part of\b/,
  ts: new RegExp(
    [
      '^\\s*import\\s+[\'"`]',
      '^\\s*require\\s*\\(',
      '^\\s*import\\b.*\\bfrom\\s*[\'"`]',
      '^\\s*export\\s+\\*\\s+from\\s*[\'"`]',
      '^\\s*export\\s+type\\s+\\*\\s+from\\s*[\'"`]',
      '^\\s*export\\s+(?:type\\s+)?\\{.*\\bfrom\\s*[\'"`]',
    ].join('|'),
  ),
};

export function isModuleLine(line, lang) {
  const re = MODULE_LINE[lang];
  return re ? re.test(line) : false;
}

// Dart adjacency with no newline and/or mismatched quote styles. The
// lookarounds stop a match that merely begins or ends against another
// quote; they do NOT protect ''' and """ runs, which is why those are
// masked out before this ever runs (see joinAdjacentLiterals).
const DART_ADJACENT =
  /(?<!['"])(['"])((?:[^'"\\\n]|\\.)*)\1\s*(['"])((?:[^'"\\\n]|\\.)*)\3(?!['"])/g;

// Triple-quote runs, masked to characters that cannot occur in Dart source
// and cannot open a string. Length is preserved, and neither mask contains
// a newline, so line numbers and offsets are untouched.
const TRIPLE_MASK = new Map([
  ["'''", '   '],
  ['"""', ''],
]);

/**
 * Joins implicit string concatenation so a brand split across two literals
 * is still seen. Applied to the whole file before line splitting; the
 * surviving line keeps the FIRST line's number.
 *
 * Two rules:
 *   1. Dart and SQL only: a literal closed and reopened with the SAME quote
 *      across a newline (`'a '\n'b'`). Both languages concatenate that,
 *      and it is what powersync's connector.dart does. TS/JS and sh do
 *      not — a newline there starts a new statement or word.
 *   2. Dart only: adjacency on ONE line and/or with a DIFFERENT quote style
 *      (`'Sea ' 'Trials'`, `'Sea ' "Trials"`). Added 2026-09-17 (Codex
 *      review of PR #1655) — the newline-only rule left these as two
 *      tokens, so a shipped brand written either way passed the ratchet.
 *
 * Rule 2 rewrites the whole PAIR (`'a' "b"` -> `'ab'`) instead of deleting
 * the two inner quotes, so the quote count stays balanced and stripComments
 * cannot desync over the rest of the file. It is Dart-only on purpose:
 * implicit concatenation is a Dart language feature, while in sh `"a" "b"`
 * is two argv entries and in TS/JS it is a syntax error — fusing those
 * would invent a brand the source never renders.
 *
 * Triple-quote runs are masked first. Without that, a line ending
 * `…'$.x')'''` pairs the closing quote of `'$.x'` with the run's FIRST
 * quote and takes the run's 2nd and 3rd as the second literal, rewriting
 * `')'''` to `')'` and deleting the terminator — after which stripComments
 * has string and code inverted for the rest of the file and a later `//`
 * can swallow a real leak. `fts_bootstrap.dart` has ten lines of exactly
 * that shape.
 *
 * Two known limits:
 *   - FAIL-OPEN, latent. Rule 2 cannot tell code from the inside of
 *     another string, so two quoted words within ONE string get fused:
 *     `'Say "Sea Trials" "now"'` becomes `'Say "Sea Trialsnow"'`, and the
 *     brand's trailing `(?![A-Za-z0-9])` guard — like persona's `\b` —
 *     then fails to match, DROPPING a hit. (It can equally invent one the
 *     rendered text never shows.) Zero occurrences across the scanned
 *     corpus today and no allowlist key moves, but a `.dart` string
 *     holding two double-quoted words, the first ending in the brand,
 *     USCG, mariner(s) or Coast Guard and the second starting with a
 *     letter or digit, is invisible to this scan. The principled fix is to
 *     join only over lexer-identified code regions — a refactor of
 *     stripComments, not a regex tweak.
 *   - A gap by choice: `'Sea ' + 'Trials'` is NOT joined, though `+` really
 *     does concatenate in both Dart and TS/JS. Joining across an operator
 *     would widen the rewrite to arbitrary expressions.
 * Both are recorded in the runbook's "What this does NOT cover".
 */
export function joinAdjacentLiterals(source, lang) {
  // Newline adjacency concatenates in Dart and SQL only. Applying the
  // same replace to TS/JS or sh fuses separate statements/words and can
  // hide a brand that sits at the end of the first literal.
  if (lang !== 'dart' && lang !== 'sql') return source;
  const joined = source.replace(/(['"])\s*\n\s*\1/g, '');
  if (lang !== 'dart') return joined;

  // The masks are only safe because no Dart source carries these code
  // points (0 of 3819 scanned files do, and neither can appear outside a
  // string literal). If one ever does, restoring would inject real quotes
  // into it, so skip rule 2 for that file instead: a missed join hides at
  // most one split literal there, while a corrupted restore inverts string
  // and code for everything after it.
  if (joined.includes(' ') || joined.includes('')) return joined;

  let out = joined.replace(/'''|"""/g, (run) => TRIPLE_MASK.get(run));
  // Bounded: each pass strictly shortens the source, and because a `/g`
  // replace joins every disjoint pair at once, a chain of N literals needs
  // log2(N) passes — 10 covers ~1000 literals in one expression.
  for (let pass = 0; pass < 10; pass += 1) {
    const next = out.replace(DART_ADJACENT, '$1$2$4$1');
    if (next === out) break;
    out = next;
  }
  for (const [run, mask] of TRIPLE_MASK) out = out.replaceAll(mask, run);
  return out;
}

export const FINGERPRINTS = {
  // Case-sensitive on the leading S: /sea.trials/i is ~90% import noise
  // (@seatrials/...). The lowercase-t variant is required for
  // admin_app/web/index.html:21. Guarded on both sides against adjacent
  // identifier characters (letters, digits, underscore): ~70 tracked lines
  // embed the brand inside a code identifier (SeaTrialsSemanticColors x31,
  // SeaTrialsBinding, _SeaTrialsPlugin, AIzaSeaTrialsRealKey test
  // fixtures, ...) and those are not brand leaks — the allowlist admission
  // rule forbids identifiers, and a later plan task calls an identifier
  // hit an engine bug. Still matches "SeaTrials", "Sea trials admin
  // panel", "Sea-Trials", "SeaTrials_Premium",
  // "LLC.SeaTrials-USCGLicenseExam", 'Sea Trials', "Sea Trials.app".
  // Rejects SeaTrialsSemanticColors.of(context), class _SeaTrialsPlugin,
  // AIzaSeaTrialsRealKey, kSeaTrialsSemanticsEnabled,
  // RouterSeaTrialsQuestionCardHost, SeaTrialsApp().
  brand: /(?<![A-Za-z0-9_])Sea[ -]?[Tt]rials(?![A-Za-z0-9])/,
  // #-form AND the Dart 0xFF.. ARGB form — app_colors.dart:27 is
  // Color(0xFF005bff), which a #-only regex misses entirely. No `Color(`
  // prefix is required: dart format splits a long `const Color(` from its
  // `0xFF005BFF,` argument onto separate lines, and the line-based scan
  // then never sees them together.
  hex: /#(005BFF|0059FF|183A67|11264A)|0x[fF]{2}(005BFF|0059FF|183A67|11264A)/i,
  // .com keeps seatrials.com out of client_app/web/robots.txt (its
  // comments named it until STD-2999), .ai covers the account-deletion
  // modal.
  domain: /seatrials\.(net|com|ai)/i,
  // Bare `Navigator` is deliberately absent — see spec §6.3.
  // Coast Guard is required for R2: the expert prompt has no USCG token.
  // `\bCoast Guard\b` also matches "U.S. Coast Guard". Do not add
  // mari* / maritime / marine (Marine Corps, Go Ham Marine Radio).
  persona: /\bmariners?\b|\bMariner\b|\bUSCG\b|\bCoast Guard\b/i,
};

export function matchesAny(line, fingerprints) {
  return Object.values(fingerprints).some((re) => re.test(line));
}

/** TS/JS lines may bundle `import …; export …;` — scan each statement. */
export function scannableSegments(rawLine, lang) {
  const trimmed = rawLine.trim();
  if (!trimmed) return [];
  if (lang !== 'ts' || !trimmed.includes(';')) return [trimmed];

  const segments = [];
  let start = 0;
  let quote = null;
  for (let i = 0; i < trimmed.length; i += 1) {
    const c = trimmed[i];
    if (quote) {
      if (c === quote && trimmed[i - 1] !== '\\') quote = null;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      quote = c;
      continue;
    }
    if (c === ';') {
      const seg = trimmed.slice(start, i).trim();
      if (seg) segments.push(seg);
      start = i + 1;
    }
  }
  const tail = trimmed.slice(start).trim();
  if (tail) segments.push(tail);
  return segments;
}

export function collectHits({
  repoRoot, roots, extensions, fingerprints,
  exemptFiles = new Map(), excludeSegments = [],
}) {
  const found = new Set();
  let filesScanned = 0;

  for (const relative of trackedFiles(repoRoot, roots, extensions)) {
    if (excludeSegments.some((seg) => `/${relative}`.includes(seg))) continue;
    if (exemptFiles.has(relative)) continue;
    filesScanned += 1;

    const lang = langFor(relative);
    const raw = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const code = joinAdjacentLiterals(stripComments(raw, lang), lang);

    code.split('\n').forEach((rawLine) => {
      for (const line of scannableSegments(rawLine, lang)) {
        if (!line || isModuleLine(line, lang)) continue;
        // Applied to the LINE only, never the path: 80 tracked paths contain
        // `sea_trials`, including a package named sea_trials_lints.
        if (matchesAny(line, fingerprints)) found.add(`${relative}::${line}`);
      }
    });
  }
  return { found, filesScanned };
}

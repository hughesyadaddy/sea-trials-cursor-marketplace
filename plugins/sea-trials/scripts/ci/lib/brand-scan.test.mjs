import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  trackedFiles, stripComments, langFor, isModuleLine, joinAdjacentLiterals,
  FINGERPRINTS, matchesAny, collectHits, scannableSegments,
} from './brand-scan.mjs';

/**
 * A throwaway git repo with the given tracked files (and optional
 * untracked ones). The engine lists files with `git ls-files`, so the
 * fixture needs a real index, not a bare directory tree. This module
 * ships in the sea-trials plugin, so no test here may read the app repo.
 *
 * @param {Record<string, string>} tracked repo-relative path → contents
 * @param {Record<string, string>} [untracked]
 */
function fixtureRepo(tracked, untracked = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-scan-'));
  const write = (rel, body) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  };
  for (const [rel, body] of Object.entries(tracked)) write(rel, body);
  execFileSync('git', ['-C', root, 'init', '-q']);
  execFileSync('git', ['-C', root, 'add', '-A']);
  for (const [rel, body] of Object.entries(untracked)) write(rel, body);
  return root;
}

test('trackedFiles returns tracked paths only, filtered by extension', () => {
  const repoRoot = fixtureRepo(
    {
      'flutter/packages/l10n/lib/l10n.dart': 'library l10n;\n',
      'flutter/packages/l10n/lib/arb/app_en.arb': '{}\n',
      'flutter/packages/other/lib/other.dart': 'library other;\n',
    },
    {
      // The gen_l10n output sits in the SAME directory as its .arb sources
      // and is gitignored. It exists on every developer machine and not in
      // a fresh CI checkout, and it contains `Sea Trials`. A filesystem
      // walk would include it and make the ratchet red locally / green in
      // CI.
      'flutter/packages/l10n/lib/app_localizations.dart':
        "const brand = 'Sea Trials';\n",
    },
  );
  try {
    const files = trackedFiles(repoRoot, ['flutter/packages/l10n'], ['.dart']);

    // Canary: a tracked file must be present, so a broken invocation
    // cannot silently return [] and make every ratchet vacuous.
    assert.deepEqual(files, ['flutter/packages/l10n/lib/l10n.dart']);
    assert.ok(
      !files.some((f) => f.includes('app_localizations')),
      'untracked generated l10n leaked into the scan set',
    );
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('stripComments keeps a URL that follows :// inside a string', () => {
  // Real line: admin_view_subscriptions_invoice_receipt_print.dart:17.
  // Rendered into a printed/emailed invoice PDF.
  const src = "const _kFallbackWebsiteUrl = 'https://seatrials.net';";
  assert.match(stripComments(src, 'dart'), /seatrials\.net/);
});

test('stripComments keeps jq\'s // alternative operator inside a shell string', () => {
  // Real line: codemagic.yaml:814. The `//` is jq syntax, not a comment.
  // indexOf('//') truncates this and loses the hex entirely.
  const src = `PRIMARY_COLOR=$(jq -r '.PRIMARY_COLOR // "#005BFF"' "$F")`;
  assert.match(stripComments(src, 'sh'), /#005BFF/);
});

test('stripComments removes a genuine trailing comment', () => {
  assert.doesNotMatch(
    stripComments("const x = 1; // Sea Trials was here", 'ts'),
    /Sea Trials/,
  );
});

test('stripComments removes block comments but preserves line count', () => {
  const src = 'a\n/* Sea Trials\n   more */\nb';
  const out = stripComments(src, 'ts');
  assert.doesNotMatch(out, /Sea Trials/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments handles SQL -- and shell # comments', () => {
  assert.doesNotMatch(stripComments("SELECT 1; -- Sea Trials", 'sql'), /Sea Trials/);
  assert.doesNotMatch(stripComments("echo hi # Sea Trials", 'sh'), /Sea Trials/);
  assert.match(stripComments('echo "#005BFF"', 'sh'), /#005BFF/);
});

test('stripComments keeps HTML -- inside SQL dollar-quoted strings', () => {
  const src = "$html$<!-- header --> Sea Trials$html$";
  assert.match(stripComments(src, 'sql'), /Sea Trials/);
  assert.match(stripComments(src, 'sql'), /<!-- header -->/);
});

test('stripComments keeps Dart raw and triple-quoted strings intact', () => {
  assert.match(stripComments(`final r = r'^Navigator\\s*:';`, 'dart'), /Navigator/);
  assert.match(stripComments(`final t = '''Sea Trials''';`, 'dart'), /Sea Trials/);
});

test('stripComments keeps multi-line shell strings intact', () => {
  const src = "echo 'first line\n# Sea Trials literal, not a comment\nthird line'";
  assert.match(stripComments(src, 'sh'), /Sea Trials/);
});

test('stripComments keeps multi-line SQL strings intact', () => {
  const src = "SELECT 'first\n-- Sea Trials literal\nlast';";
  assert.match(stripComments(src, 'sql'), /Sea Trials/);
});

test('stripComments keeps multi-line TypeScript template literals intact', () => {
  const src = "const html = `<p>\nVisit https://seatrials.net\n</p>`;";
  assert.match(stripComments(src, 'ts'), /seatrials\.net/);
});

test('stripComments handles shell heredocs with proper comment handling', () => {
  const src = "cat <<EOF\nDon't stop\n# Sea Trials body text\nEOF\necho '#005BFF' # Sea Trials comment";
  const out = stripComments(src, 'sh');
  assert.match(out, /Sea Trials body text/);
  assert.match(out, /#005BFF/);
  assert.doesNotMatch(out, /Sea Trials comment/);
});

test('stripComments only strips # when it starts a comment (not in variables)', () => {
  // ${#ARR[@]} should not be truncated
  assert.match(stripComments('echo ${#ARR[@]} Sea Trials', 'sh'), /Sea Trials/);
  // But a # at line start or after space should strip
  assert.doesNotMatch(stripComments('echo hi # Sea Trials', 'sh'), /Sea Trials/);
});

test('stripComments regresses single-line unterminated quotes correctly', () => {
  // Unterminated single-line quotes should still reset at newline
  const tsSrc = "const a = 'unterminated\nconst b = 1; // Sea Trials";
  assert.doesNotMatch(stripComments(tsSrc, 'ts'), /Sea Trials/);
  const dartSrc = "const a = 'unterminated\nconst b = 1; // Sea Trials";
  assert.doesNotMatch(stripComments(dartSrc, 'dart'), /Sea Trials/);
});

test('stripComments preserves line count in all multi-line cases', () => {
  const cases = [
    ["echo 'first\n# comment\nlast'", 'sh'],
    ["SELECT 'first\n-- comment\nlast';", 'sql'],
    ["const x = `first\n// url\nlast`;", 'ts'],
    ["cat <<EOF\nbody\nEOF", 'sh'],
  ];
  for (const [src, lang] of cases) {
    const out = stripComments(src, lang);
    assert.equal(out.split('\n').length, src.split('\n').length, `line count mismatch for ${lang}`);
  }
});

test('stripComments does not treat here-strings as heredocs', () => {
  // <<< is not a heredoc, it's a here-string redirect
  const src = 'read foo <<< "$bar"\necho hi # Sea Trials should be stripped\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials should be stripped/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments does not treat arithmetic shifts as heredocs', () => {
  // << in arithmetic context is not a heredoc
  const src = 'x=$(( 1 << 2 ))\necho hi # Sea Trials should be stripped\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials should be stripped/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments handles heredoc redirect line comments correctly', () => {
  // Comment on the redirect line should be stripped, body preserved
  const src = 'cat <<EOF # Sea Trials note\nbody Sea Trials kept\nEOF\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials note/);
  assert.match(out, /body Sea Trials kept/);
});

test('stripComments treats missing heredoc terminator as normal code', () => {
  // If the terminator line is not found, it is not a heredoc
  const src = 'cat <<EOF\necho hi # Sea Trials\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials/);
});

test('stripComments handles heredoc with dash variant and quoted terminator', () => {
  // <<-'END' with leading tabs in body and terminator line
  const src = "cat <<-'END'\n\t# Sea Trials body\n\tEND\necho x # Sea Trials after";
  const out = stripComments(src, 'sh');
  assert.match(out, /# Sea Trials body/);
  assert.doesNotMatch(out, /Sea Trials after/);
});

test('stripComments quotes in heredoc redirect line preserve hash content', () => {
  // Hash inside quoted string on redirect line should not be treated as comment
  const src = 'cat <<EOF "note # Sea Trials leak"\nbody\nEOF\n';
  const out = stripComments(src, 'sh');
  assert.match(out, /Sea Trials leak/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments does not treat mysql here-strings as heredocs', () => {
  // Missing test from earlier rules
  const src = 'mysql -u root <<< "SELECT 1;"\n# Sea Trials trailing comment\necho done\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials trailing comment/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments handles heredoc redirect line comments with body preservation', () => {
  // Comment on redirect line is stripped, but body is preserved with proper line handling
  const src = 'cat <<EOF # Sea Trials note\n# Sea Trials body\nEOF\necho x # after Sea Trials';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials note/);
  assert.match(out, /# Sea Trials body/);
  assert.doesNotMatch(out, /after Sea Trials/);
});

test('stripComments lexes sh $( ) nested in double quotes (deploy_supabase_backend.sh:868-871)', () => {
  // The sed's single-quoted `"` characters used to pair with the enclosing
  // string, so the closing `)"` opened a string that ran for 700 lines and
  // kept every comment inside it.
  // A backslash right before a closing backtick escapes it even in
  // String.raw, so the shell line-continuation `\` is appended separately.
  const cont = '\\';
  const src = [
    String.raw`deb_url="$(curl -fsSL https://api.github.com/repos/supabase/cli/releases/latest 2>/dev/null ` + cont,
    String.raw`    | grep -o "\"browser_download_url\": *\"[^\"]*linux_$` + '{arch}' + String.raw`\.deb\"" ` + cont,
    String.raw`    | head -1 ` + cont,
    String.raw`    | sed -E 's/.*"(https:[^"]+)".*/\1/' || true)"`,
    String.raw`if [[ -z "$deb_url" ]]; then`,
    String.raw`    echo "no url" >&2 # Sea Trials trailing`,
    'fi',
    '# Sea Trials comment',
    'echo done',
  ].join('\n');
  const out = stripComments(src, 'sh');
  assert.match(out, /sed -E 's\/\.\*"\(https:/);
  assert.doesNotMatch(out, /Sea Trials trailing/);
  assert.doesNotMatch(out, /Sea Trials comment/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments keeps a double-quoted string inside $( ) inside double quotes', () => {
  const plain = 'x="$(echo "inner Sea Trials")"\n# Sea Trials after\n';
  const out = stripComments(plain, 'sh');
  assert.match(out, /inner Sea Trials/);
  assert.doesNotMatch(out, /Sea Trials after/);
  // The inner string's `#` is not a comment: before the frame fix the inner
  // quotes read as "outside", so `# Sea Trials` was stripped (false negative).
  const hashed = 'x="$(echo "inner # Sea Trials")"\n';
  assert.match(stripComments(hashed, 'sh'), /inner # Sea Trials/);
});

test('stripComments handles nested and arithmetic command substitutions in double quotes', () => {
  const nested = `y="$(a "$(b 'Sea Trials')")"\n# Sea Trials after\n`;
  const out = stripComments(nested, 'sh');
  assert.match(out, /'Sea Trials'/);
  assert.doesNotMatch(out, /Sea Trials after/);
  assert.equal(out.split('\n').length, nested.split('\n').length);

  // A single-quoted `"` in the outer frame used to desync the whole tail.
  const withSed = `y="$(a 's/"//' "$(b 'Sea Trials')")"\n# Sea Trials after\necho ok\n`;
  const out2 = stripComments(withSed, 'sh');
  assert.match(out2, /'Sea Trials'/);
  assert.doesNotMatch(out2, /Sea Trials after/);
  assert.equal(out2.split('\n').length, withSed.split('\n').length);

  const arith = `z="$(( 1 + (2) ))" # Sea Trials arith\necho "Sea Trials kept"\n`;
  const out3 = stripComments(arith, 'sh');
  assert.doesNotMatch(out3, /Sea Trials arith/);
  assert.match(out3, /Sea Trials kept/);
});

test('stripComments applies no command-substitution frames outside sh', () => {
  // Under a leaked frame the second `"` would open an inner string and keep
  // the // comment; TS must still strip it.
  const ts = 'const s = "$(a " + b; // Sea Trials ts comment\nconst t = 1;';
  const out = stripComments(ts, 'ts');
  assert.doesNotMatch(out, /Sea Trials ts comment/);
  assert.equal(out.split('\n').length, ts.split('\n').length);
  const same = 'x="$(echo "inner # Sea Trials")"\n# y';
  assert.equal(stripComments(same, 'ts'), same);
});

test('stripComments honours sh backslash escapes outside quotes inside $( ) frames', () => {
  // An escaped quote in a frame used to open a real quote, leak the frame,
  // and let the `case` pattern's `)` reopen a phantom string that ate the
  // `# Sea Trials` of a later real string (false negative).
  const probe = 'x="$(echo \\"hi\\")"\ncase "$v" in a) echo ok ;; esac\necho "keep2 # Sea Trials"\n';
  const out = stripComments(probe, 'sh');
  assert.match(out, /keep2 # Sea Trials/);
  assert.equal(out.split('\n').length, probe.split('\n').length);

  // An escaped apostrophe used to open a multi-line single quote that kept
  // every later comment (false positive).
  const apostrophe = "x=\"$(echo It\\'s)\"\n# Sea Trials comment\necho done\n";
  const out2 = stripComments(apostrophe, 'sh');
  assert.doesNotMatch(out2, /Sea Trials comment/);
  assert.equal(out2.split('\n').length, apostrophe.split('\n').length);

  // An escaped paren is literal and must not move the frame's depth.
  const paren = 'x="$(echo \\( Sea)"\n# Sea Trials comment\n';
  assert.doesNotMatch(stripComments(paren, 'sh'), /Sea Trials comment/);
});

test('stripComments treats an unquoted sh \\# as literal and keeps continuation newlines', () => {
  assert.match(stripComments('echo \\# Sea Trials\n', 'sh'), /Sea Trials/);
  const cont = 'echo a \\\n  b # Sea Trials after\necho c\n';
  const out = stripComments(cont, 'sh');
  assert.equal(out.split('\n').length, cont.split('\n').length);
  assert.doesNotMatch(out, /Sea Trials after/);
});

test('stripComments keeps backslashes literal inside sh single quotes', () => {
  const src = "path='C:\\'\nprintf ' # Sea Trials'\n";
  const out = stripComments(src, 'sh');
  assert.match(out, /# Sea Trials/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments handles backslash-quoted heredoc delimiters', () => {
  const src = "cat <<\\EOF\n# Sea Trials body\nEOF\n";
  const out = stripComments(src, 'sh');
  assert.match(out, /# Sea Trials body/);
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('langFor maps extensions to lexer dialects', () => {
  assert.equal(langFor('a/b.dart'), 'dart');
  assert.equal(langFor('a/b.tsx'), 'ts');
  assert.equal(langFor('a/b.css'), 'css');
  assert.equal(langFor('a/MainActivity.kt'), 'kotlin');
  assert.equal(langFor('a/b.sql'), 'sql');
  assert.equal(langFor('a/b.sh'), 'sh');
  assert.equal(langFor('codemagic.yaml'), 'yaml');
  assert.equal(langFor('extensions/x.env'), 'env');
  assert.equal(langFor('web/robots.txt'), 'text');
});

test('stripComments lexes Kotlin comments, strings and raw strings', () => {
  // The Android shell root is scanned, and a tenant-visible native string
  // (a toast, a notification-channel name, a dialog title) lives in .kt.
  const src = [
    '// Sea Trials in a line comment',
    '/* Sea Trials in a block comment */',
    'val channel = "Sea Trials alerts"',
    'val url = "https://seatrials.net/help"',
    'val raw = """Sea Trials raw"""',
  ].join('\n');
  const out = stripComments(src, 'kotlin');

  assert.doesNotMatch(out, /line comment/, 'Kotlin // comment survived');
  assert.doesNotMatch(out, /block comment/, 'Kotlin /* */ comment survived');
  assert.match(out, /Sea Trials alerts/, 'Kotlin string literal was stripped');
  assert.match(out, /seatrials\.net\/help/, '// inside a Kotlin string was read as a comment');
  assert.match(out, /Sea Trials raw/, 'Kotlin raw string was stripped');
});

test('stripComments does not treat // as a comment in CSS', () => {
  const src = '.hero { background: url(https://cdn.example/SeaTrials.svg); }';
  assert.match(stripComments(src, 'css'), /SeaTrials\.svg/);
});

test('isModuleLine matches Dart import/export/part, which carry no "from"', () => {
  for (const line of [
    "import 'package:sea_trials_lints/sea_trials_lints.dart';",
    "export 'src/sea_trials_binding.dart';",
    "part 'app_configs.g.dart';",
    'part of sea_trials;',
  ]) {
    assert.ok(isModuleLine(line, 'dart'), `should be a module line: ${line}`);
  }
  assert.ok(!isModuleLine("const x = 'Sea Trials';", 'dart'));
});

test('isModuleLine matches TS import/export-from and side-effect imports', () => {
  assert.ok(isModuleLine("import { Button } from '@seatrials/ui';", 'ts'));
  assert.ok(isModuleLine("export { x } from './y';", 'ts'));
  assert.ok(isModuleLine("import '@seatrials/ui/styles.css';", 'ts'));
  assert.ok(!isModuleLine("const name = 'Sea Trials';", 'ts'));
});

test('joinAdjacentLiterals reunites a brand split across two literals', () => {
  // Real: powersync connector.dart:5070-5071 splits the brand so neither
  // line matches on its own.
  const src = "'$home/Library/Application Support/com.MarinerLicensePrep.Sea '\n"
    + "'Trials/upload_diag.jsonl';";
  assert.match(joinAdjacentLiterals(src, 'dart'), /Sea Trials/);
});

test('joinAdjacentLiterals reunites same-line and mixed-quote Dart adjacency', () => {
  // Dart concatenates adjacent literals with no operator between them, and
  // the two quote styles need not match. Neither form carries a newline, so
  // the newline-only rule left them as two tokens and the line scan never
  // saw a contiguous brand — a shipped literal written either way passed
  // the ratchet (Codex review of PR #1655).
  for (const src of [
    "const label = 'Sea ' 'Trials';",
    'const label = \'Sea \' "Trials";',
    'const label = "Sea " \'Trials\';',
    'const label = \'Sea \'\n    "Trials";',
    "const label = 'Sea ' 'Tri' 'als';",
  ]) {
    const joined = joinAdjacentLiterals(src, 'dart');
    assert.match(joined, /Sea Trials/, `not reunited: ${JSON.stringify(src)}`);
    assert.ok(
      joined.split('\n').some((line) => matchesAny(line.trim(), FINGERPRINTS)),
      `no line matches after joining: ${JSON.stringify(src)}`,
    );
  }
});

test('joinAdjacentLiterals leaves separated and triple-quoted Dart alone', () => {
  // Only whitespace may sit between adjacent literals. A comma or a colon
  // means two separate values, and fusing them would invent a brand the
  // source never renders. `+` is different: it really does concatenate in
  // Dart, so `'Sea ' + 'Trials'` IS a brand the app shows — joining across
  // an operator would widen this rewrite to arbitrary expressions, so it
  // stays a deliberate gap, listed in the runbook. This pins the current
  // behaviour; it is not a claim that `+` renders nothing.
  for (const src of [
    "const xs = ['Sea ', 'Trials'];",
    "const s = 'Sea ' + 'Trials';",
    "const m = {'Sea ': 'Trials'};",
    // A ''' run must not be read as an empty literal followed by another:
    // rewriting it would unbalance the quotes for stripComments.
    "const s = '''\nSea Trials\n''';",
  ]) {
    assert.equal(joinAdjacentLiterals(src, 'dart'), src,
      `must not rewrite: ${JSON.stringify(src)}`);
  }
});

test('joinAdjacentLiterals never eats a Dart triple-quote terminator', () => {
  // Real shape: powersync's fts_bootstrap.dart closes a ''' SQL block on a
  // line that already ends in a quoted string —
  //   json_extract(NEW.data, '$.username')'''
  // The closing quote of '$.username' pairs with the FIRST quote of the '''
  // run, so a pair rewrite that only guards its outer edges consumes two of
  // the run's three quotes and destroys the terminator. stripComments then
  // has string and code inverted for the rest of the file, and a later `//`
  // (in, say, an https:// URL) eats a real leak. This one is fail-OPEN, so
  // it is the rewrite this function must never make.
  for (const src of [
    "const q = '''\nSELECT json_extract(NEW.data, '$.username')''';",
    'const q = """\nSELECT json_extract(NEW.data, "$.username")""";',
  ]) {
    assert.equal(joinAdjacentLiterals(src, 'dart'), src,
      `destroyed a triple-quote terminator: ${JSON.stringify(src)}`);
  }
});

test('joinAdjacentLiterals does not fuse separate shell arguments', () => {
  // Implicit concatenation is a Dart language feature. In sh, `"a" "b"` is
  // two argv entries, and joining them would manufacture a brand string
  // that no line of the script contains.
  const src = 'echo "Sea" "Trials"';
  assert.equal(joinAdjacentLiterals(src, 'sh'), src);
});

test('joinAdjacentLiterals does not fuse TS or sh literals across a newline', () => {
  // Same-quote literals on consecutive lines concatenate in Dart and SQL.
  // In TS/JS they are separate statements (ASI); in sh they are separate
  // words. The old language-agnostic newline replace fused
  // `"Sea Trials"\n"now"` into `"Sea Trialsnow"`, and the brand
  // boundary then missed the tenant-visible first value.
  const ts = 'const label = "Sea Trials"\n"now".toString();\n';
  const sh = 'echo "Sea Trials"\n"now"\n';
  const tsJoined = joinAdjacentLiterals(ts, 'ts');
  const shJoined = joinAdjacentLiterals(sh, 'sh');
  assert.equal(tsJoined, ts);
  assert.equal(shJoined, sh);
  assert.ok(
    tsJoined.split('\n').some((line) => matchesAny(line.trim(), FINGERPRINTS)),
    'TS brand must still match after a no-op join',
  );
  assert.ok(
    shJoined.split('\n').some((line) => matchesAny(line.trim(), FINGERPRINTS)),
    'sh brand must still match after a no-op join',
  );

  // SQL still concatenates same-quote newlines (rule 1). Dropping `sql`
  // from the join allow-list must make this FAIL.
  assert.match(
    joinAdjacentLiterals("'Sea '\n'Trials'", 'sql'),
    /Sea Trials/,
  );
});

test('collectHits pipeline strips comments before joining adjacent literals', () => {
  const src = "const xs = [\n  // old label '\n  'Sea Trials',\n];";
  const code = joinAdjacentLiterals(stripComments(src, 'ts'), 'ts');
  assert.match(code, /Sea Trials/);
  assert.ok(
    code.split('\n').some((line) => matchesAny(line.trim(), FINGERPRINTS)),
    'brand in comment-adjacent literal must survive the pipeline',
  );
});

test('isModuleLine requires a quote after "from" in TS to avoid matching brand literals', () => {
  // These contain "from" but are NOT module lines (brand literal assignments)
  assert.ok(!isModuleLine("export const from = 'Sea Trials';", 'ts'));
  assert.ok(!isModuleLine("export const label = brand.from + 'Sea Trials';", 'ts'));

  // These ARE module lines (from followed by a quote)
  assert.ok(isModuleLine("export * from './y';", 'ts'));
  assert.ok(isModuleLine("import type { A } from \"@seatrials/ui\";", 'ts'));
});

test('isModuleLine does not treat from-inside-a-string as an export-from', () => {
  // Codex review of PR #1655: MODULE_LINE was `export` + any `\bfrom\s*['"`]`
  // on the same line, so a tenant-visible string that happens to contain
  // the English word "from" before a quote was skipped before fingerprints
  // ran. Real re-exports still skip; value exports do not.
  for (const line of [
    'export const label = "Sea Trials from " + source;',
    "export const support = \"Email us from 'support@seatrials.net'\";",
    'export function greet() { return "Sea Trials from " + source; }',
    'export async function greet() { return "from \'x\'"; }',
    'export class Copy { label = "from \'here\'"; }',
    'export default "Sea Trials from " + source;',
    'export type Brand = "Sea Trials from \'x\'";',
    'export enum Tone { From = "from \'x\'" }',
  ]) {
    assert.ok(
      !isModuleLine(line, 'ts'),
      `value export must stay scannable: ${line}`,
    );
  }
  for (const line of [
    "export { x } from './y';",
    "export * from './y';",
    'export type { A } from "./y";',
    "export type * from './y';",
    "import { Button } from '@seatrials/ui';",
    "import type { A } from '@seatrials/ui';",
    "import '@seatrials/ui/styles.css';",
  ]) {
    assert.ok(isModuleLine(line, 'ts'), `must stay a module line: ${line}`);
  }
});

test('brand fingerprint catches the lowercase-t admin variant', () => {
  // flutter/apps/admin_app/web/index.html:21 — "Sea trials admin panel".
  assert.ok(matchesAny('content="Sea trials admin panel"', FINGERPRINTS));
  assert.ok(matchesAny('const a = "Sea Trials";', FINGERPRINTS));
  assert.ok(matchesAny('const a = "SeaTrials";', FINGERPRINTS));
  // The lowercase package scope is an import specifier, never a leak.
  assert.ok(!matchesAny('const a = seatrials_helper;', FINGERPRINTS));
});

test('brand fingerprint ignores identifiers that embed the brand', () => {
  // R-4a: the brand fingerprint must not fire on code identifiers that
  // merely embed the brand token (SeaTrialsSemanticColors x31,
  // _SeaTrialsPlugin, AIzaSeaTrialsRealKey test fixtures, ...).
  assert.ok(!matchesAny('final c = SeaTrialsSemanticColors.of(context);', FINGERPRINTS));
  assert.ok(!matchesAny('class _SeaTrialsPlugin {', FINGERPRINTS));
  assert.ok(!matchesAny("const k = 'AIzaSeaTrialsRealKey';", FINGERPRINTS));
});

test('hex fingerprint catches the Dart Color(0x..) form and lowercase hex', () => {
  // app_colors.dart:27 is Color(0xFF005bff) — no '#', lowercase.
  assert.ok(matchesAny('static const Color blue = Color(0xFF005bff);', FINGERPRINTS));
  assert.ok(matchesAny('fill="#005BFF"', FINGERPRINTS));
  assert.ok(matchesAny('const navy = "#11264A";', FINGERPRINTS));
  assert.ok(!matchesAny('static const Color x = Color(0xFF02569B);', FINGERPRINTS));
});

test('hex fingerprint catches an ARGB literal that dart format split from Color(', () => {
  // dart format breaks `const Color(0xFF005BFF)` across lines when the
  // declaration is long, leaving `0xFF005BFF,` alone on its own line.
  assert.ok(matchesAny('0xFF005BFF,', FINGERPRINTS));
  const lines = stripComments(
    joinAdjacentLiterals('static const Color blue = Color(\n    0xFF005bff,\n  );', 'dart'),
    'dart',
  ).split('\n');
  assert.ok(lines.some((line) => matchesAny(line.trim(), FINGERPRINTS)));
  assert.ok(!matchesAny('0xFF02569B,', FINGERPRINTS));
});

test('domain fingerprint covers .net, .com and .ai', () => {
  assert.ok(matchesAny("'https://seatrials.net'", FINGERPRINTS));
  assert.ok(matchesAny('# goes to seatrials.com', FINGERPRINTS));
  assert.ok(matchesAny("?? 'support@seatrials.ai'", FINGERPRINTS));
});

test('persona fingerprint covers mariners, USCG and Coast Guard but NOT bare Navigator', () => {
  assert.ok(matchesAny('"Tips from fellow mariners"', FINGERPRINTS));
  assert.ok(matchesAny('"Official USCG answers"', FINGERPRINTS));
  // R2 expert prompt says "U.S. Coast Guard" with no USCG token.
  assert.ok(matchesAny(
    '"You are a U.S. Coast Guard License Examination Validation Expert."',
    FINGERPRINTS,
  ));
  assert.ok(matchesAny('"the Coast Guard just released"', FINGERPRINTS));
  // 287 of 424 flutter Navigator hits are the Flutter API; the densest
  // remainder is the sanitizer that REMOVES the persona.
  assert.ok(!matchesAny('Navigator.of(context).pop();', FINGERPRINTS));
  // Do not widen to mari* / maritime / marine — Marine Corps, Go Ham
  // "Marine Radio", and "maritime exam" comments are not brand leaks.
  assert.ok(!matchesAny('"marine radio endorsement"', FINGERPRINTS));
  assert.ok(!matchesAny('"maritime exam question expert"', FINGERPRINTS));
});

test('collectHits skips exempt files and excluded path segments', () => {
  // collectHits lists files with `git ls-files`, so the fixture is a real
  // repo: one .html under admin_app/web whose description meta tag carries
  // the lowercase-t brand, plus a clean sibling so exempting or excluding
  // the leaky file changes the scanned count by exactly one.
  const indexHtml = 'flutter/apps/admin_app/web/index.html';
  const repoRoot = fixtureRepo({
    [indexHtml]: [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '<meta name="description" content="Sea trials admin panel">',
      '</head>',
      '</html>',
      '',
    ].join('\n'),
    'flutter/apps/admin_app/web/clean.html': '<html></html>\n',
  });
  try {
    const scan = (options) => collectHits({
      repoRoot,
      roots: ['flutter/apps/admin_app/web'],
      extensions: ['.html'],
      fingerprints: FINGERPRINTS,
      ...options,
    });
    const hasAdminHit = ({ found }) => [...found].some(
      (e) => e === `${indexHtml}::<meta name="description" content="Sea trials admin panel">`,
    );

    // 1. Nothing exempt or excluded: the hit is found.
    const open = scan({ exemptFiles: new Map(), excludeSegments: [] });
    assert.equal(open.filesScanned, 2, 'scanned nothing — roots wrong');
    assert.ok(hasAdminHit(open), 'the lowercase-t admin description was not caught');

    // 2. The same file in exemptFiles: the hit is gone and one file fewer
    // is scanned.
    const exempt = scan({
      exemptFiles: new Map([[indexHtml, 'fixture reason']]),
      excludeSegments: [],
    });
    assert.ok(!hasAdminHit(exempt), `${indexHtml} is exempt but was still scanned`);
    assert.equal(exempt.filesScanned, open.filesScanned - 1);

    // 3. A segment matching its path: the hit is gone the same way.
    const excluded = scan({
      exemptFiles: new Map(),
      excludeSegments: ['/web/index.'],
    });
    assert.ok(!hasAdminHit(excluded), `${indexHtml} is excluded but was still scanned`);
    assert.equal(excluded.filesScanned, open.filesScanned - 1);
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('collectHits skips a fingerprint that sits only in a comment', () => {
  // Tracked files whose ONLY fingerprint text is a comment: a Dart doc
  // comment and a SQL line comment that also quotes the brand.
  const fixtures = {
    'flutter/packages/test_utils/lib/test_utils.dart': [
      '/// Shared helpers for Sea Trials widget tests.',
      'library test_utils;',
      '',
      "const appName = 'fixture';",
      '',
    ].join('\n'),
    'supabase/templates/email_outbox.sql': [
      'create table if not exists email_outbox (',
      '  id bigint primary key',
      ');',
      "-- Sender defaults to the 'Sea Trials' brand mailbox.",
      '',
    ].join('\n'),
  };
  const repoRoot = fixtureRepo(fixtures);
  try {
    for (const [file, raw] of Object.entries(fixtures)) {
      assert.ok(
        raw.split('\n').some((line) => matchesAny(line, FINGERPRINTS)),
        `${file} has no raw fingerprint line; fixture is wrong`,
      );
      const { found, filesScanned } = collectHits({
        repoRoot,
        roots: [file],
        extensions: [path.extname(file)],
        fingerprints: FINGERPRINTS,
      });
      assert.equal(filesScanned, 1, `${file} was not scanned`);
      assert.deepEqual(
        [...found], [],
        `${file}: a comment-only fingerprint was reported`,
      );
    }
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

test('scannableSegments keeps value exports after a same-line import', () => {
  const line = "import x from 'pkg'; export const label = 'Sea Trials';";
  const segments = scannableSegments(line, 'ts');
  assert.ok(segments.some((seg) => isModuleLine(seg, 'ts')), 'import segment');
  assert.ok(
    segments.some(
      (seg) => !isModuleLine(seg, 'ts') && matchesAny(seg, FINGERPRINTS),
    ),
    'value export segment after import was skipped',
  );
});

test('scannableSegments ignores semicolons inside string literals', () => {
  const line =
    'const label = "Help; import \'Sea Trials\'"; export const x = 1;';
  const segments = scannableSegments(line, 'ts');
  assert.equal(segments.length, 2, 'const + export, not a fake import segment');
  assert.ok(
    segments.every((seg) => !/^import\b/.test(seg)),
    'string semicolon must not yield a module segment',
  );
});

test('stripComments treats shell ;# as comment start without whitespace', () => {
  const src = "true;# Sea Trials\nprintf '%s\\n' 'prefix # ok'";
  assert.doesNotMatch(stripComments(src, 'sh'), /Sea Trials/);
  assert.match(stripComments(src, 'sh'), /prefix # ok/);
});

test('stripComments treats every shell control operator as a comment boundary', () => {
  // Verified against bash 3.2 on 2026-09-17: `#` begins a comment when the
  // preceding unquoted character is whitespace, a line start, or one of
  // ; & | ( ) — `true&# x '` parses and runs. If the `#` is NOT recognised,
  // the trailing quote opens a string that swallows the newline, re-pairs
  // against line 2's quotes and leaves `# Sea Trials` looking like a
  // comment, so the shipped literal vanishes from the scanned view.
  for (const op of [';', '&', '|', '(', ')']) {
    const src = `true${op}# old '\nprintf '%s\\n' 'prefix # Sea Trials'\n`;
    assert.match(
      stripComments(src, 'sh'),
      /Sea Trials/,
      `\`${op}#\` did not end the command, so the shipped literal was stripped`,
    );
  }
});

test('stripComments does not mistake ${#array[@]} for a shell comment', () => {
  // The control-operator boundary above must stay narrow: `{` is parameter
  // expansion, not an operator. 77 tracked builder lines use this form, and
  // treating it as a comment would blank the rest of each line.
  const src = 'if [ ${#FAILED[@]} -gt 0 ]; then\n  echo "Sea Trials failed"\nfi\n';
  const out = stripComments(src, 'sh');
  assert.match(out, /\$\{#FAILED\[@\]\}/, 'parameter expansion was eaten as a comment');
  assert.match(out, /Sea Trials failed/);
});

test('stripComments accepts heredoc delimiters containing punctuation', () => {
  // `<<END-HTML` is a valid shell WORD (verified with bash on 2026-09-17).
  // An identifier-only parser reads the delimiter as `END`, never finds
  // that line, and falls back to lexing the body as shell code — which
  // strips the `# Sea Trials` heading out of a generated tenant asset.
  const src = 'cat <<END-HTML > out.md\n# Sea Trials\nbody\nEND-HTML\n';
  const out = stripComments(src, 'sh');
  assert.match(out, /# Sea Trials/, 'heredoc body was lexed as shell code');
  assert.equal(out.split('\n').length, src.split('\n').length);
});

test('stripComments still rejects <<< here-strings as heredocs', () => {
  // The widened WORD parser must not start swallowing here-string operands:
  // 33 tracked builder lines use `read -ra X <<< "$Y"`.
  const src = 'read -ra PARTS <<< "$INPUT"\n# Sea Trials\n';
  const out = stripComments(src, 'sh');
  assert.doesNotMatch(out, /Sea Trials/, 'a here-string was treated as a heredoc');
});

test('stripComments does not read /* inside a TS regex literal as a comment', () => {
  // `/[/*]/` is a valid regex (verified with node on 2026-09-17). Reading
  // its `/*` as a block-comment opener discards everything up to the next
  // `*/` — and when the file has none, the whole remainder of the file,
  // so every later tenant-visible literal disappears from the scan.
  const src = 'const delimiter = /[/*]/;\nconst label = "Sea Trials";\n';
  assert.match(stripComments(src, 'ts'), /Sea Trials/, 'a regex literal swallowed the file');
});

test('stripComments keeps a regex used as a brace-less control-flow body', () => {
  // Codex review of PR #1655: lastSignificant(out) is `)` after
  // `if (ready)`, so tryParseRegexLiteral treated `/[/*]/` as division
  // and the `/*` ate the rest of the file. Assignment (`const x = /…/`)
  // is already pinned above; this is the statement-position case.
  // Mutating the control-flow check off must make this FAIL.
  for (const src of [
    'if (ready) /[/*]/.test(x);\nconst label = "Sea Trials";\n',
    'while (ready) /[/*]/.test(x);\nconst label = "Sea Trials";\n',
    'for (;;) /[/*]/.test(x);\nconst label = "Sea Trials";\n',
    'if (ready && foo()) /[/*]/.test(x);\nconst label = "Sea Trials";\n',
  ]) {
    assert.match(
      stripComments(src, 'ts'),
      /Sea Trials/,
      `control-flow regex swallowed the file: ${JSON.stringify(src)}`,
    );
  }
});

test('stripComments still strips real TS block and line comments', () => {
  // Guard the regex-literal fix against the opposite error: division and
  // genuine comments must keep their current meaning.
  const block = 'const a = 1;\n/* Sea Trials note */\nconst b = 2;\n';
  assert.doesNotMatch(stripComments(block, 'ts'), /Sea Trials/, 'block comment survived');

  const line = 'const a = 1; // Sea Trials note\n';
  assert.doesNotMatch(stripComments(line, 'ts'), /Sea Trials/, 'line comment survived');

  const division = 'const ratio = width / height;\nconst label = "Sea Trials";\n';
  assert.match(stripComments(division, 'ts'), /Sea Trials/, 'division was read as a regex');

  // Control-flow recognition must not treat `foo() / bar` as a regex start.
  const afterCall = 'const ratio = foo() / height;\nconst label = "Sea Trials";\n';
  assert.match(
    stripComments(afterCall, 'ts'),
    /Sea Trials/,
    'division after a call was read as a regex',
  );
});

test('collectHits skips a fingerprint that sits only on a module line', () => {
  // The noise the skip exists for: the lowercase `@seatrials/` package
  // scope, on a file where it appears on its import line and nowhere else.
  const file = 'web/apps/marketing/app/_actions/storage.ts';
  const scope = /@seatrials\//;
  const raw = [
    "'use server';",
    '',
    "import { createStorageClient } from '@seatrials/storage-client';",
    '',
    'export async function upload(name: string) {',
    '  return createStorageClient().upload(name);',
    '}',
    '',
  ].join('\n');
  const scopeLines = raw.split('\n').map((l) => l.trim()).filter((l) => scope.test(l));
  assert.ok(scopeLines.length > 0, 'fixture must import @seatrials/');
  assert.ok(
    scopeLines.every((l) => isModuleLine(l, 'ts')),
    'fixture uses @seatrials/ outside an import',
  );
  const repoRoot = fixtureRepo({ [file]: raw });
  try {
    const { found, filesScanned } = collectHits({
      repoRoot,
      roots: [file],
      extensions: ['.ts'],
      fingerprints: { scope },
    });
    assert.equal(filesScanned, 1, `${file} was not scanned`);
    assert.deepEqual([...found], [], 'a module line was reported as a hit');
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  }
});

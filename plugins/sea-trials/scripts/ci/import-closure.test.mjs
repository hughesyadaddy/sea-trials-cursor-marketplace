import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  localImportClosure,
  relativeSpecifiers,
  scanSpecifiers,
  stripCommentsAndStrings,
} from './import-closure.mjs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-'));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  return dir;
}

test('relative specifiers are collected and bare ones ignored', () => {
  const specs = relativeSpecifiers(`
    import fs from 'node:fs';
    import a from './a.mjs';
    import { b } from '../lib/b.mjs';
    export { c } from './c.mjs';
    const d = await import('./d.mjs');
    import 'package:whatever';
  `);
  assert.deepEqual(specs, [
    '../lib/b.mjs',
    './a.mjs',
    './c.mjs',
    './d.mjs',
  ]);
});

test('the closure follows imports transitively', () => {
  const dir = fixture({
    'entry.mjs': "import './mid.mjs';",
    'mid.mjs': "import '../lib/leaf.mjs';",
    '../lib/leaf.mjs': 'export const x = 1;',
  });
  // The fixture writes ../lib relative to dir, so re-root one level up.
  const root = path.dirname(dir);
  const entry = path.join(path.basename(dir), 'entry.mjs');
  const { files, unresolved } = localImportClosure(entry, root);
  assert.deepEqual(unresolved, []);
  assert.ok(files.some((f) => f.endsWith('leaf.mjs')), files.join(','));
  assert.equal(files.length, 3);
});

test('a cycle terminates instead of hanging', () => {
  const dir = fixture({
    'a.mjs': "import './b.mjs';",
    'b.mjs': "import './a.mjs';",
  });
  const { files } = localImportClosure('a.mjs', dir);
  assert.deepEqual(files, ['a.mjs', 'b.mjs']);
});

test('a missing import is reported, never silently dropped', () => {
  // A silent skip is how a dependency goes unfingerprinted, so the
  // walker must surface it rather than shrink the closure.
  const dir = fixture({ 'a.mjs': "import './gone.mjs';" });
  const { files, unresolved } = localImportClosure('a.mjs', dir);
  assert.deepEqual(files, ['a.mjs']);
  assert.deepEqual(unresolved, ['gone.mjs']);
});

test('the real audit runner closure includes both hook helpers', () => {
  // Pins the actual graph the pass-cache guard depends on: if these
  // imports move, the guard must be updated deliberately.
  const { files, unresolved } = localImportClosure(
    'scripts/ci/guardrails-analyze-packages.mjs',
    repoRoot,
  );
  assert.deepEqual(unresolved, []);
  assert.ok(files.includes('scripts/hooks/lib/flutter-packages.mjs'));
  assert.ok(files.includes('scripts/hooks/lib/parallel.mjs'));
});

test('a static template-literal specifier is followed', () => {
  // ``import(`./helper.mjs`)`` is a real, resolvable dependency; an
  // earlier regex accepted only quoted strings and skipped it.
  assert.deepEqual(relativeSpecifiers('const m = await import(`./a.mjs`);'), [
    './a.mjs',
  ]);
});

test('a substituted template is opaque, not treated as a literal path', () => {
  // Reading the raw text as a path would resolve to a file that cannot
  // exist and look like a typo, hiding a real dependency.
  const { specifiers, opaque } = scanSpecifiers(
    'await import(`./gen-${name}.mjs`);',
  );
  assert.deepEqual(specifiers, []);
  assert.equal(opaque.length, 1);
});

test('a computed dynamic import is reported, so the guard fails closed', () => {
  const { opaque } = scanSpecifiers('await import(resolvePath(x));');
  assert.equal(opaque.length, 1);
});

test('an opaque import surfaces as unresolved in the closure', () => {
  // The coverage guard keys off `unresolved`, so an unparseable import
  // has to fail the test rather than shrink the closure silently.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-opaque-'));
  fs.writeFileSync(
    path.join(dir, 'a.mjs'),
    'const p = "./x.mjs";\nawait import(p);\n',
  );
  const { files, unresolved } = localImportClosure('a.mjs', dir);
  assert.deepEqual(files, ['a.mjs']);
  assert.equal(unresolved.length, 1);
  assert.match(unresolved[0], /unparseable import/);
});

test('comments and strings do not produce false opaque imports', () => {
  const source = `
    // docs: await import(resolvePath(x));
    /* block with import(dynamic) example */
    const msg = "import('./not-real.mjs')";
    const tpl = \`import('../also-not-real.mjs')\`;
    export const ok = 1;
  `;
  const { specifiers, opaque } = scanSpecifiers(source);
  assert.deepEqual(specifiers, []);
  assert.deepEqual(opaque, []);
});

test('stripCommentsAndStrings removes comment and string bodies', () => {
  const stripped = stripCommentsAndStrings(
    'await import(x); // import("./a.mjs")\n/* import("./b.mjs") */',
  );
  assert.match(stripped, /await import\(x\)/);
  assert.doesNotMatch(stripped, /"\.\/a\.mjs"/);
  assert.doesNotMatch(stripped, /"\.\/b\.mjs"/);
});

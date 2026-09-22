// Unit tests for adf-to-md.mjs: one assertion per node type md-to-adf
// emits, degradation behaviour, normalise/compare helpers, and the CLI.
// The full md -> adf -> md -> adf property lives in
// md-to-adf.roundtrip.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  adfToMarkdown,
  checkRoundTrip,
  escapeText,
  firstDifference,
  normaliseAdf,
} from './adf-to-md.mjs';
import { markdownToAdf } from './md-to-adf.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'adf-to-md.mjs');

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });
const doc = (...content) => ({ type: 'doc', version: 1, content });

/** Render with warnings captured instead of written to stderr. */
function render(adf) {
  const warnings = [];
  const md = adfToMarkdown(adf, { warn: (m) => warnings.push(m) });
  return { md, warnings };
}

// ===========================================================================
// BLOCK NODES
// ===========================================================================

test('doc with paragraphs joins blocks with a blank line', () => {
  const { md, warnings } = render(doc(para(text('one')), para(text('two'))));
  assert.equal(md, 'one\n\ntwo');
  assert.deepEqual(warnings, []);
});

test('bare content array is accepted', () => {
  assert.equal(adfToMarkdown([para(text('x'))]), 'x');
});

test('non-object input renders as empty', () => {
  assert.equal(adfToMarkdown(null), '');
  assert.equal(adfToMarkdown('nope'), '');
});

test('headings render at every level', () => {
  for (let level = 1; level <= 6; level += 1) {
    const { md } = render(
      doc({ type: 'heading', attrs: { level }, content: [text('Title')] }),
    );
    assert.equal(md, `${'#'.repeat(level)} Title`);
  }
});

test('codeBlock keeps language and picks a fence longer than any inside', () => {
  const inner = 'echo ```\n```dart\nx\n```';
  const { md } = render(
    doc({ type: 'codeBlock', attrs: { language: 'sh' }, content: [text(inner)] }),
  );
  assert.equal(md, `\`\`\`\`sh\n${inner}\n\`\`\`\``);
  const back = markdownToAdf(md).content[0];
  assert.equal(back.type, 'codeBlock');
  assert.equal(back.attrs.language, 'sh');
  assert.equal(back.content[0].text, inner);
});

test('codeBlock without language uses a bare fence', () => {
  const { md } = render(doc({ type: 'codeBlock', content: [text('ls')] }));
  assert.equal(md, '```\nls\n```');
});

test('blockquote prefixes every line, including blank separators', () => {
  const { md } = render(
    doc({ type: 'blockquote', content: [para(text('a')), para(text('b'))] }),
  );
  assert.equal(md, '> a\n>\n> b');
});

test('rule renders as ---, or *** when it opens the document', () => {
  assert.equal(adfToMarkdown(doc(para(text('a')), { type: 'rule' })), 'a\n\n---');
  const leading = adfToMarkdown(doc({ type: 'rule' }, para(text('a'))));
  assert.equal(leading, '***\n\na');
  // A leading --- would read as frontmatter; *** must survive re-parsing.
  assert.deepEqual(
    markdownToAdf(leading).content.map((n) => n.type),
    ['rule', 'paragraph'],
  );
});

test('bulletList and orderedList nest and honour ordered start', () => {
  const item = (...blocks) => ({ type: 'listItem', content: blocks });
  const { md } = render(
    doc({
      type: 'orderedList',
      attrs: { order: 3 },
      content: [
        item(para(text('three'))),
        item(
          para(text('four')),
          {
            type: 'bulletList',
            content: [
              item(para(text('deep'))),
              item(para(text('deeper')), {
                type: 'bulletList',
                content: [item(para(text('deepest')))],
              }),
            ],
          },
        ),
      ],
    }),
  );
  assert.equal(
    md,
    ['3. three', '4. four', '   - deep', '   - deeper', '     - deepest'].join('\n'),
  );
  const back = markdownToAdf(md).content[0];
  assert.equal(back.type, 'orderedList');
  assert.equal(back.attrs.order, 3);
  assert.equal(back.content[1].content[1].content[1].content[1].type, 'bulletList');
});

test('taskList renders TODO/DONE and nested task lists', () => {
  const task = (state, t) => ({
    type: 'taskItem',
    attrs: { localId: 'x', state },
    content: [text(t)],
  });
  const { md } = render(
    doc({
      type: 'taskList',
      attrs: { localId: 'l' },
      content: [
        task('TODO', 'open'),
        task('DONE', 'closed'),
        {
          type: 'taskList',
          attrs: { localId: 'n' },
          content: [task('TODO', 'nested')],
        },
      ],
    }),
  );
  assert.equal(md, '- [ ] open\n- [x] closed\n  - [ ] nested');
});

test('adjacent same-type lists are kept apart by a separator', () => {
  const list = (t) => ({
    type: 'bulletList',
    content: [{ type: 'listItem', content: [para(text(t))] }],
  });
  const { md } = render(doc(list('a'), list('b')));
  assert.equal(md, '- a\n\n<!-- -->\n\n- b');
  assert.deepEqual(
    markdownToAdf(md).content.map((n) => n.type),
    ['bulletList', 'bulletList'],
  );
});

test('table detects header cells and escapes pipes', () => {
  const cell = (type, ...content) => ({
    type,
    content: [para(...content)],
  });
  const { md } = render(
    doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [cell('tableHeader', text('k')), cell('tableHeader', text('v'))],
        },
        {
          type: 'tableRow',
          content: [
            cell('tableCell', text('a|b')),
            cell('tableCell', text('x', [{ type: 'code' }])),
          ],
        },
      ],
    }),
  );
  assert.equal(md, '| k | v |\n| --- | --- |\n| a\\|b | `x` |');
  const back = markdownToAdf(md).content[0];
  assert.equal(back.type, 'table');
  assert.equal(back.content[0].content[0].type, 'tableHeader');
  assert.equal(back.content[1].content[0].content[0].content[0].text, 'a|b');
});

test('table without header cells promotes the first row and warns', () => {
  const { md, warnings } = render(
    doc({
      type: 'table',
      content: [
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', content: [para(text('only'))] }],
        },
        {
          type: 'tableRow',
          content: [{ type: 'tableCell', content: [para(text('second'))] }],
        },
      ],
    }),
  );
  assert.equal(md, '| only |\n| --- |\n| second |');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /header/i);
});

test('panel maps back to the GFM alert md-to-adf reads', () => {
  const cases = [
    ['info', 'NOTE'],
    ['success', 'TIP'],
    ['note', 'IMPORTANT'],
    ['warning', 'WARNING'],
    ['error', 'CAUTION'],
  ];
  for (const [panelType, alert] of cases) {
    const { md } = render(
      doc({ type: 'panel', attrs: { panelType }, content: [para(text('body'))] }),
    );
    assert.equal(md, `> [!${alert}]\n> body`);
    const back = markdownToAdf(md).content[0];
    assert.equal(back.type, 'panel', panelType);
    assert.equal(back.attrs.panelType, panelType);
  }
});

test('panel with a list inside keeps the list', () => {
  const { md } = render(
    doc({
      type: 'panel',
      attrs: { panelType: 'info' },
      content: [
        para(text('intro')),
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [para(text('item'))] }],
        },
      ],
    }),
  );
  assert.equal(md, '> [!NOTE]\n> intro\n>\n> - item');
});

test('unknown panel type degrades to a blockquote with a warning', () => {
  const { md, warnings } = render(
    doc({ type: 'panel', attrs: { panelType: 'custom' }, content: [para(text('b'))] }),
  );
  assert.equal(md, '> b');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /custom/);
});

// ===========================================================================
// INLINE NODES AND MARKS
// ===========================================================================

test('text marks: strong, em, code, strike, link; underline is ignored', () => {
  const { md, warnings } = render(
    doc(
      para(
        text('b', [{ type: 'strong' }]),
        text(' '),
        text('i', [{ type: 'em' }]),
        text(' '),
        text('c', [{ type: 'code' }]),
        text(' '),
        text('s', [{ type: 'strike' }]),
        text(' '),
        text('l', [{ type: 'link', attrs: { href: 'https://x.test/a' } }]),
        text(' '),
        text('u', [{ type: 'underline' }]),
      ),
    ),
  );
  assert.equal(md, '**b** *i* `c` ~~s~~ [l](https://x.test/a) u');
  assert.deepEqual(warnings, []);
});

test('nested marks wrap in a stable order and re-parse to the same marks', () => {
  const marks = [
    { type: 'em' },
    { type: 'strong' },
    { type: 'link', attrs: { href: 'https://x.test' } },
  ];
  const { md } = render(doc(para(text('all', marks))));
  assert.equal(md, '[***all***](https://x.test)');
  const back = markdownToAdf(md).content[0].content;
  assert.equal(back.length, 1);
  assert.deepEqual(
    back[0].marks.map((m) => m.type).sort(),
    ['em', 'link', 'strong'],
  );
});

test('whitespace at the edge of marked text is moved outside the mark', () => {
  const { md } = render(doc(para(text('a'), text(' bold ', [{ type: 'strong' }]), text('b'))));
  assert.equal(md, 'a **bold** b');
});

test('code mark picks a backtick run longer than any inside', () => {
  const { md } = render(doc(para(text('a`b``c', [{ type: 'code' }]))));
  assert.equal(md, '```a`b``c```');
  const back = markdownToAdf(md).content[0].content;
  assert.equal(back.length, 1);
  assert.equal(back[0].text, 'a`b``c');
  assert.deepEqual(back[0].marks, [{ type: 'code' }]);
});

test('hardBreak, mention, emoji, inlineCard render to their md forms', () => {
  const { md, warnings } = render(
    doc(
      para(
        text('line'),
        { type: 'hardBreak' },
        { type: 'mention', attrs: { id: 'u1', text: '@alex' } },
        text(' '),
        { type: 'emoji', attrs: { shortName: ':tada:' } },
        text(' '),
        { type: 'inlineCard', attrs: { url: 'https://x.test/card' } },
      ),
    ),
  );
  assert.deepEqual(warnings, []);
  assert.equal(md, 'line<br>@[alex](accountId:u1) :tada: <https://x.test/card>');
  // md-to-adf has no emoji or inlineCard producers: the shortName reads
  // back as text and the autolink as link-marked text.
  const back = markdownToAdf(md).content[0].content;
  assert.deepEqual(
    back.map((n) => n.type),
    ['text', 'hardBreak', 'mention', 'text', 'text'],
  );
  assert.equal(back[2].attrs.id, 'u1');
  assert.equal(back[3].text, ' :tada: ');
  assert.equal(back[4].text, 'https://x.test/card');
  assert.equal(back[4].marks[0].type, 'link');
});

test('mention without an id falls back to plain @name text', () => {
  const { md } = render(doc(para({ type: 'mention', attrs: { text: '@sam' } })));
  assert.equal(md, '@sam');
});

test('literal markdown syntax in text is escaped and survives re-parsing', () => {
  const literal = '*not em* _nor_ `nor code` ~~nor strike~~ [nor](link) # nor heading | pipe';
  const { md } = render(doc(para(text(literal))));
  assert.notEqual(md, literal);
  const back = markdownToAdf(md).content[0].content;
  assert.equal(back.length, 1);
  assert.equal(back[0].text, literal);
  assert.equal(back[0].marks, undefined);
});

test('escapeText protects block starters only at line start', () => {
  assert.equal(escapeText('# h', {}, { first: true }), '\\# h');
  assert.equal(escapeText('a # h', {}, { first: true }), 'a # h');
  assert.equal(escapeText('- x', {}, { first: true }), '\\- x');
  assert.equal(escapeText('1. x', {}, { first: true }), '1\\. x');
  assert.equal(escapeText('a|b', { inTable: true }), 'a\\|b');
});

// ===========================================================================
// DEGRADATION
// ===========================================================================

test('unknown block node renders its content and warns, never throws', () => {
  const { md, warnings } = render(
    doc({
      type: 'layoutSection',
      content: [
        { type: 'layoutColumn', attrs: { width: 50 }, content: [para(text('left'))] },
        { type: 'layoutColumn', attrs: { width: 50 }, content: [para(text('right'))] },
      ],
    }),
  );
  assert.equal(md, 'left\n\nright');
  assert.ok(warnings.some((w) => /layoutSection/.test(w)), warnings.join('\n'));
  assert.ok(warnings.some((w) => /layoutColumn/.test(w)), warnings.join('\n'));
});

test('unknown leaf node with no content renders empty and warns', () => {
  const { md, warnings } = render(doc({ type: 'extension', attrs: { extensionKey: 'k' } }));
  assert.equal(md, '');
  assert.equal(warnings.length, 1);
});

test('media nodes render alt text or a link with a warning', () => {
  const { md, warnings } = render(
    doc({
      type: 'mediaSingle',
      content: [{ type: 'media', attrs: { id: 'm', alt: 'diagram', url: 'https://x.test/d.png' } }],
    }),
  );
  assert.equal(md, '[diagram](https://x.test/d.png)');
  assert.equal(warnings.length, 1);
});

test('unknown inline node renders its text and warns', () => {
  const { md, warnings } = render(
    doc(para(text('see '), { type: 'weird', attrs: { text: 'thing' } })),
  );
  assert.match(md, /^see/);
  assert.ok(warnings.some((w) => /weird/.test(w)), warnings.join('\n'));
});

test('warnings default to stderr and do not throw', () => {
  const orig = process.stderr.write;
  const seen = [];
  process.stderr.write = (chunk) => {
    seen.push(String(chunk));
    return true;
  };
  try {
    adfToMarkdown(doc({ type: 'nope', content: [para(text('x'))] }));
  } finally {
    process.stderr.write = orig;
  }
  assert.ok(seen.some((s) => s.startsWith('[adf-to-md]')), seen.join());
});

// ===========================================================================
// NORMALISE / COMPARE / CHECK
// ===========================================================================

test('normaliseAdf drops localId, sorts marks, merges and trims text', () => {
  const a = normaliseAdf(
    doc({
      type: 'taskList',
      attrs: { localId: 'a' },
      content: [
        {
          type: 'taskItem',
          attrs: { localId: 'b', state: 'TODO' },
          content: [
            text('  x', [{ type: 'strong' }, { type: 'em' }]),
            text('y', [{ type: 'em' }, { type: 'strong' }]),
            text('  '),
          ],
        },
      ],
    }),
  );
  const item = a.content[0].content[0];
  assert.equal(a.content[0].attrs, undefined);
  assert.deepEqual(item.attrs, { state: 'TODO' });
  assert.deepEqual(item.content, [
    text('xy', [{ type: 'em' }, { type: 'strong' }]),
  ]);
});

test('normaliseAdf leaves codeBlock text untouched', () => {
  const n = normaliseAdf(doc({ type: 'codeBlock', content: [text('  a  \n  b  ')] }));
  assert.equal(n.content[0].content[0].text, '  a  \n  b  ');
});

test('firstDifference reports the first differing path', () => {
  assert.equal(firstDifference({ a: [1, 2] }, { a: [1, 2] }), null);
  const d = firstDifference(
    { content: [{ type: 'paragraph' }, { type: 'rule' }] },
    { content: [{ type: 'paragraph' }, { type: 'heading' }] },
  );
  assert.deepEqual(d, {
    path: 'doc.content[1].type',
    expected: 'rule',
    actual: 'heading',
  });
  assert.equal(firstDifference([1], [1, 2]).path, 'doc[1]');
  assert.equal(firstDifference({ a: 1 }, null).path, 'doc');
});

test('checkRoundTrip is ok for a mixed document', () => {
  const md = [
    '## Title',
    '',
    'Para with **bold**, `code`, and [a link](https://x.test).',
    '',
    '- [ ] task',
    '- [x] done',
    '',
    '| a | b |',
    '| --- | --- |',
    '| `x|y` | 2 |',
    '',
    '> [!NOTE]',
    '> - inside',
    '',
    '```dart',
    'void main() {}',
    '```',
  ].join('\n');
  const result = checkRoundTrip(md, { warn: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result.diff));
  assert.deepEqual(result.errors, []);
});

test('checkRoundTrip surfaces a diff when the regenerated ADF differs', () => {
  // Force a mismatch by passing an ADF that md-to-adf cannot reproduce:
  // an underline mark is dropped on the way out.
  const first = markdownToAdf('plain');
  first.content[0].content[0].marks = [{ type: 'underline' }];
  const md = adfToMarkdown(first);
  const second = markdownToAdf(md);
  const diff = firstDifference(normaliseAdf(first), normaliseAdf(second));
  assert.ok(diff);
  assert.match(diff.path, /marks/);
});

// ===========================================================================
// CLI
// ===========================================================================

function run(args, input) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8',
    input,
  });
}

test('CLI: <file.json> prints markdown to stdout', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-to-md-'));
  try {
    const file = path.join(dir, 'doc.json');
    fs.writeFileSync(file, JSON.stringify(doc(para(text('hi ', [{ type: 'strong' }]), text('there')))));
    const r = run([file]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '**hi** there\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: - reads ADF JSON from stdin', () => {
  const r = run(['-'], JSON.stringify(doc(para(text('stdin')))));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'stdin\n');
});

test('CLI: --check passes on a round-trippable markdown file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adf-to-md-'));
  try {
    const file = path.join(dir, 'story.md');
    fs.writeFileSync(file, '# T\n\n- [ ] a\n- [x] b\n\n| k | v |\n| --- | --- |\n| 1 | 2 |\n');
    const r = run(['--check', file]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /round-trip OK/);
    assert.equal(r.stdout, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: usage errors exit 2, unreadable JSON exits 1', () => {
  assert.equal(run([]).status, 2);
  assert.equal(run(['--check']).status, 2);
  const r = run(['-'], '{not json');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot read ADF JSON/);
});

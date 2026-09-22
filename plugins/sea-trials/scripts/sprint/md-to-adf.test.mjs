import assert from 'node:assert/strict';
import { test } from 'node:test';

import { STORY_MD } from './fixtures/sprint-stories.mjs';
import {
  adfSize,
  extractSection,
  markdownToAdf,
  stripFirstH1,
  validateAdf,
} from './md-to-adf.mjs';

/** Deterministic `localId`s: id-1, id-2, ... */
function counter() {
  let n = 0;
  return () => {
    n += 1;
    return `id-${n}`;
  };
}

/** Convert with deterministic ids and assert the doc validates. */
function conv(md) {
  const doc = markdownToAdf(md, { idFactory: counter() });
  assert.deepEqual(validateAdf(doc), []);
  return doc;
}

const text = (t, marks) => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content) => ({ type: 'paragraph', content });

// ===========================================================================
// DOC / PARAGRAPHS / HEADINGS
// ===========================================================================

test('empty input yields an empty valid doc', () => {
  const doc = conv('');
  assert.deepEqual(doc, { type: 'doc', version: 1, content: [] });
  assert.equal(adfSize(doc), JSON.stringify(doc).length);
});

test('paragraph soft-wraps and blank lines split paragraphs', () => {
  const doc = conv('one\ntwo\n\nthree');
  assert.deepEqual(doc.content, [
    para(text('one two')),
    para(text('three')),
  ]);
});

test('never emits empty text or empty paragraph content', () => {
  const doc = conv('<div></div>\n\n<span> </span>\n\n**\n\n****');
  assert.deepEqual(doc.content, [para(text('**')), { type: 'rule' }]);
  assert.equal(JSON.stringify(doc).includes('"text":""'), false);
});

test('headings map to levels 1..6 and strip closing hashes', () => {
  const doc = conv('# One\n## Two ##\n###### Six\n####### Seven');
  assert.deepEqual(doc.content[0], {
    type: 'heading',
    attrs: { level: 1 },
    content: [text('One')],
  });
  assert.equal(doc.content[1].attrs.level, 2);
  assert.deepEqual(doc.content[1].content, [text('Two')]);
  assert.equal(doc.content[2].attrs.level, 6);
  assert.equal(doc.content[3].type, 'paragraph');
});

test('empty heading omits content instead of empty text', () => {
  const doc = conv('##');
  assert.deepEqual(doc.content[0], { type: 'heading', attrs: { level: 2 } });
});

// ===========================================================================
// INLINE MARKS
// ===========================================================================

test('strong, em, strike, code marks', () => {
  const doc = conv('**a** __b__ *c* _d_ ~~e~~ `f`');
  assert.deepEqual(doc.content[0].content, [
    text('a', [{ type: 'strong' }]),
    text(' '),
    text('b', [{ type: 'strong' }]),
    text(' '),
    text('c', [{ type: 'em' }]),
    text(' '),
    text('d', [{ type: 'em' }]),
    text(' '),
    text('e', [{ type: 'strike' }]),
    text(' '),
    text('f', [{ type: 'code' }]),
  ]);
});

test('nested marks and triple-star strong+em', () => {
  const doc = conv('**bold *both* bold** ***all***');
  assert.deepEqual(doc.content[0].content, [
    text('bold ', [{ type: 'strong' }]),
    text('both', [{ type: 'strong' }, { type: 'em' }]),
    text(' bold', [{ type: 'strong' }]),
    text(' '),
    text('all', [{ type: 'strong' }, { type: 'em' }]),
  ]);
});

test('code mark drops strong/em but keeps link', () => {
  const doc = conv('**a `b` c** [`d`](https://e.f)');
  assert.deepEqual(doc.content[0].content, [
    text('a ', [{ type: 'strong' }]),
    text('b', [{ type: 'code' }]),
    text(' c', [{ type: 'strong' }]),
    text(' '),
    text('d', [
      { type: 'link', attrs: { href: 'https://e.f' } },
      { type: 'code' },
    ]),
  ]);
});

test('underscores inside words are literal', () => {
  const doc = conv('snake_case_name and file_a');
  assert.deepEqual(doc.content[0].content, [
    text('snake_case_name and file_a'),
  ]);
});

test('unmatched delimiters stay literal', () => {
  const doc = conv('2 * 3 * 4 and **open');
  assert.deepEqual(doc.content[0].content, [text('2 * 3 * 4 and **open')]);
});

test('links with title, bare URLs, autolinks', () => {
  const doc = conv(
    '[t](https://a.b "T") https://c.d/e. <https://f.g> (https://h.i)',
  );
  assert.deepEqual(doc.content[0].content, [
    text('t', [{ type: 'link', attrs: { href: 'https://a.b', title: 'T' } }]),
    text(' '),
    text('https://c.d/e', [{ type: 'link', attrs: { href: 'https://c.d/e' } }]),
    text('. '),
    text('https://f.g', [{ type: 'link', attrs: { href: 'https://f.g' } }]),
    text(' ('),
    text('https://h.i', [{ type: 'link', attrs: { href: 'https://h.i' } }]),
    text(')'),
  ]);
});

test('link text keeps inner marks', () => {
  const doc = conv('[**b** i](https://x.y)');
  assert.deepEqual(doc.content[0].content, [
    text('b', [{ type: 'link', attrs: { href: 'https://x.y' } }, { type: 'strong' }]),
    text(' i', [{ type: 'link', attrs: { href: 'https://x.y' } }]),
  ]);
});

test('hard breaks from <br> and trailing double space', () => {
  const doc = conv('a<br>b  \nc<br/>d\nlast  ');
  assert.deepEqual(doc.content[0].content, [
    text('a'),
    { type: 'hardBreak' },
    text('b'),
    { type: 'hardBreak' },
    text('c'),
    { type: 'hardBreak' },
    text('d last'),
  ]);
});

test('escape sequences are literal', () => {
  const doc = conv('\\*not em\\* \\_x\\_ \\`y\\`');
  assert.deepEqual(doc.content[0].content, [text('*not em* _x_ `y`')]);
});

test('mentions and plain @word', () => {
  const doc = conv('@[Ada Lovelace](accountId:5b10ac8d) and @bob');
  assert.deepEqual(doc.content[0].content, [
    {
      type: 'mention',
      attrs: { id: '5b10ac8d', text: '@Ada Lovelace', userType: 'DEFAULT' },
    },
    text(' and @bob'),
  ]);
});

test('html tags other than <br> are stripped, inner text kept', () => {
  const doc = conv('<b>bold</b> <span class="x">y</span> <!-- c -->z');
  assert.deepEqual(doc.content[0].content, [text('bold y z')]);
});

test('images degrade to a link with alt or url text', () => {
  const doc = conv('![alt](https://img.x/a.png) ![](https://img.x/b.png)');
  assert.deepEqual(doc.content[0].content, [
    text('alt', [{ type: 'link', attrs: { href: 'https://img.x/a.png' } }]),
    text(' '),
    text('https://img.x/b.png', [
      { type: 'link', attrs: { href: 'https://img.x/b.png' } },
    ]),
  ]);
});

// ===========================================================================
// CODE BLOCKS / RULES / FRONTMATTER
// ===========================================================================

test('fenced code keeps text verbatim, language optional', () => {
  const doc = conv('```dart\nvoid main() {\n\n  x();\n}\n```\n\n~~~\nplain\n~~~');
  assert.deepEqual(doc.content[0], {
    type: 'codeBlock',
    attrs: { language: 'dart' },
    content: [text('void main() {\n\n  x();\n}')],
  });
  assert.deepEqual(doc.content[1], {
    type: 'codeBlock',
    content: [text('plain')],
  });
});

test('empty code block omits content; unterminated fence eats rest', () => {
  const doc = conv('```\n```\n\n```js\nrest\nof file');
  assert.deepEqual(doc.content[0], { type: 'codeBlock' });
  assert.deepEqual(doc.content[1], {
    type: 'codeBlock',
    attrs: { language: 'js' },
    content: [text('rest\nof file')],
  });
});

test('rules from ---, ***, ___ but not table separators', () => {
  const doc = conv('---\n\n***\n\n___\n\n| a |\n|---|\n| b |');
  assert.deepEqual(doc.content.slice(0, 3), [
    { type: 'rule' },
    { type: 'rule' },
    { type: 'rule' },
  ]);
  assert.equal(doc.content[3].type, 'table');
});

test('yaml frontmatter is skipped', () => {
  const doc = conv('---\ntitle: x\ntags: [a]\n---\n\nbody');
  assert.deepEqual(doc.content, [para(text('body'))]);
});

// ===========================================================================
// LISTS
// ===========================================================================

test('bullet and ordered lists with nesting by indentation', () => {
  const doc = conv('- a\n  - b\n    1. c\n- d\n\n3) e\n4) f');
  assert.deepEqual(doc.content[0], {
    type: 'bulletList',
    content: [
      {
        type: 'listItem',
        content: [
          para(text('a')),
          {
            type: 'bulletList',
            content: [
              {
                type: 'listItem',
                content: [
                  para(text('b')),
                  {
                    type: 'orderedList',
                    content: [{ type: 'listItem', content: [para(text('c'))] }],
                  },
                ],
              },
            ],
          },
        ],
      },
      { type: 'listItem', content: [para(text('d'))] },
    ],
  });
  assert.deepEqual(doc.content[1], {
    type: 'orderedList',
    attrs: { order: 3 },
    content: [
      { type: 'listItem', content: [para(text('e'))] },
      { type: 'listItem', content: [para(text('f'))] },
    ],
  });
});

test('ordered list starting at 1 has no attrs', () => {
  const doc = conv('1. a\n2. b');
  assert.equal(doc.content[0].attrs, undefined);
});

test('tab and 4-space nesting', () => {
  const doc = conv('- a\n\t- b\n- c\n    - d');
  const items = doc.content[0].content;
  assert.equal(items[0].content[1].type, 'bulletList');
  assert.equal(items[1].content[1].type, 'bulletList');
});

test('list item continuation lines join the paragraph', () => {
  const doc = conv('- first line\n  continued here\n- second');
  assert.deepEqual(doc.content[0].content[0].content, [
    para(text('first line continued here')),
  ]);
  assert.equal(doc.content[0].content.length, 2);
});

test('list item may hold a code block after its paragraph', () => {
  const doc = conv('- item\n\n  ```sh\n  ls\n  ```\n- next');
  const first = doc.content[0].content[0].content;
  assert.equal(first[0].type, 'paragraph');
  assert.deepEqual(first[1], {
    type: 'codeBlock',
    attrs: { language: 'sh' },
    content: [text('ls')],
  });
});

// ===========================================================================
// TASK LISTS
// ===========================================================================

test('task list with TODO/DONE states and inline-only content', () => {
  const doc = conv('- [ ] **a** `b`\n- [x] c\n* [X] d');
  assert.deepEqual(doc.content, [
    {
      type: 'taskList',
      attrs: { localId: 'id-1' },
      content: [
        {
          type: 'taskItem',
          attrs: { localId: 'id-2', state: 'TODO' },
          content: [
            text('a', [{ type: 'strong' }]),
            text(' '),
            text('b', [{ type: 'code' }]),
          ],
        },
        {
          type: 'taskItem',
          attrs: { localId: 'id-3', state: 'DONE' },
          content: [text('c')],
        },
        {
          type: 'taskItem',
          attrs: { localId: 'id-4', state: 'DONE' },
          content: [text('d')],
        },
      ],
    },
  ]);
});

test('mixing task and plain siblings splits into separate lists', () => {
  const doc = conv('- [ ] t1\n- plain\n- [ ] t2');
  assert.deepEqual(
    doc.content.map((n) => n.type),
    ['taskList', 'bulletList', 'taskList'],
  );
});

test('taskList nested under a bullet item after its paragraph', () => {
  const doc = conv('- parent\n  - [ ] child');
  assert.deepEqual(doc.content[0].content[0].content, [
    para(text('parent')),
    {
      type: 'taskList',
      attrs: { localId: 'id-1' },
      content: [
        {
          type: 'taskItem',
          attrs: { localId: 'id-2', state: 'TODO' },
          content: [text('child')],
        },
      ],
    },
  ]);
});

test('task items nested under a task item become a nested taskList', () => {
  const doc = conv('- [ ] a\n  - [ ] a1\n  - [x] a2\n- [ ] b');
  assert.deepEqual(
    doc.content.map((n) => n.type),
    ['taskList'],
  );
  const [a, nested, b] = doc.content[0].content;
  assert.equal(a.type, 'taskItem');
  assert.equal(a.content[0].text, 'a');
  assert.equal(nested.type, 'taskList');
  assert.deepEqual(
    nested.content.map((i) => [i.content[0].text, i.attrs.state]),
    [
      ['a1', 'TODO'],
      ['a2', 'DONE'],
    ],
  );
  assert.equal(b.type, 'taskItem');
  assert.equal(b.content[0].text, 'b');
  assert.equal(doc.content[0].attrs.localId, 'id-1');
});

test('non-task blocks under a task item keep source order', () => {
  const doc = conv(
    '- [ ] a\n  - plain a1\n- [ ] b\n\n  ```sh\n  ls\n  ```\n- [ ] c',
  );
  assert.deepEqual(
    doc.content.map((n) => n.type),
    ['taskList', 'bulletList', 'taskList', 'codeBlock', 'taskList'],
  );
  assert.deepEqual(
    doc.content
      .filter((n) => n.type === 'taskList')
      .map((n) => n.content.map((i) => i.content[0].text)),
    [['a'], ['b'], ['c']],
  );
  assert.equal(doc.content[1].content[0].content[0].content[0].text, 'plain a1');
  const ids = doc.content.filter((n) => n.type === 'taskList').map((n) => n.attrs.localId);
  assert.equal(new Set(ids).size, 3);
});

test('task item with hardBreak keeps inline content', () => {
  const doc = conv('- [ ] one<br>two');
  assert.deepEqual(doc.content[0].content[0].content, [
    text('one'),
    { type: 'hardBreak' },
    text('two'),
  ]);
});

// ===========================================================================
// TABLES / BLOCKQUOTES / PANELS
// ===========================================================================

test('gfm table with header, empty cell, task cell, escaped pipe', () => {
  const doc = conv(
    '| Field | Value |\n| --- | :---: |\n| a | **b** |\n| empty | |\n' +
      '| task | [ ] do it |\n| pipe | x \\| y |',
  );
  const table = doc.content[0];
  assert.deepEqual(table.attrs, {
    isNumberColumnEnabled: false,
    layout: 'default',
  });
  const [head, r1, r2, r3, r4] = table.content;
  assert.deepEqual(head.content.map((c) => c.type), [
    'tableHeader',
    'tableHeader',
  ]);
  assert.deepEqual(r1.content[1], {
    type: 'tableCell',
    content: [para(text('b', [{ type: 'strong' }]))],
  });
  assert.deepEqual(r2.content[1], {
    type: 'tableCell',
    content: [{ type: 'paragraph' }],
  });
  assert.equal(r3.content[1].content[0].type, 'taskList');
  assert.equal(r3.content[1].content[0].content[0].attrs.state, 'TODO');
  assert.deepEqual(r4.content[1].content[0].content, [text('x | y')]);
});

test('table without leading/trailing pipes and ragged rows', () => {
  const doc = conv('a | b\n---|---\n1\n2 | 3 | 4');
  const rows = doc.content[0].content;
  assert.equal(rows.length, 3);
  for (const row of rows) assert.equal(row.content.length, 2);
});

test('blockquote wraps paragraphs', () => {
  const doc = conv('> a\n> b\n>\n> c');
  assert.deepEqual(doc.content[0], {
    type: 'blockquote',
    content: [para(text('a b')), para(text('c'))],
  });
});

test('github alerts become panels with the mapped panelType', () => {
  const md = ['NOTE', 'TIP', 'IMPORTANT', 'WARNING', 'CAUTION']
    .map((k) => `> [!${k}]\n> body ${k}\n`)
    .join('\n');
  const doc = conv(md);
  assert.deepEqual(
    doc.content.map((n) => [n.type, n.attrs.panelType]),
    [
      ['panel', 'info'],
      ['panel', 'success'],
      ['panel', 'note'],
      ['panel', 'warning'],
      ['panel', 'error'],
    ],
  );
  assert.deepEqual(doc.content[0].content, [para(text('body NOTE'))]);
});

test('panel with a table falls back to a blockquote', () => {
  const doc = conv('> [!NOTE]\n> | a |\n> |---|\n> | b |');
  assert.equal(doc.content[0].type, 'blockquote');
  assert.equal(doc.content[0].content[0].type, 'table');
});

test('panel may hold lists and task lists', () => {
  const doc = conv('> [!TIP]\n> - a\n> - [ ] b');
  assert.equal(doc.content[0].type, 'panel');
  assert.deepEqual(
    doc.content[0].content.map((n) => n.type),
    ['bulletList', 'taskList'],
  );
});

// ===========================================================================
// HELPERS
// ===========================================================================

test('extractSection returns the body up to a same-or-higher heading', () => {
  const md = [
    '# Title',
    '## A',
    'a body',
    '### A.1',
    'sub',
    '```',
    '## not a heading',
    '```',
    '## B',
    'b body',
  ].join('\n');
  assert.equal(
    extractSection(md, '## A'),
    'a body\n### A.1\nsub\n```\n## not a heading\n```',
  );
  assert.equal(extractSection(md, '## B'), 'b body');
  assert.equal(extractSection(md, '## Missing'), null);
  assert.equal(extractSection(md, '### A.1'), 'sub\n```\n## not a heading\n```');
  assert.throws(() => extractSection(md, 'no hashes'));
});

test('stripFirstH1 removes only the first H1', () => {
  assert.equal(stripFirstH1('# T\n\nbody\n# Again'), '\nbody\n# Again');
  assert.equal(stripFirstH1('## not h1\nx'), '## not h1\nx');
});

test('adfSize is the UTF-8 byte length', () => {
  const doc = markdownToAdf('héllo');
  assert.equal(adfSize(doc), Buffer.byteLength(JSON.stringify(doc)));
});

// ===========================================================================
// VALIDATOR
// ===========================================================================

test('validateAdf flags each structural rule', () => {
  const bad = {
    type: 'doc',
    version: 1,
    content: [
      { type: 'paragraph', content: [] },
      { type: 'paragraph', content: [{ type: 'text', text: '' }] },
      { type: 'heading', attrs: { level: 7 } },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'x', marks: [{ type: 'code' }, { type: 'strong' }] },
        ],
      },
      {
        type: 'codeBlock',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'em' }] }],
      },
      { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }] },
      {
        type: 'taskList',
        content: [
          { type: 'taskList', attrs: { localId: 'x' }, content: [] },
          {
            type: 'taskItem',
            attrs: { state: 'todo' },
            content: [{ type: 'paragraph' }],
          },
        ],
      },
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader' }] },
          { type: 'tableRow', content: [{ type: 'tableCell' }, { type: 'tableCell' }] },
        ],
      },
      { type: 'panel', attrs: { panelType: 'info' }, content: [{ type: 'table', content: [] }] },
      { type: 'rule', attrs: {} },
    ],
  };
  const errors = validateAdf(bad);
  const expect = [
    'paragraph content must not be empty',
    'text must be non-empty',
    'heading level must be an integer 1..6',
    'code mark cannot combine with strong',
    'codeBlock text has marks',
    'listItem first child must be paragraph/codeBlock',
    'taskList requires attrs.localId',
    'nested taskList cannot be first',
    'taskItem requires attrs.localId',
    'taskItem state must be TODO or DONE',
    'taskItem may only hold inline nodes',
    'row has 2 cells, want 1',
    'panel cannot contain table',
    'rule takes no content or attrs',
  ];
  for (const e of expect) {
    assert.ok(errors.some((m) => m.includes(e)), `missing error: ${e}`);
  }
  assert.deepEqual(validateAdf({ type: 'doc', version: 2 }), [
    'doc.version must be 1',
    'doc.content must be an array',
  ]);
});

// ===========================================================================
// GOLDEN (STORY_MD lives in fixtures/sprint-stories.mjs)
// ===========================================================================

test('golden: realistic sprint story converts to valid ADF', () => {
  const doc = markdownToAdf(STORY_MD, { idFactory: counter() });
  assert.deepEqual(validateAdf(doc), []);
  const types = doc.content.map((n) => n.type);
  assert.deepEqual(types, [
    'heading',
    'paragraph',
    'table',
    'heading',
    'taskList',
    'heading',
    'bulletList',
    'codeBlock',
    'panel',
    'rule',
  ]);

  assert.deepEqual(doc.content[0], {
    type: 'heading',
    attrs: { level: 1 },
    content: [text('US3: Reinstall reaches device setup')],
  });

  const goal = doc.content[1].content;
  assert.deepEqual(goal[0], text('Goal:', [{ type: 'strong' }]));
  assert.ok(goal.some((n) => n.marks?.[0]?.type === 'code'));
  assert.equal(goal.some((n) => n.type === 'hardBreak'), false);

  const table = doc.content[2];
  assert.equal(table.content.length, 3);
  assert.equal(table.content[0].content[0].type, 'tableHeader');
  assert.deepEqual(table.content[1].content[1].content, [para(text('5'))]);

  const ac = doc.content[4];
  assert.equal(ac.attrs.localId, 'id-1');
  assert.equal(ac.content.length, 4);
  assert.deepEqual(
    ac.content.map((i) => i.type),
    ['taskItem', 'taskItem', 'taskItem', 'taskList'],
  );
  assert.deepEqual(
    ac.content.slice(0, 3).map((i) => i.attrs.state),
    ['TODO', 'DONE', 'TODO'],
  );
  assert.deepEqual(ac.content[0].content, [
    text('Boot', [{ type: 'strong' }]),
    text(' routes to '),
    text('ClientDeviceSetupBootPage', [{ type: 'code' }]),
    text(' when '),
    text('sync_ready', [{ type: 'code' }]),
    text(' is false after reinstall'),
  ]);
  const nested = ac.content[3];
  assert.equal(nested.content.length, 1);
  assert.equal(nested.content[0].content[0].text, 'Event carries the ');

  const notes = doc.content[6];
  assert.equal(notes.content.length, 2);
  assert.equal(notes.content[0].content[1].type, 'bulletList');
  assert.equal(notes.content[0].content[1].content.length, 2);

  assert.deepEqual(doc.content[7], {
    type: 'codeBlock',
    attrs: { language: 'dart' },
    content: [
      text('final gate = LicenseStreamSubscriptionGate(\n  ready: state.syncReady,\n);'),
    ],
  });

  assert.equal(doc.content[8].attrs.panelType, 'info');
  assert.equal(doc.content[8].content[0].type, 'paragraph');
  assert.deepEqual(doc.content[9], { type: 'rule' });
});

test('golden: --section style extraction round-trips through convert', () => {
  const section = extractSection(STORY_MD, '## Acceptance criteria');
  const doc = conv(section);
  assert.deepEqual(doc.content.map((n) => n.type), ['taskList']);
  assert.equal(doc.content[0].content.at(-1).type, 'taskList');
});

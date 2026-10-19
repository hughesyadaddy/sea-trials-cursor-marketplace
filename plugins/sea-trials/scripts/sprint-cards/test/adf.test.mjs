import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyToAdf } from '../lib/push.mjs';
import { descriptionToBody } from '../lib/convert.mjs';

const walk = (n, f) => {
  f(n);
  for (const c of n.content ?? []) walk(c, f);
};

test('checklist items are taskItems with inline content, never paragraphs', () => {
  const adf = bodyToAdf('## Done when\n\n- [ ] Given a, when b, then c.\n- [x] `npm test` exits 0.\n');
  const items = [];
  walk(adf, (n) => n.type === 'taskItem' && items.push(n));
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.attrs.state), ['TODO', 'DONE']);
  for (const it of items) {
    assert.ok(it.content.length > 0);
    for (const c of it.content) assert.notEqual(c.type, 'paragraph', 'Jira rejects paragraph in taskItem (INVALID_INPUT)');
  }
  const code = items[1].content.find((c) => c.marks?.some((m) => m.type === 'code'));
  assert.equal(code.text, 'npm test');
});

test('nested lists keep their nesting', () => {
  const adf = bodyToAdf('- one\n  - one a\n  - one b\n- two\n');
  const top = adf.content.find((n) => n.type === 'bulletList');
  assert.equal(top.content.length, 2);
  const inner = top.content[0].content.find((n) => n.type === 'bulletList');
  assert.ok(inner, 'inner list survives');
  assert.equal(inner.content.length, 2);
});

test('fenced code blocks keep language and text', () => {
  const adf = bodyToAdf('## How\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n');
  const cb = adf.content.find((n) => n.type === 'codeBlock');
  assert.equal(cb.attrs.language, 'ts');
  assert.equal(cb.content[0].text, 'const a = 1;\nconst b = 2;');
});

test('a card body round-trips through ADF back to the same markdown', () => {
  const md = '## What and why\n\nAdd the route.\n\n## Done when\n\n- [ ] Given a, when b, then c.\n- [ ] `npm test` exits 0.\n';
  assert.equal(descriptionToBody(bodyToAdf(md)).trim(), md.trim());
});

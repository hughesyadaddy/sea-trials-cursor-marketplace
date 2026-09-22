import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  adfToMarkdown,
  checkRoundTrip,
  firstDifference,
  normaliseAdf,
} from './adf-to-md.mjs';
import { GOLDEN_SNIPPETS, NASTY_SNIPPETS } from './fixtures/sprint-stories.mjs';
import { markdownToAdf, validateAdf } from './md-to-adf.mjs';

/**
 * normalise(adf(md)) must deep-equal normalise(adf(adfToMd(adf(md)))).
 * Warnings from the converter fail the test: every node md-to-adf emits
 * must have a faithful markdown form.
 */
function assertRoundTrip(name, md) {
  const warnings = [];
  const first = markdownToAdf(md);
  const regenerated = adfToMarkdown(first, { warn: (m) => warnings.push(m) });
  const second = markdownToAdf(regenerated);
  assert.deepEqual(validateAdf(second), [], `${name}: regenerated ADF invalid`);
  const a = normaliseAdf(first);
  const b = normaliseAdf(second);
  const diff = firstDifference(a, b);
  assert.equal(
    diff,
    null,
    `${name}: mismatch at ${diff?.path}\n- ${JSON.stringify(diff?.expected)}\n` +
      `+ ${JSON.stringify(diff?.actual)}\n--- regenerated markdown ---\n${regenerated}`,
  );
  assert.deepEqual(warnings, [], `${name}: converter warned`);
  // Idempotence: a second pass renders the same markdown.
  assert.equal(adfToMarkdown(second, { warn: () => {} }), regenerated, `${name}: not idempotent`);
}

for (const [name, md] of Object.entries(GOLDEN_SNIPPETS)) {
  test(`round-trip golden: ${name}`, () => assertRoundTrip(name, md));
}

for (const [name, md] of Object.entries(NASTY_SNIPPETS)) {
  test(`round-trip nasty: ${name}`, () => assertRoundTrip(name, md));
}

test('checkRoundTrip agrees with the per-fixture assertion', () => {
  for (const md of Object.values({ ...GOLDEN_SNIPPETS, ...NASTY_SNIPPETS })) {
    const r = checkRoundTrip(md, { warn: () => {} });
    assert.equal(r.ok, true, r.diff && JSON.stringify(r.diff));
  }
});

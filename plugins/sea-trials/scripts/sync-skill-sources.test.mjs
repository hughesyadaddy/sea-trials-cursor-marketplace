import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { syncSkillSources } from './sync-skill-sources.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every shared skill reference matches skills/_sources (plugin-local)', () => {
  const result = syncSkillSources({ root: pluginRoot, check: true });
  assert.deepEqual(result.stale, [], `stale copies: ${result.stale.join(', ')}`);
  assert.ok(result.upToDate.length > 0);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { resolveHookCommand } from './st-run.mjs';

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('resolveHookCommand maps sprint-lint to scripts/sprint/sprint-lint.mjs', () => {
  const { cmd, argv } = resolveHookCommand('sprint-lint', pluginRoot);
  assert.equal(cmd, process.execPath);
  assert.equal(
    argv[0],
    path.join(pluginRoot, 'scripts/sprint/sprint-lint.mjs'),
  );
  assert.ok(fs.existsSync(argv[0]));
});

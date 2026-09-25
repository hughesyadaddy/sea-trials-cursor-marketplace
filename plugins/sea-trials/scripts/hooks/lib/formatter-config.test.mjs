import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertFormatterConfigResolvable,
  ensureFlutterFormatReady,
  flutterPackageConfigPath,
} from './formatter-config.mjs';

test('flutterPackageConfigPath points at workspace package_config', () => {
  assert.equal(
    flutterPackageConfigPath('/repo'),
    '/repo/flutter/.dart_tool/package_config.json',
  );
});

test('assertFormatterConfigResolvable fails when package_config is missing', () => {
  assert.throws(
    () =>
      assertFormatterConfigResolvable({
        repoRoot: '/repo',
        exists: () => false,
      }),
    /flutter pub get/,
  );
});

test('ensureFlutterFormatReady runs pub get when package_config is missing', () => {
  const seen = [];
  let hasPackageConfig = false;
  ensureFlutterFormatReady({
    repoRoot: '/repo',
    exists: (p) =>
      p.endsWith('package_config.json') ? hasPackageConfig : true,
    runPubGet: (root) => {
      seen.push(root);
      hasPackageConfig = true;
    },
  });
  assert.deepEqual(seen, ['/repo']);
});

test('ensureFlutterFormatReady skips pub get when package_config exists', () => {
  let pubGetRuns = 0;
  ensureFlutterFormatReady({
    repoRoot: '/repo',
    exists: () => true,
    runPubGet: () => {
      pubGetRuns += 1;
    },
  });
  assert.equal(pubGetRuns, 0);
});

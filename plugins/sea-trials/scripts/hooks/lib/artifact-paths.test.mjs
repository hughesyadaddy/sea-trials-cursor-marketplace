import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_DIR_SEGMENTS,
  isArtifactPath,
  isGeneratedDartPath,
  isLintableDartPath,
} from './artifact-paths.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

// The Rust linter lives in the consuming repo (`tools/sea-trials-lint`),
// not in the plugin. Parity with it is asserted only when that source
// is present; the plugin's own checkout skips rather than fails.
const rustConfigPath = (() => {
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (top.status !== 0) return null;
  const candidate = path.join(
    (top.stdout ?? '').trim(),
    'tools/sea-trials-lint/src/config.rs',
  );
  return existsSync(candidate) ? candidate : null;
})();

test(
  'JS artifact segments match Rust IGNORED_DIR_SEGMENTS',
  { skip: !rustConfigPath && 'requires tools/sea-trials-lint in the checkout' },
  () => {
    const rustSource = readFileSync(rustConfigPath, 'utf8');
    const match = rustSource.match(
      /pub const IGNORED_DIR_SEGMENTS: &\[&str\] = &\[([\s\S]*?)\];/,
    );
    assert.ok(match, 'IGNORED_DIR_SEGMENTS not found in config.rs');
    const rustSegments = [...match[1].matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    assert.deepEqual([...ARTIFACT_DIR_SEGMENTS].sort(), rustSegments.sort());
  },
);

test('isArtifactPath: Flutter truncated build dir', () => {
  assert.equal(
    isArtifactPath('flutter/packages/ai_assistant/b/native_assets/macos/foo.dart'),
    true,
  );
  assert.equal(
    isArtifactPath('flutter/apps/client_app/b/ios/SourcePackages/cloud_firestore/lib/x.dart'),
    true,
  );
});

test('isArtifactPath: standard build dirs', () => {
  assert.equal(isArtifactPath('flutter/packages/foo/.dart_tool/package_config.json'), true);
  assert.equal(isArtifactPath('flutter/packages/foo/build/foo.dill'), true);
  assert.equal(isArtifactPath('flutter/packages/foo/ios/Pods/Foo/bar.dart'), true);
});

test('isArtifactPath: does not false-positive source paths', () => {
  assert.equal(isArtifactPath('flutter/packages/foo/lib/main.dart'), false);
  assert.equal(isArtifactPath('flutter/packages/my_build/lib/x.dart'), false);
  assert.equal(
    isArtifactPath('code_magic_whitelabel_builder/build/script.sh'),
    false,
  );
});

test('isGeneratedDartPath and isLintableDartPath', () => {
  assert.equal(
    isGeneratedDartPath('flutter/packages/foo/lib/src/foo.g.dart'),
    true,
  );
  assert.equal(
    isLintableDartPath('flutter/packages/foo/lib/src/foo.g.dart'),
    false,
  );
  assert.equal(
    isLintableDartPath('flutter/packages/foo/lib/main.dart'),
    true,
  );
  assert.equal(
    isLintableDartPath('flutter/packages/foo/b/cache.dart'),
    false,
  );
});

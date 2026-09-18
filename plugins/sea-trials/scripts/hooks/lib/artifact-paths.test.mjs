import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTIFACT_DIR_SEGMENTS,
  isArtifactPath,
  isGeneratedDartPath,
  isLintableDartPath,
} from './artifact-paths.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.dirname(
  path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))),
);

test('JS artifact segments match Rust IGNORED_DIR_SEGMENTS', () => {
  const rustSource = readFileSync(
    path.join(repoRoot, 'tools/sea-trials-lint/src/config.rs'),
    'utf8',
  );
  const match = rustSource.match(
    /pub const IGNORED_DIR_SEGMENTS: &\[&str\] = &\[([\s\S]*?)\];/,
  );
  assert.ok(match, 'IGNORED_DIR_SEGMENTS not found in config.rs');
  const rustSegments = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...ARTIFACT_DIR_SEGMENTS].sort(), rustSegments.sort());
});

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

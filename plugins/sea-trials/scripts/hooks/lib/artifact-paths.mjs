/**
 * Single source of truth for build-artifact path exclusion.
 *
 * Mirrors .gitignore (b/, build/, .dart_tool/) and
 * tools/sea-trials-lint/src/config.rs (IGNORED_DIR_SEGMENTS).
 * Every gate that accepts explicit file paths must use this — gitignore
 * and analyzer exclude: do not apply when a path is named on the CLI.
 */

/** Directory segments that mark a path as machine-local build output. */
export const ARTIFACT_DIR_SEGMENTS = new Set([
  '.dart_tool',
  '.symlinks',
  '.plugin_symlinks',
  '.pub',
  'SourcePackages',
  'native_assets',
  'Pods',
  'DerivedData',
  'coverage',
  'ephemeral',
  'b',
  'example',
]);

/** Generated Dart suffixes excluded from analyze (format/lint may still run). */
export const GENERATED_DART_RE = /\.(g|freezed|gen|config|mocks)\.dart$/;

/**
 * True when `build/` is tracked source, not Flutter output.
 *
 * @param {string[]} segments path split on `/`
 * @param {number} buildIndex index of the `build` segment
 */
function isWhitelistedBuildSegment(segments, buildIndex) {
  if (buildIndex <= 0) return false;
  return segments[buildIndex - 1] === 'code_magic_whitelabel_builder';
}

/**
 * Whether a repo-relative path lives under a build-artifact directory.
 *
 * Uses whole path-segment matching (not substring) so `my_build/` or
 * `foobar/` never false-positive.
 *
 * @param {string} repoPath repo-relative, forward slashes
 */
export function isArtifactPath(repoPath) {
  const normalized = repoPath.replace(/\\/g, '/');
  if (normalized.includes('GeneratedPluginRegistrant')) {
    return true;
  }

  const segments = normalized.split('/').filter(Boolean);
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (ARTIFACT_DIR_SEGMENTS.has(seg)) {
      return true;
    }
    if (seg === 'build' && !isWhitelistedBuildSegment(segments, i)) {
      return true;
    }
  }
  return false;
}

/** @param {string} repoPath repo-relative */
export function isGeneratedDartPath(repoPath) {
  const normalized = repoPath.replace(/\\/g, '/');
  if (GENERATED_DART_RE.test(normalized)) return true;
  // Gitignored l10n codegen — never format/lint/analyze on dirty tree.
  if (/flutter\/packages\/l10n\/lib\/src\/arb\/app_localizations/.test(normalized)) {
    return true;
  }
  return false;
}

/**
 * Dart sources hooks/CI should format, lint, or analyze.
 *
 * @param {string} repoPath repo-relative
 */
export function isLintableDartPath(repoPath) {
  const normalized = repoPath.replace(/\\/g, '/');
  if (!normalized.startsWith('flutter/') || !normalized.endsWith('.dart')) {
    return false;
  }
  if (isArtifactPath(normalized) || isGeneratedDartPath(normalized)) {
    return false;
  }
  return true;
}

/**
 * Guardrails for `dart format` in the Flutter workspace.
 *
 * Without `flutter/.dart_tool/package_config.json`, `dart format` warns
 * about unresolvable `include:` URIs and falls back to
 * `trailing_commas: automate`. That produces false greens locally and
 * false reds in CI (which runs `flutter pub get` first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

/**
 * @param {string} repoRoot
 */
export function flutterPackageConfigPath(repoRoot) {
  return path.join(repoRoot, 'flutter', '.dart_tool', 'package_config.json');
}

/**
 * @param {{repoRoot: string, exists?: (p: string) => boolean}} opts
 */
export function assertFormatterConfigResolvable({
  repoRoot,
  exists = (p) => fs.existsSync(p),
}) {
  const packageConfig = flutterPackageConfigPath(repoRoot);
  if (!exists(packageConfig)) {
    throw new Error(
      `Missing ${packageConfig}. \`dart format\` would silently ignore ` +
        '`trailing_commas: preserve` and check the diff against a style ' +
        'nobody formats with. Run `flutter pub get` in flutter/ first.',
    );
  }
}

/**
 * @param {string} repoRoot
 * @param {(repoRoot: string) => void} runPubGet
 */
export function runFlutterPubGet(repoRoot, runPubGet = defaultRunFlutterPubGet) {
  runPubGet(repoRoot);
}

/**
 * @param {string} repoRoot
 */
function defaultRunFlutterPubGet(repoRoot) {
  const flutterRoot = path.join(repoRoot, 'flutter');
  const result = spawnSync('flutter', ['pub', 'get'], {
    cwd: flutterRoot,
    encoding: 'utf8',
    shell: isWindows,
  });
  if (result.status !== 0) {
    throw new Error(
      `flutter pub get failed in ${flutterRoot}:\n` +
        `${result.stderr || result.stdout || '(no output)'}`,
    );
  }
}

/**
 * Ensure `package_config.json` exists before any `dart format` task runs.
 *
 * @param {{
 *   repoRoot: string,
 *   exists?: (p: string) => boolean,
 *   runPubGet?: (repoRoot: string) => void,
 * }} opts
 */
export function ensureFlutterFormatReady({
  repoRoot,
  exists = (p) => fs.existsSync(p),
  runPubGet = defaultRunFlutterPubGet,
}) {
  const packageConfig = flutterPackageConfigPath(repoRoot);
  if (!exists(packageConfig)) {
    runPubGet(repoRoot);
  }
  assertFormatterConfigResolvable({ repoRoot, exists });
}

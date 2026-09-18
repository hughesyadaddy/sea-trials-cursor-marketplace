import fs from 'node:fs';
import path from 'node:path';

export const L10N_OUTPUT_REPO_DIR = 'flutter/packages/l10n/lib/src/arb';
export const L10N_MAIN_FILE = 'app_localizations.dart';

const ARB_LOCALE_PATTERN = /^app_(.+)\.arb$/;

/**
 * @param {string} repoRoot
 * @returns {string}
 */
export function l10nArbDirAbs(repoRoot) {
  return path.join(repoRoot, L10N_OUTPUT_REPO_DIR);
}

/**
 * Locale ids from `app_<locale>.arb` files in the l10n package.
 *
 * @param {string} arbDirAbs
 * @returns {string[]}
 */
export function localeIdsFromArbDir(arbDirAbs) {
  if (!fs.existsSync(arbDirAbs)) {
    return [];
  }

  return fs
    .readdirSync(arbDirAbs)
    .map((name) => ARB_LOCALE_PATTERN.exec(name)?.[1])
    .filter((locale) => typeof locale === 'string')
    .sort();
}

/**
 * Repo-relative paths `flutter gen-l10n` must produce for this checkout.
 *
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function expectedL10nGeneratedRepoPaths(repoRoot) {
  const locales = localeIdsFromArbDir(l10nArbDirAbs(repoRoot));
  const paths = [`${L10N_OUTPUT_REPO_DIR}/${L10N_MAIN_FILE}`];

  for (const locale of locales) {
    paths.push(
      `${L10N_OUTPUT_REPO_DIR}/app_localizations_${locale}.dart`,
    );
  }

  return paths;
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function l10nGeneratedAbsPaths(repoRoot) {
  return expectedL10nGeneratedRepoPaths(repoRoot).map((rel) =>
    path.join(repoRoot, rel),
  );
}

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
export function findMissingL10nGenerated(repoRoot) {
  return l10nGeneratedAbsPaths(repoRoot).filter((abs) => !fs.existsSync(abs));
}

/**
 * @param {string} repoRoot
 * @param {string[]} missingAbs
 * @returns {string}
 */
export function formatL10nMissingMessage(repoRoot, missingAbs) {
  const relPaths = missingAbs.map((abs) =>
    path.relative(repoRoot, abs).replace(/\\/g, '/'),
  );
  return (
    'Generated l10n files are missing (gitignored — not in git):\n' +
    `${relPaths.map((p) => `  - ${p}`).join('\n')}\n\n` +
    'Fix:\n' +
    '  pnpm melos run gen-l10n\n' +
    '  # or full bootstrap (clone / new worktree):\n' +
    '  pnpm bootstrap\n'
  );
}

/**
 * @param {string} repoRoot
 * @returns {{ ok: true } | { ok: false, message: string }}
 */
export function assertL10nGenerated(repoRoot) {
  const missing = findMissingL10nGenerated(repoRoot);
  if (missing.length === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    message: formatL10nMissingMessage(repoRoot, missing),
  };
}

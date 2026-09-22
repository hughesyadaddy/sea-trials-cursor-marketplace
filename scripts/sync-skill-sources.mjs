#!/usr/bin/env node
/**
 * Fan out shared skill references from the single source of truth.
 *
 * Source:  plugins/sea-trials/skills/_sources/<name>.md
 * Copies:  plugins/sea-trials/skills/st-*\/references/shared/<name>.md
 *
 * Each copy is the source verbatim, prefixed with a one-line HTML comment
 * marking it as generated. Skills must ship their own copy because both
 * hosts resolve `references/` relative to the skill directory.
 *
 * A skill receives a copy only when one of its own markdown files (SKILL.md
 * or anything under references/ outside references/shared/) links to
 * `shared/<name>`. Copies nobody links to are orphans: reported by --check,
 * deleted on a plain run. This keeps each skill's context budget to what it
 * actually reads.
 *
 * Usage:
 *   node scripts/sync-skill-sources.mjs           # write copies
 *   node scripts/sync-skill-sources.mjs --check   # exit 1 if any copy is stale
 *   node scripts/sync-skill-sources.mjs --root <marketplace-root>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDir, '..');

/** Skills dir relative to the marketplace root. */
export const skillsRel = 'plugins/sea-trials/skills';
/** Source dir relative to the skills dir. */
export const sourcesDirName = '_sources';
/** Copy dir relative to each skill dir. */
export const sharedRel = path.join('references', 'shared');

/**
 * @param {string} name source basename (e.g. review-loop-contract.md)
 * @returns {string} generated-file banner, newline-terminated
 */
export function banner(name) {
  return (
    `<!-- GENERATED from skills/${sourcesDirName}/${name} — do not edit; `
    + 'run node scripts/sync-skill-sources.mjs -->\n'
  );
}

/**
 * @param {string} name
 * @param {string} sourceText
 * @returns {string} full expected copy content
 */
export function renderCopy(name, sourceText) {
  return banner(name) + sourceText;
}

/**
 * @param {string} skillsDir absolute skills dir
 * @returns {string[]} absolute st-* skill dirs, sorted
 */
export function listSkillDirs(skillsDir) {
  let entries;
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith('st-'))
    .map((e) => path.join(skillsDir, e.name))
    .sort();
}

/**
 * @param {string} sourcesDir absolute _sources dir
 * @returns {string[]} source basenames, sorted
 */
export function listSources(sourcesDir) {
  let entries;
  try {
    entries = fs.readdirSync(sourcesDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.md'))
    .map((e) => e.name)
    .sort();
}

/**
 * Markdown files a skill authors itself (everything except generated copies).
 *
 * @param {string} skillDir
 * @returns {string[]} absolute paths
 */
function ownMarkdownFiles(skillDir) {
  const sharedDir = path.join(skillDir, sharedRel);
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (full !== sharedDir) walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(full);
      }
    }
  };
  walk(skillDir);
  return out;
}

/**
 * Source basenames a skill links to via `shared/<name>`.
 *
 * @param {string} skillDir
 * @param {string[]} sources
 * @returns {Set<string>}
 */
export function referencedSources(skillDir, sources) {
  const text = ownMarkdownFiles(skillDir)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
  return new Set(sources.filter((name) => text.includes(`shared/${name}`)));
}

/**
 * @typedef {object} SyncResult
 * @property {string[]} written  copies created or updated (relative)
 * @property {string[]} removed  orphan copies deleted (relative)
 * @property {string[]} stale    copies that differ, are missing, or are
 *                               orphans (relative)
 * @property {string[]} upToDate copies already matching (relative)
 * @property {string[]} sources  source basenames processed
 */

/**
 * Sync (or check) each source into the skills that link to it.
 *
 * @param {{ root?: string, check?: boolean }} [opts]
 * @returns {SyncResult}
 */
export function syncSkillSources(opts = {}) {
  const root = path.resolve(opts.root ?? defaultRoot);
  const check = opts.check ?? false;
  const skillsDir = path.join(root, skillsRel);
  const sourcesDir = path.join(skillsDir, sourcesDirName);

  const sources = listSources(sourcesDir);
  if (sources.length === 0) {
    throw new Error(`no sources found under ${sourcesDir}`);
  }
  const skillDirs = listSkillDirs(skillsDir);
  const expectedByName = new Map(
    sources.map((name) => [
      name,
      renderCopy(name, fs.readFileSync(path.join(sourcesDir, name), 'utf8')),
    ]),
  );

  /** @type {SyncResult} */
  const result = {
    written: [],
    removed: [],
    stale: [],
    upToDate: [],
    sources,
  };

  for (const skillDir of skillDirs) {
    const wanted = referencedSources(skillDir, sources);

    for (const name of wanted) {
      const target = path.join(skillDir, sharedRel, name);
      const rel = path.relative(root, target);
      let current = null;
      try {
        current = fs.readFileSync(target, 'utf8');
      } catch {
        current = null;
      }

      if (current === expectedByName.get(name)) {
        result.upToDate.push(rel);
        continue;
      }
      if (check) {
        result.stale.push(rel);
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, expectedByName.get(name));
      result.written.push(rel);
    }

    // Orphans: copies of a known source that this skill no longer links to.
    const sharedDir = path.join(skillDir, sharedRel);
    let present = [];
    try {
      present = fs.readdirSync(sharedDir).filter((f) => f.endsWith('.md'));
    } catch {
      present = [];
    }
    for (const name of present) {
      if (!sources.includes(name) || wanted.has(name)) continue;
      const target = path.join(sharedDir, name);
      const rel = path.relative(root, target);
      if (check) {
        result.stale.push(rel);
        continue;
      }
      fs.rmSync(target);
      result.removed.push(rel);
    }
    if (!check) {
      try {
        if (fs.readdirSync(sharedDir).length === 0) fs.rmdirSync(sharedDir);
      } catch {
        // shared dir never existed for this skill
      }
    }
  }

  return result;
}

/**
 * @param {string[]} argv
 * @returns {{ check: boolean, root: string | undefined }}
 */
export function parseArgs(argv) {
  let check = false;
  /** @type {string | undefined} */
  let root;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--check') {
      check = true;
    } else if (arg === '--root') {
      root = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--root=')) {
      root = arg.slice('--root='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return { check, root };
}

function main() {
  const { check, root } = parseArgs(process.argv.slice(2));
  const result = syncSkillSources({ root, check });
  const out = process.stdout;

  if (check) {
    if (result.stale.length > 0) {
      process.stderr.write(
        'sync-skill-sources: stale copies (run '
          + 'node scripts/sync-skill-sources.mjs):\n',
      );
      for (const rel of result.stale) process.stderr.write(`  ${rel}\n`);
      process.exit(1);
    }
    out.write(
      `sync-skill-sources: ${result.upToDate.length} copies up to date `
        + `(${result.sources.length} source(s))\n`,
    );
    return;
  }

  for (const rel of result.written) out.write(`wrote ${rel}\n`);
  for (const rel of result.removed) out.write(`removed orphan ${rel}\n`);
  out.write(
    `sync-skill-sources: ${result.written.length} written, `
      + `${result.removed.length} removed, `
      + `${result.upToDate.length} unchanged\n`,
  );
}

const invokedDirectly =
  process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`sync-skill-sources: ${err.message}\n`);
    process.exit(2);
  }
}

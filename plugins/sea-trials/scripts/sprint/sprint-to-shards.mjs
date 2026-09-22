#!/usr/bin/env node
/**
 * Sprint folder → build shard manifest (`shards.json`).
 *
 * Bridges `sprint_planning/<sprint>/` (parsed by
 * `parse-sprint-folder.mjs`) to the manifest consumed by
 * `st-build-with-subagents` (validated by
 * `skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs`).
 *
 * Usage:
 *   node sprint-to-shards.mjs <sprint-dir> [--epic <id>] [--repo-root <dir>]
 *     [--max-parallel N] [--out shards.json] [--out-map map.md] [--dry-run]
 *
 * `<sprint-dir>` is one sprint folder, or a root whose sub-folders are
 * sprint folders (one epic each). `--epic` keeps one of them by folder
 * name, epic title slug, or `sprint.json` `epicKey`.
 *
 * Mapping (one story → one shard):
 *   id         `us<N>-<slug>` from the story file name
 *   paths      `## Files to touch` + subtask `**Files to change**`, else
 *              repo-looking tokens in the story text, else `[]` + warning
 *   dependsOn  `**Blocked by:**` plus implicit ordering: when two stories
 *              overlap on a path prefix the earlier one owns it and the
 *              later one depends on it (keeps shards disjoint)
 *   tier       kind/labels/title: verify|docs|rename|l10n → mechanical;
 *              migration|schema|architecture|security → reasoning;
 *              otherwise code
 *   summary    story title + first line of the goal
 *   sharedFiles pubspec.yaml, .arb, barrel, package.json, index.*,
 *              shards.json listed by two or more stories are lifted to the
 *              manifest and removed from shard paths
 *
 * stdout is pure manifest JSON; hints and warnings go to stderr. The
 * manifest is validated before emit; validator errors exit 1. Shards
 * with no paths are emitted (so they can be filled in) and warned about.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadSprint, storyIdFromFile } from './parse-sprint-folder.mjs';
import {
  barrelFor,
  looksShared,
  MAX_PARALLEL_CAP,
  packageRoot,
  validateManifest,
} from '../../skills/st-build-with-subagents/scripts/validate-shard-manifest.mjs';

// ===========================================================================
// CONSTANTS
// ===========================================================================

/** Default `maxParallel` for generated manifests. */
export const DEFAULT_MAX_PARALLEL = 6;

const REASONING_RE = /\b(migrations?|schema|architecture|security)\b/i;
const MECHANICAL_RE = /\b(verify|verification|qa|docs?|rename|l10n)\b/i;
const REPO_PATH_RE =
  /(?:^|[\s(`'"])((?:flutter|web|functions|supabase|packages|apps)\/[\w@.\-/]+)/g;
const SHARDS_JSON_RE = /(^|\/)shards\.json$/;
const SUMMARY_MAX = 200;
const STORY_FILE_ID_RE = /^\d{2}(?:-[a-z])?[-_](us\d+[a-z]?)(?:[-_](.*))?$/i;
const LEGACY_FILE_ID_RE = /^(\d{2})_(.*)$/;

// ===========================================================================
// HELPERS
// ===========================================================================

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

/** Shard id from a story file name: `03-us3-invoice-pdf.md` → `us3-invoice-pdf`. */
export function shardIdForStory(story) {
  const base = path.basename(story.file, '.md');
  const us = STORY_FILE_ID_RE.exec(base);
  if (us) return slugify(us[2] ? `${us[1]}-${us[2]}` : us[1]);
  const legacy = LEGACY_FILE_ID_RE.exec(base);
  if (legacy) return slugify(`us${legacy[1]}-${legacy[2]}`);
  return slugify(`us${story.id}-${base}`);
}

/**
 * Normalise a listed path to a repo-relative POSIX prefix. Directories
 * (no extension in the last segment, or a trailing slash) end with `/`.
 * Returns null for values that cannot be shard paths.
 *
 * @param {string} raw
 * @param {{ repoRoot?: string }} opts
 */
export function normalisePath(raw, opts = {}) {
  let p = toPosix(raw).trim().replace(/^`|`$/g, '');
  p = p.replace(/^[("']+/, '').replace(/[)"',;:]+$/, '').replace(/\.+$/, '');
  if (!p || /^https?:\/\//i.test(p)) return null;
  if (opts.repoRoot) {
    const root = toPosix(path.resolve(opts.repoRoot)).replace(/\/$/, '');
    const abs = toPosix(path.resolve(opts.repoRoot, p));
    if (path.isAbsolute(p) || /^[a-z]:\//i.test(p)) {
      if (!abs.startsWith(`${root}/`)) return null;
      p = abs.slice(root.length + 1);
    }
  }
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '');
  if (!p || p.split('/').includes('..')) return null;
  const isDir = p.endsWith('/') || !/\.[\w-]+$/.test(p.split('/').pop());
  p = p.replace(/\/+$/, '');
  if (opts.repoRoot) {
    const full = path.join(opts.repoRoot, p);
    if (fs.existsSync(full)) {
      return fs.statSync(full).isDirectory() ? `${p}/` : p;
    }
  }
  return isDir ? `${p}/` : p;
}

/** Drop paths covered by another path of the same set (prefix rule). */
function collapsePrefixes(paths) {
  const unique = [...new Set(paths)];
  return unique.filter(
    (p) => !unique.some((o) => o !== p && p.startsWith(o)),
  );
}

function overlaps(a, b) {
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/** Repo-looking tokens in free text, for stories without a files list. */
export function inferPathsFromText(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(REPO_PATH_RE)) {
    const p = normalisePath(m[1]);
    if (p && !/\.md$/i.test(p) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** First line of the goal: `**Goal:**`, `## Description`, or first prose. */
export function goalLine(description) {
  const lines = String(description ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const clean = (s) =>
    s
      .replace(/\*\*Goal:\*\*\s*/i, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .trim();
  const goal = lines.find((l) => /^\*\*Goal:\*\*/i.test(l.trim()));
  if (goal) return clean(goal);
  let inSection = false;
  let inFence = false;
  const prose = (l) =>
    l && !/^#{1,6}\s/.test(l) && !/^\|/.test(l) && !/^[-*+]\s|^\d+[.)]\s/.test(l);
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(`{3,}|~{3,})/.test(l)) inFence = !inFence;
    if (inFence) continue;
    if (/^#{2,6}\s+(description|goal)\s*$/i.test(l)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      if (/^#{1,6}\s/.test(l)) break;
      if (prose(l)) return clean(l);
    }
  }
  const first = lines.map((l) => l.trim()).find(prose);
  return first ? clean(first) : '';
}

/** Story kind text used for tier inference. */
function kindText(story) {
  const sections = [];
  if (/^#{2,6}\s+(what to test|platforms)\s*$/im.test(story.description)) {
    sections.push('verify');
  }
  if (/^#{2,6}\s+commands\s*$/im.test(story.description)) {
    sections.push('migration');
  }
  return [story.kind ?? '', ...(story.labels ?? []), story.summary, ...sections]
    .join(' ');
}

/** Tier from story kind, labels, title and section shape. */
export function tierForStory(story) {
  const text = kindText(story);
  if (REASONING_RE.test(text)) return 'reasoning';
  if (MECHANICAL_RE.test(text)) return 'mechanical';
  return 'code';
}

export function summaryForStory(story) {
  const goal = goalLine(story.description);
  const joined = goal ? `${story.summary} - ${goal}` : story.summary;
  const oneLine = joined.replace(/\s*\n\s*/g, ' ').replace(/\|/g, '/').trim();
  return oneLine.length > SUMMARY_MAX
    ? `${oneLine.slice(0, SUMMARY_MAX - 3)}...`
    : oneLine;
}

function isSharedLooking(p) {
  return looksShared(p) || SHARDS_JSON_RE.test(p);
}

// ===========================================================================
// EPIC DISCOVERY
// ===========================================================================

function hasStoryFiles(dir) {
  return fs
    .readdirSync(dir)
    .some((f) => f.endsWith('.md') && storyIdFromFile(f) !== null);
}

/**
 * Sprint folders under `root`: the root itself when it holds story
 * files, else each direct sub-folder that does.
 *
 * @param {string} root
 * @returns {{ id: string, dir: string, sprint: ReturnType<typeof loadSprint> }[]}
 */
export function discoverEpics(root) {
  const dirs = hasStoryFiles(root)
    ? [root]
    : fs
        .readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => path.join(root, d.name))
        .filter(hasStoryFiles)
        .sort();
  return dirs.map((dir) => ({
    id: path.basename(dir),
    dir,
    sprint: loadSprint(dir),
  }));
}

function epicMatches(epic, wanted) {
  const want = slugify(wanted);
  if (slugify(epic.id) === want) return true;
  if (epic.sprint.epic && slugify(epic.sprint.epic.summary) === want) {
    return true;
  }
  const key = epic.sprint.config?.epicKey ?? epic.sprint.config?.jira?.epicKey;
  return Boolean(key) && slugify(key) === want;
}

// ===========================================================================
// MANIFEST BUILD
// ===========================================================================

/**
 * Build a shard manifest from a sprint folder.
 *
 * @param {string} sprintDir
 * @param {{ epic?: string, repoRoot?: string, maxParallel?: number }} opts
 * @returns {{
 *   manifest: object,
 *   hints: string[],
 *   validation: ReturnType<typeof validateManifest>,
 *   needsPaths: string[],
 * }}
 */
export function buildManifest(sprintDir, opts = {}) {
  const hints = [];
  const hint = (msg) => hints.push(msg);

  let epics = discoverEpics(sprintDir);
  if (!epics.length) throw new Error(`no story files under ${sprintDir}`);
  if (opts.epic) {
    epics = epics.filter((e) => epicMatches(e, opts.epic));
    if (!epics.length) throw new Error(`no epic matches --epic ${opts.epic}`);
  }
  const prefixIds = epics.length > 1;

  // 1. One draft shard per story, in epic order then story order.
  const drafts = [];
  for (const epic of epics) {
    const prefix = prefixIds ? slugify(epic.id) : '';
    for (const story of epic.sprint.stories) {
      const id = prefix
        ? `${prefix}-${shardIdForStory(story)}`
        : shardIdForStory(story);
      const listed = [
        ...(story.files ?? []),
        ...story.subtasks.flatMap((s) => s.files ?? []),
      ];
      let paths = listed
        .map((p) => normalisePath(p, { repoRoot: opts.repoRoot }))
        .filter(Boolean);
      let inferred = false;
      if (!paths.length) {
        const text = [
          story.description,
          ...story.subtasks.map((s) => s.description),
        ].join('\n');
        paths = inferPathsFromText(text);
        inferred = paths.length > 0;
        if (inferred) {
          hint(
            `shard ${id}: no files section; inferred ${paths.length} ` +
              `path(s) from the story text`,
          );
        }
      }
      drafts.push({
        id,
        epicId: epic.id,
        storyId: story.id,
        story,
        paths: collapsePrefixes(paths),
        listedShared: [],
        dependsOn: new Set(),
        tier: tierForStory(story),
        summary: summaryForStory(story),
        inferred,
      });
    }
  }
  // 2. Lift shared-looking files listed by two or more stories.
  const sharedCount = new Map();
  for (const d of drafts) {
    for (const p of d.paths) {
      if (isSharedLooking(p)) sharedCount.set(p, (sharedCount.get(p) ?? 0) + 1);
    }
  }
  const sharedAll = new Set(
    [...sharedCount].filter(([, n]) => n >= 2).map(([p]) => p),
  );
  const lift = (d, p, why) => {
    d.paths = d.paths.filter((x) => x !== p);
    if (!d.listedShared.includes(p)) d.listedShared.push(p);
    sharedAll.add(p);
    hint(`shard ${d.id}: ${p} → sharedFiles (${why})`);
  };
  for (const d of drafts) {
    for (const p of [...d.paths]) {
      if (sharedAll.has(p)) lift(d, p, 'listed by more than one story');
    }
  }

  // 3. Intra-package splits need an integrator-owned file under the root.
  const rootOwners = new Map();
  for (const d of drafts) {
    for (const p of d.paths) {
      const root = packageRoot(p);
      if (!root) continue;
      if (!rootOwners.has(root)) rootOwners.set(root, new Set());
      rootOwners.get(root).add(d.id);
    }
  }
  for (const [root, owners] of rootOwners) {
    if (owners.size < 2) continue;
    for (const d of drafts) {
      if (!owners.has(d.id)) continue;
      for (const p of [...d.paths]) {
        if (p.startsWith(root) && isSharedLooking(p)) {
          lift(d, p, `shared-looking file inside split package ${root}`);
        }
      }
    }
    if (![...sharedAll].some((f) => f.startsWith(root))) {
      const dartish = drafts.some((d) =>
        d.paths.some((p) => p.startsWith(root) && /\/lib\/|\.dart$/.test(p)),
      );
      const defaults = dartish
        ? [barrelFor(root), `${root}pubspec.yaml`].filter(Boolean)
        : [`${root}package.json`];
      for (const f of defaults) sharedAll.add(f);
      hint(
        `shards ${[...owners].sort().join(', ')} split package ${root}; ` +
          `declared ${defaults.join(', ')} as integrator-owned sharedFiles`,
      );
    }
  }

  // 4. Explicit dependencies from `**Blocked by:**`.
  const findDep = (d, storyId) =>
    drafts.find((o) => o.epicId === d.epicId && o.storyId === storyId) ??
    drafts.find((o) => o.storyId === storyId);
  for (const d of drafts) {
    for (const blocker of d.story.blockedBy ?? []) {
      const dep = findDep(d, blocker);
      if (!dep) {
        hint(
          `shard ${d.id}: blocked by US${blocker}, which is not in this ` +
            'manifest; dropped',
        );
        continue;
      }
      if (dep.id !== d.id) d.dependsOn.add(dep.id);
    }
  }

  // 5. Implicit ordering: the earlier story owns an overlapping prefix.
  for (let j = 0; j < drafts.length; j += 1) {
    const later = drafts[j];
    for (let i = 0; i < j; i += 1) {
      const earlier = drafts[i];
      for (const pj of [...later.paths]) {
        const hit = earlier.paths.find((pi) => overlaps(pi, pj));
        if (!hit) continue;
        later.paths = later.paths.filter((x) => x !== pj);
        later.dependsOn.add(earlier.id);
        hint(
          `shard ${later.id}: ${pj} overlaps ${hit} owned by ` +
            `${earlier.id}; removed and added dependsOn ${earlier.id}`,
        );
      }
    }
  }

  // 6. Assemble.
  const needsPaths = [];
  const shards = drafts.map((d) => {
    if (!d.paths.length) {
      needsPaths.push(d.id);
      hint(`shard ${d.id}: needs paths (no files listed or all owned elsewhere)`);
    }
    const shard = {
      id: d.id,
      paths: d.paths,
      dependsOn: [...d.dependsOn],
      tier: d.tier,
    };
    if (d.listedShared.length) shard.sharedFiles = [...d.listedShared].sort();
    shard.summary = d.summary;
    return shard;
  });
  const maxParallel =
    opts.maxParallel ??
    Math.max(1, Math.min(DEFAULT_MAX_PARALLEL, shards.length));
  const manifest = {
    version: 1,
    source: 'sprint-to-shards',
    maxParallel,
    sharedFiles: [...sharedAll].sort(),
    shards,
  };
  const seen = new Set();
  for (const d of drafts) {
    if (seen.has(d.id)) hint(`duplicate shard id ${d.id}; rename one story file`);
    seen.add(d.id);
  }

  // Validate with a placeholder for empty paths so every other rule runs.
  const probe = structuredClone(manifest);
  for (const s of probe.shards) {
    if (!s.paths.length) s.paths = [`__needs_paths__/${s.id}/`];
  }
  const validation = validateManifest(probe);
  return { manifest, hints, validation, needsPaths };
}

// ===========================================================================
// EXECUTION MAP
// ===========================================================================

function cell(values) {
  return values.length ? values.map((v) => `\`${v}\``).join(', ') : '-';
}

/**
 * `## Parallel execution map` table that
 * `suggest-shards-from-plan.mjs` parses back into the same shards.
 *
 * @param {object} manifest
 * @returns {string}
 */
export function renderExecutionMap(manifest) {
  const lines = [
    '## Parallel execution map',
    '',
    '| id | paths | dependsOn | tier | sharedFiles | summary |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const s of manifest.shards) {
    const summary = String(s.summary ?? '')
      .replace(/\|/g, '/')
      .replace(/\s+/g, ' ')
      .trim();
    lines.push(
      `| \`${s.id}\` | ${cell(s.paths)} | ${cell(s.dependsOn ?? [])} | ` +
        `${s.tier ?? 'code'} | ${cell(s.sharedFiles ?? [])} | ${summary} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

// ===========================================================================
// CLI
// ===========================================================================

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[++i];
    } else out.positional.push(arg);
  }
  return out;
}

function usage() {
  process.stderr.write(
    'usage: sprint-to-shards.mjs <sprint-dir> [--epic <id>] ' +
      '[--repo-root <dir>] [--max-parallel N] [--out shards.json] ' +
      '[--out-map map.md] [--dry-run]\n',
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = args.positional[0];
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    usage();
    process.exit(2);
  }
  let maxParallel;
  if (args.maxParallel !== undefined) {
    maxParallel = Number(args.maxParallel);
    if (
      !Number.isInteger(maxParallel) ||
      maxParallel < 1 ||
      maxParallel > MAX_PARALLEL_CAP
    ) {
      process.stderr.write(
        `--max-parallel must be an integer between 1 and ${MAX_PARALLEL_CAP}\n`,
      );
      process.exit(2);
    }
  }

  let result;
  try {
    result = buildManifest(dir, {
      epic: args.epic,
      repoRoot: args.repoRoot,
      maxParallel,
    });
  } catch (err) {
    process.stderr.write(`sprint-to-shards: ${err.message}\n`);
    process.exit(1);
  }
  const { manifest, hints, validation, needsPaths } = result;
  for (const h of hints) process.stderr.write(`[sprint-to-shards] ${h}\n`);
  for (const w of validation.warnings) {
    process.stderr.write(`[sprint-to-shards] warn: ${w}\n`);
  }
  if (!validation.ok) {
    process.stderr.write(
      `[sprint-to-shards] manifest invalid (${validation.errors.length} ` +
        'error(s)):\n',
    );
    for (const e of validation.errors) process.stderr.write(`  ${e}\n`);
    process.exit(1);
  }

  const json = `${JSON.stringify(manifest, null, 2)}\n`;
  if (args.out && !args.dryRun) {
    fs.writeFileSync(args.out, json);
    process.stderr.write(`[sprint-to-shards] wrote ${args.out}\n`);
  } else {
    process.stdout.write(json);
  }
  if (args.outMap) {
    const map = renderExecutionMap(manifest);
    if (args.dryRun) {
      process.stderr.write(`[sprint-to-shards] dry-run: would write ${args.outMap}\n`);
    } else {
      fs.writeFileSync(args.outMap, map);
      process.stderr.write(`[sprint-to-shards] wrote ${args.outMap}\n`);
    }
  }
  const tail = needsPaths.length
    ? `; ${needsPaths.length} shard(s) need paths before ` +
      'validate-shard-manifest.mjs passes'
    : '; run validate-shard-manifest.mjs on the output';
  process.stderr.write(
    `[sprint-to-shards] ${manifest.shards.length} shard(s), ` +
      `${manifest.sharedFiles.length} shared file(s), ` +
      `maxParallel=${manifest.maxParallel}${tail}\n`,
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}

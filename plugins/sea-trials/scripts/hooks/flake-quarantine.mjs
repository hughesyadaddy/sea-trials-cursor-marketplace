#!/usr/bin/env node
/**
 * Flaky-test quarantine for the PR review loop.
 *
 *   node flake-quarantine.mjs classify --pr <n> [--json]
 *   node flake-quarantine.mjs retry --pr <n> --check <name> [--isolated]
 *   node flake-quarantine.mjs quarantine --file <path> [--test "<name>"] \
 *        --reason "<text>" --issue <url> [--pr <n>]
 *   node flake-quarantine.mjs unquarantine --file <path> [--test "<name>"]
 *   node flake-quarantine.mjs issue --pr <n> --check <name> \
 *        --test-file <path> [--test "<name>"] [--dry-run]
 *   node flake-quarantine.mjs ledger [--json]
 *
 * Every `gh` / `git` / `flutter` / `dart` / `node` call goes through an
 * injectable runner so unit tests never touch the network. The skip
 * transforms are pure string functions (Dart + Node) and idempotent.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { stateDir } from '../lib/st-state-dir.mjs';
import {
  filterPrGateChecks,
  getRepoRoot,
  parsePrArgs,
} from './lib/pr-review-lib.mjs';

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Never quarantine a test whose path or name matches one of these. */
export const PROTECTED_PATTERNS = [
  /integration_test\//i,
  /scenario_/i,
  /golden/i,
  /security/i,
  /\bauth/i,
  /payment/i,
  /billing/i,
];

/** Max quarantines one PR may carry without a human sign-off. */
export const MAX_QUARANTINES_PER_PR = 2;

export const FLAKY_LABEL = 'flaky-test';
export const FLAKY_LABEL_COLOR = 'E4E669';

const DEFAULT_POLL_INTERVAL_MS = 30_000;
const DEFAULT_MAX_WAIT_MS = 45 * 60_000;
const EXCERPT_MAX_LINES = 40;

// ---------------------------------------------------------------------------
// Runner (injectable)
// ---------------------------------------------------------------------------

/**
 * @typedef {(cmd: string, args: string[], opts?: { cwd?: string }) =>
 *   { status: number | null, stdout: string, stderr: string }} Runner
 */

/** @type {Runner} */
export function defaultRunner(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    shell: isWindows,
    stdio: 'pipe',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function ok(result) {
  return result && result.status === 0;
}

function must(result, what) {
  if (!ok(result)) {
    throw new Error(
      `${what} failed: ${(result?.stderr || result?.stdout || '').trim()}`,
    );
  }
  return result.stdout;
}

// ---------------------------------------------------------------------------
// Log parsing
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;]*m/g;
const GH_LOG_PREFIX_RE = /^([^\t]*)\t([^\t]*)\t/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*/;

/** Strip ANSI, the `job\tstep\t` prefix `gh run view --log` adds, and timestamps. */
export function normalizeLogLine(line) {
  let out = line.replace(ANSI_RE, '');
  out = out.replace(GH_LOG_PREFIX_RE, '');
  out = out.replace(TIMESTAMP_RE, '');
  return out.trimEnd();
}

/** First `job` column of a `gh run view --log-failed` dump, if any. */
export function extractJobName(logText) {
  for (const raw of (logText ?? '').split(/\r?\n/)) {
    const m = raw.match(GH_LOG_PREFIX_RE);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

const TEST_FILE_RE = /(?:[\w@./-]+\/)?[\w.-]+(?:_test\.dart|\.test\.mjs)\b/g;
const RUNNER_PREFIX_RE = /^.*?\/work\/[^/]+\/[^/]+\//;

/**
 * Test file paths mentioned in a job log. Paths are normalised to be
 * repo-relative when they carry the GitHub runner workspace prefix
 * (`/home/runner/work/<repo>/<repo>/…`).
 */
export function extractTestFiles(logText) {
  const seen = new Set();
  for (const raw of (logText ?? '').split(/\r?\n/)) {
    const line = normalizeLogLine(raw);
    for (const match of line.matchAll(TEST_FILE_RE)) {
      let file = match[0];
      file = file.replace(RUNNER_PREFIX_RE, '');
      file = file.replace(/^\.\//, '');
      file = file.replace(/^file:\/\//, '');
      if (file.startsWith('/')) continue;
      seen.add(file);
    }
  }
  return [...seen];
}

/**
 * Failing test names from `[E]` (Dart) and `✖` (node:test spec) lines.
 */
export function extractFailingTestNames(logText) {
  const names = new Set();
  for (const raw of (logText ?? '').split(/\r?\n/)) {
    const line = normalizeLogLine(raw);
    const dart = line.match(/^\s*(?:\d{2}:\d{2}\s+[+\-~\d\s]*:\s*)?(.*)\s\[E\]\s*$/);
    if (dart) {
      let name = dart[1].trim();
      // `path/to/x_test.dart: group name test name` → drop the file part.
      const fileSplit = name.match(/^(?:.*?_test\.dart):\s*(.*)$/);
      if (fileSplit) name = fileSplit[1].trim();
      if (name) names.add(name);
      continue;
    }
    const node = line.match(/^\s*✖\s+(.*?)(?:\s+\(\d+(?:\.\d+)?ms\))?\s*$/);
    if (node) {
      const name = node[1].trim();
      if (name && !/^(tests?|suites?|pass|fail|skipped|todo|failing tests:?)\b/.test(name)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

/**
 * Up to `max` lines of the log around the first failure marker, for
 * the tracking-issue body.
 */
export function extractFailureExcerpt(logText, max = EXCERPT_MAX_LINES) {
  const lines = (logText ?? '')
    .split(/\r?\n/)
    .map(normalizeLogLine)
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const markerAt = lines.findIndex((l) =>
    /\[E\]|✖|Expected:|Actual:|Exception|Error:|AssertionError/.test(l),
  );
  const start = markerAt < 0 ? 0 : Math.max(0, markerAt - 5);
  return lines.slice(start, start + max);
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

/**
 * Nearest directory (walking up from `file`) that holds a `pubspec.yaml`
 * or `package.json`. Falls back to a `flutter/{apps,packages}/<name>`
 * heuristic when no filesystem is available.
 *
 * @param {string} file repo-relative path
 * @param {{ repoRoot?: string, existsSync?: (p: string) => boolean }} [opts]
 */
export function packageRootOf(file, opts = {}) {
  const existsSync = opts.existsSync ?? fs.existsSync;
  if (opts.repoRoot) {
    let dir = path.posix.dirname(file);
    while (dir && dir !== '.' && dir !== '/') {
      const abs = path.join(opts.repoRoot, dir);
      if (
        existsSync(path.join(abs, 'pubspec.yaml')) ||
        existsSync(path.join(abs, 'package.json'))
      ) {
        return dir;
      }
      dir = path.posix.dirname(dir);
    }
  }
  const m = file.match(/^((?:flutter\/)?(?:apps|packages)\/[^/]+)\//);
  if (m) return m[1];
  return path.posix.dirname(file);
}

/**
 * Map test paths from a job log (often package-relative, e.g.
 * `test/foo_test.dart` printed by `flutter test` from the package dir)
 * to repo-relative paths. Uses the filesystem first, then a unique
 * `git ls-files` suffix match. Anything still unknown is reported as
 * unresolved and excluded from attribution.
 *
 * @param {string[]} files
 * @param {{ repoRoot: string, run?: Runner, existsSync?: (p: string) => boolean }} opts
 */
export function resolveTestFiles(files, { repoRoot, run = defaultRunner, existsSync }) {
  const exists = existsSync ?? fs.existsSync;
  const resolved = [];
  const unresolved = [];
  for (const file of files) {
    if (exists(path.join(repoRoot, file))) {
      resolved.push(file);
      continue;
    }
    const ls = run('git', ['ls-files', '--full-name', '--', `*/${file}`], { cwd: repoRoot });
    const hits = ok(ls)
      ? ls.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
      : [];
    if (hits.length === 1) {
      resolved.push(hits[0]);
    } else {
      unresolved.push(file);
    }
  }
  return { resolved: [...new Set(resolved)], unresolved };
}

/**
 * Decide whether a CI failure can be attributed to the PR diff.
 *
 * Conservative: when no test file could be parsed from the log (or none
 * could be resolved to a repo path) we report `attributable: true`
 * (treat as real) because the loop must not quarantine what it cannot
 * locate.
 *
 * @param {{
 *   testFiles: string[],
 *   changedFiles: string[],
 *   unresolvedFiles?: string[],
 *   repoRoot?: string,
 *   existsSync?: (p: string) => boolean,
 * }} input
 */
export function attributeFailure({
  testFiles,
  changedFiles,
  unresolvedFiles = [],
  repoRoot,
  existsSync,
}) {
  const changed = new Set(changedFiles.map((f) => f.replace(/\\/g, '/')));
  const unresolvedNote =
    unresolvedFiles.length > 0
      ? `; ${unresolvedFiles.length} log path(s) could not be resolved in the repo: ${unresolvedFiles.join(', ')}`
      : '';
  if (testFiles.length === 0) {
    return {
      attributable: true,
      reason:
        (unresolvedFiles.length > 0
          ? 'no log test path could be resolved to a repo file'
          : 'no test files found in the job log') +
        '; cannot prove the failure is unrelated to the diff' +
        unresolvedNote,
      matchedFiles: [],
      matchedPackages: [],
    };
  }
  const matchedFiles = testFiles.filter((f) => changed.has(f));
  if (matchedFiles.length > 0) {
    return {
      attributable: true,
      reason: `test file changed in this PR: ${matchedFiles.join(', ')}`,
      matchedFiles,
      matchedPackages: [],
    };
  }
  const changedPackages = new Set(
    [...changed].map((f) => packageRootOf(f, { repoRoot, existsSync })),
  );
  const matchedPackages = [
    ...new Set(
      testFiles
        .map((f) => packageRootOf(f, { repoRoot, existsSync }))
        .filter((p) => changedPackages.has(p)),
    ),
  ];
  if (matchedPackages.length > 0) {
    return {
      attributable: true,
      reason: `package changed in this PR: ${matchedPackages.join(', ')}`,
      matchedFiles: [],
      matchedPackages,
    };
  }
  return {
    attributable: false,
    reason:
      `none of ${testFiles.length} failing test file(s) or their packages appear in the PR diff` +
      unresolvedNote,
    matchedFiles: [],
    matchedPackages: [],
  };
}

/** Which protected patterns a file or test name trips (empty = none). */
export function protectedMatches(...values) {
  const hits = new Set();
  for (const v of values) {
    if (!v) continue;
    for (const re of PROTECTED_PATTERNS) {
      if (re.test(v)) hits.add(re.source);
    }
  }
  return [...hits];
}

/** Parse `run` and `job` ids from a checks `link`. */
export function parseRunLink(link) {
  const m = (link ?? '').match(/\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/);
  if (!m) return { runId: null, jobId: null };
  return { runId: m[1], jobId: m[2] ?? null };
}

// ---------------------------------------------------------------------------
// gh / git helpers (all via runner)
// ---------------------------------------------------------------------------

function ghPrMeta(run, repoRoot, prNumber) {
  const out = must(
    run(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'number,url,headRefName,headRefOid,baseRefName',
      ],
      { cwd: repoRoot },
    ),
    'gh pr view',
  );
  return JSON.parse(out.trim());
}

function ghFailedChecks(run, repoRoot, prNumber) {
  const result = run(
    'gh',
    ['pr', 'checks', String(prNumber), '--json', 'name,bucket,state,link,workflow'],
    { cwd: repoRoot },
  );
  const trimmed = (result.stdout ?? '').trim();
  if (!trimmed) {
    if (/no checks reported/.test(result.stderr ?? '')) return [];
    if (!ok(result) && result.status !== 8 && result.status !== 1) {
      must(result, 'gh pr checks');
    }
    return [];
  }
  const all = JSON.parse(trimmed);
  return filterPrGateChecks(all).filter(
    (c) => c.bucket === 'fail' || c.bucket === 'cancel',
  );
}

function ghFailedLog(run, repoRoot, runId, jobId) {
  const args = ['run', 'view', String(runId), '--log-failed'];
  if (jobId) args.push('--job', String(jobId));
  const result = run('gh', args, { cwd: repoRoot });
  return result.stdout ?? '';
}

function gitChangedFiles(run, repoRoot, baseRef) {
  const result = run(
    'git',
    ['diff', '--name-only', `origin/${baseRef}...HEAD`],
    { cwd: repoRoot },
  );
  if (!ok(result)) return [];
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function repoSlug(run, repoRoot, env = process.env) {
  const explicit = (env.GH_REPO ?? '').trim();
  if (explicit.includes('/')) return explicit;
  const result = run('git', ['remote', 'get-url', 'origin'], { cwd: repoRoot });
  const url = (result.stdout ?? '').trim();
  const m = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
  if (m) return m[1];
  return path.basename(repoRoot);
}

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

/**
 * @param {{ prNumber: number, repoRoot: string, run?: Runner,
 *   existsSync?: (p: string) => boolean }} opts
 */
export function classify({ prNumber, repoRoot, run = defaultRunner, existsSync }) {
  const pr = ghPrMeta(run, repoRoot, prNumber);
  const failed = ghFailedChecks(run, repoRoot, prNumber);
  const changedFiles = gitChangedFiles(run, repoRoot, pr.baseRefName ?? 'dev');

  const failures = failed.map((check) => {
    const { runId, jobId } = parseRunLink(check.link);
    const log = runId ? ghFailedLog(run, repoRoot, runId, jobId) : '';
    const { resolved: testFiles, unresolved } = resolveTestFiles(
      extractTestFiles(log),
      { repoRoot, run, existsSync },
    );
    const testNames = extractFailingTestNames(log);
    const attribution = attributeFailure({
      testFiles,
      changedFiles,
      unresolvedFiles: unresolved,
      repoRoot,
      existsSync,
    });
    return {
      check: check.name,
      runId,
      jobId,
      jobName: extractJobName(log) ?? check.name,
      link: check.link ?? null,
      testFiles,
      unresolvedFiles: unresolved,
      testNames,
      attributable: attribution.attributable,
      reason: attribution.reason,
      protected: protectedMatches(...testFiles, ...testNames),
      excerpt: extractFailureExcerpt(log),
    };
  });

  return {
    pr: {
      number: pr.number,
      url: pr.url,
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      baseRefName: pr.baseRefName,
    },
    changedFiles,
    failures,
  };
}

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

function isFlutterPackage(pkgDirAbs, readFileSync = fs.readFileSync) {
  try {
    const pubspec = readFileSync(path.join(pkgDirAbs, 'pubspec.yaml'), 'utf8');
    return /^\s{2}flutter:\s*$/m.test(pubspec) || /sdk:\s*flutter/.test(pubspec);
  } catch {
    return false;
  }
}

/**
 * Run one test file locally in its package directory.
 *
 * @param {{ file: string, repoRoot: string, run?: Runner,
 *   existsSync?: (p: string) => boolean,
 *   readFileSync?: (p: string, enc: string) => string }} opts
 */
export function runIsolated({
  file,
  repoRoot,
  run = defaultRunner,
  existsSync,
  readFileSync = fs.readFileSync,
}) {
  const exists = existsSync ?? fs.existsSync;
  const abs = path.join(repoRoot, file);
  if (!exists(abs)) {
    return { file, ran: false, passed: null, reason: 'file not found locally' };
  }
  const pkgRel = packageRootOf(file, { repoRoot, existsSync: exists });
  const pkgAbs = path.join(repoRoot, pkgRel);
  const rel = path.relative(pkgAbs, abs).replace(/\\/g, '/');
  let cmd;
  let args;
  if (file.endsWith('.test.mjs')) {
    cmd = 'node';
    args = ['--test', rel];
  } else if (isFlutterPackage(pkgAbs, readFileSync)) {
    cmd = 'flutter';
    args = ['test', rel];
  } else {
    cmd = 'dart';
    args = ['test', rel];
  }
  const result = run(cmd, args, { cwd: pkgAbs });
  return {
    file,
    ran: true,
    passed: ok(result),
    command: `${cmd} ${args.join(' ')}`,
    cwd: pkgRel,
    tail: (result.stdout + result.stderr).split(/\r?\n/).slice(-20).join('\n'),
  };
}

/**
 * Rerun the failed jobs of one check and wait for the run to finish.
 *
 * @param {{
 *   prNumber: number, check: string, repoRoot: string, isolated?: boolean,
 *   run?: Runner, sleep?: (ms: number) => Promise<void>,
 *   intervalMs?: number, maxWaitMs?: number,
 *   existsSync?: (p: string) => boolean,
 *   readFileSync?: (p: string, enc: string) => string,
 * }} opts
 */
export async function retry({
  prNumber,
  check,
  repoRoot,
  isolated = false,
  run = defaultRunner,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  existsSync,
  readFileSync,
}) {
  const snapshot = classify({ prNumber, repoRoot, run, existsSync });
  const failure = snapshot.failures.find((f) => f.check === check);
  if (!failure) {
    throw new Error(`check "${check}" is not failing on PR #${prNumber}`);
  }
  if (!failure.runId) {
    throw new Error(`check "${check}" has no actions run link`);
  }

  const isolatedRuns = [];
  if (isolated) {
    for (const file of failure.testFiles) {
      isolatedRuns.push(runIsolated({ file, repoRoot, run, existsSync, readFileSync }));
    }
  }

  must(
    run('gh', ['run', 'rerun', failure.runId, '--failed'], { cwd: repoRoot }),
    'gh run rerun',
  );

  let conclusion = null;
  let status = null;
  let waited = 0;
  let timedOut = false;
  for (;;) {
    await sleep(intervalMs);
    waited += intervalMs;
    const view = run(
      'gh',
      ['run', 'view', failure.runId, '--json', 'status,conclusion'],
      { cwd: repoRoot },
    );
    if (ok(view)) {
      const parsed = JSON.parse(view.stdout.trim() || '{}');
      status = parsed.status ?? null;
      conclusion = parsed.conclusion ?? null;
      if (status === 'completed') break;
    }
    if (waited >= maxWaitMs) {
      timedOut = true;
      break;
    }
  }

  return {
    check,
    runId: failure.runId,
    testFiles: failure.testFiles,
    isolated: isolatedRuns,
    status,
    conclusion,
    timedOut,
    passedOnRetry: !timedOut && conclusion === 'success',
  };
}

// ---------------------------------------------------------------------------
// Skip transforms (pure)
// ---------------------------------------------------------------------------

export function skipText(reason, issue) {
  const r = (reason ?? '').trim();
  const i = (issue ?? '').trim();
  return i ? `${r} (${i})` : r;
}

function dartString(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function jsString(text) {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const DART_FILE_SKIP_RE = /^@Skip\((?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\)\s*$/m;
const DART_LIBRARY_RE = /^library(?:\s+[\w.]+)?\s*;\s*$/m;

/**
 * Add a library-level `@Skip('…')` to a Dart test file. Places the
 * annotation before an existing `library` directive, otherwise inserts
 * `@Skip(...)` + `library;` after any leading `//` header comments.
 * Idempotent.
 */
export function addDartFileSkip(source, text) {
  if (DART_FILE_SKIP_RE.test(source)) {
    return { source, changed: false, alreadySkipped: true };
  }
  const annotation = `@Skip(${dartString(text)})`;
  const lines = source.split('\n');
  const libIdx = lines.findIndex((l) => DART_LIBRARY_RE.test(l));
  if (libIdx >= 0) {
    lines.splice(libIdx, 0, annotation);
    return { source: lines.join('\n'), changed: true, alreadySkipped: false };
  }
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === '' || l.trimStart().startsWith('//')) {
      i += 1;
      continue;
    }
    break;
  }
  // Keep one blank line between header comments and the annotation.
  const head = lines.slice(0, i);
  while (head.length > 0 && head[head.length - 1].trim() === '') head.pop();
  const insert = head.length > 0 ? ['', annotation, 'library;', ''] : [annotation, 'library;', ''];
  const tail = lines.slice(i);
  return {
    source: [...head, ...insert, ...tail].join('\n'),
    changed: true,
    alreadySkipped: false,
  };
}

/** Reverse of {@link addDartFileSkip}. */
export function removeDartFileSkip(source) {
  const lines = source.split('\n');
  const idx = lines.findIndex((l) => DART_FILE_SKIP_RE.test(l));
  if (idx < 0) return { source, changed: false };
  let count = 1;
  if (lines[idx + 1]?.trim() === 'library;') count += 1;
  lines.splice(idx, count);
  // Drop a doubled blank line left behind.
  if (
    idx > 0 &&
    lines[idx - 1]?.trim() === '' &&
    lines[idx]?.trim() === ''
  ) {
    lines.splice(idx, 1);
  } else if (idx === 0 && lines[0]?.trim() === '') {
    lines.splice(0, 1);
  }
  return { source: lines.join('\n'), changed: true };
}

/** Index of the `)` that closes the call whose `(` is at `openIdx`. */
function findCallClose(source, openIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  let raw = false;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (!raw && ch === '\\') {
        i += 2;
        continue;
      }
      if (source.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i);
      i = nl < 0 ? source.length : nl;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      raw = source[i - 1] === 'r';
      const triple = source.substr(i, 3);
      quote = triple === "'''" || triple === '"""' ? triple : ch;
      i += quote.length;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

/**
 * Top-level (depth-1) named-argument `skip:` inside a call body.
 * Returns `{ start, end }` covering `skip: <expr>` plus its trailing
 * comma (if any) and the preceding separator when it is the last arg.
 */
function findTopLevelSkipArg(source, openIdx, closeIdx) {
  let depth = 0;
  let i = openIdx;
  let quote = null;
  while (i < closeIdx) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (source.startsWith(quote, i)) {
        i += quote.length;
        quote = null;
        continue;
      }
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const triple = source.substr(i, 3);
      quote = triple === "'''" || triple === '"""' ? triple : ch;
      i += quote.length;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (
      depth === 1 &&
      source.startsWith('skip', i) &&
      /[\s,(]/.test(source[i - 1] ?? ' ')
    ) {
      const m = source.slice(i, i + 32).match(/^skip\s*:/);
      if (m) {
        // Scan the value expression to its top-level end.
        let j = i + m[0].length;
        let d = 0;
        let q = null;
        while (j < closeIdx) {
          const c = source[j];
          if (q) {
            if (c === '\\') {
              j += 2;
              continue;
            }
            if (c === q) q = null;
            j += 1;
            continue;
          }
          if (c === "'" || c === '"' || c === '`') {
            q = c;
            j += 1;
            continue;
          }
          if (c === '(' || c === '[' || c === '{') d += 1;
          if (c === ')' || c === ']' || c === '}') d -= 1;
          if (d === 0 && c === ',') break;
          if (d < 0) break;
          j += 1;
        }
        return { start: i, end: j };
      }
    }
    i += 1;
  }
  return null;
}

/**
 * Locate the single Dart test call matching `testName`.
 *
 * @returns {{ ok: true, callee: string, openIdx: number, closeIdx: number }
 *   | { ok: false, reason: string, matches: number }}
 */
function locateDartCall(source, testName) {
  const re = new RegExp(
    String.raw`\b(test|testWidgets|group|blocTest(?:<[^;()]*?>)?)\(\s*(?:'${escapeRe(testName).replace(/'/g, "\\\\'")}'|"${escapeRe(testName).replace(/"/g, '\\\\"')}")\s*,`,
    'g',
  );
  const hits = [...source.matchAll(re)];
  if (hits.length !== 1) {
    return {
      ok: false,
      matches: hits.length,
      reason:
        hits.length === 0
          ? `no test/testWidgets/group/blocTest call with description "${testName}"`
          : `${hits.length} calls match "${testName}"; description is not unique`,
    };
  }
  const hit = hits[0];
  const openIdx = hit.index + hit[0].indexOf('(');
  const closeIdx = findCallClose(source, openIdx);
  if (closeIdx < 0) {
    return { ok: false, matches: 1, reason: 'unbalanced parentheses' };
  }
  return { ok: true, callee: hit[1], openIdx, closeIdx };
}

function insertNamedArg(source, closeIdx, argText) {
  let k = closeIdx - 1;
  while (k >= 0 && /\s/.test(source[k])) k -= 1;
  if (source[k] === ',') {
    // Trailing-comma style: new line with the indent of the last arg.
    const lineStart = source.lastIndexOf('\n', k) + 1;
    const indent = source.slice(lineStart).match(/^\s*/)[0];
    return `${source.slice(0, k + 1)}\n${indent}${argText},${source.slice(k + 1)}`;
  }
  return `${source.slice(0, k + 1)}, ${argText}${source.slice(k + 1)}`;
}

/**
 * Add `skip: '<text>'` to one Dart `test` / `testWidgets` / `group`
 * call. `blocTest` has no test-skip parameter (`skip:` there is an
 * `int` count of states to drop), so it falls back to a file-level
 * `@Skip`. Non-unique or missing descriptions also fall back to
 * file-level. Idempotent.
 */
export function addDartTestSkip(source, testName, text) {
  const loc = locateDartCall(source, testName);
  if (!loc.ok) {
    const fb = addDartFileSkip(source, text);
    return { ...fb, fallback: `file-level @Skip: ${loc.reason}` };
  }
  if (loc.callee.startsWith('blocTest')) {
    const fb = addDartFileSkip(source, text);
    return {
      ...fb,
      fallback:
        'file-level @Skip: blocTest has no test-skip parameter (skip: is an int state count)',
    };
  }
  if (findTopLevelSkipArg(source, loc.openIdx, loc.closeIdx)) {
    return { source, changed: false, alreadySkipped: true };
  }
  const next = insertNamedArg(source, loc.closeIdx, `skip: ${dartString(text)}`);
  return { source: next, changed: true, alreadySkipped: false };
}

/** Reverse of {@link addDartTestSkip} (also strips a file-level fallback). */
export function removeDartTestSkip(source, testName) {
  const loc = locateDartCall(source, testName);
  if (!loc.ok || loc.callee.startsWith('blocTest')) {
    return removeDartFileSkip(source);
  }
  const arg = findTopLevelSkipArg(source, loc.openIdx, loc.closeIdx);
  if (!arg) return { source, changed: false };
  return { source: removeArgSpan(source, arg), changed: true };
}

/**
 * Remove `skip: <expr>` plus its trailing comma. When the argument sits
 * on its own line the whole line goes; when inline, the preceding `, `
 * separator goes with it.
 */
function removeArgSpan(source, { start, end }) {
  let e = end;
  if (source[e] === ',') e += 1;
  let p = start - 1;
  while (p >= 0 && /[ \t]/.test(source[p])) p -= 1;
  if (source[p] === '\n' || source[p] === ',') {
    return source.slice(0, p) + source.slice(e);
  }
  return source.slice(0, start) + source.slice(e);
}

const NODE_CALL_RE = (name) =>
  new RegExp(
    String.raw`\b(test|it)\(\s*(?:'${escapeRe(name).replace(/'/g, "\\\\'")}'|"${escapeRe(name).replace(/"/g, '\\\\"')}"|\`${escapeRe(name)}\`)\s*,`,
    'g',
  );

/**
 * Add `{ skip: '<text>' }` as the options argument of one `test(` / `it(`
 * call in a `node:test` file. Idempotent; refuses non-unique names.
 */
export function addNodeTestSkip(source, testName, text) {
  const hits = [...source.matchAll(NODE_CALL_RE(testName))];
  if (hits.length !== 1) {
    return {
      source,
      changed: false,
      ok: false,
      reason:
        hits.length === 0
          ? `no test/it call named "${testName}"`
          : `${hits.length} calls match "${testName}"`,
    };
  }
  const hit = hits[0];
  const afterComma = hit.index + hit[0].length;
  const rest = source.slice(afterComma);
  const ws = rest.match(/^\s*/)[0];
  const afterWs = rest.slice(ws.length);
  if (/^\{\s*skip\s*:/.test(afterWs)) {
    return { source, changed: false, alreadySkipped: true, ok: true };
  }
  if (afterWs.startsWith('{')) {
    // Existing options object without skip → add the property.
    const close = findCallClose(source, afterComma + ws.length);
    const inner = source.slice(afterComma + ws.length + 1, close).trim();
    const head = source.slice(0, close).replace(/\s+$/, '');
    const sep = inner.length === 0 ? ' ' : inner.endsWith(',') ? ' ' : ', ';
    const next = `${head}${sep}skip: ${jsString(text)} ${source.slice(close)}`;
    return { source: next, changed: true, alreadySkipped: false, ok: true };
  }
  const next = `${source.slice(0, afterComma)} { skip: ${jsString(text)} },${rest}`;
  return { source: next, changed: true, alreadySkipped: false, ok: true };
}

/** Split on commas that are outside strings and brackets. */
function splitTopLevelCommas(text) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Reverse of {@link addNodeTestSkip}. */
export function removeNodeTestSkip(source, testName) {
  const hits = [...source.matchAll(NODE_CALL_RE(testName))];
  if (hits.length !== 1) return { source, changed: false };
  const hit = hits[0];
  const afterComma = hit.index + hit[0].length;
  const rest = source.slice(afterComma);
  const ws = rest.match(/^\s*/)[0];
  if (rest[ws.length] !== '{') return { source, changed: false };
  const openIdx = afterComma + ws.length;
  const closeIdx = findCallClose(source, openIdx);
  if (closeIdx < 0) return { source, changed: false };
  const props = splitTopLevelCommas(source.slice(openIdx + 1, closeIdx));
  const kept = props.filter((p) => !/^skip\s*:/.test(p));
  if (kept.length === props.length) return { source, changed: false };
  if (kept.length === 0) {
    // Options object held only `skip` → drop the whole argument.
    const after = source.slice(closeIdx + 1).replace(/^\s*,/, '');
    return { source: source.slice(0, afterComma) + after, changed: true };
  }
  const rebuilt = `{ ${kept.join(', ')} }`;
  return {
    source: source.slice(0, openIdx) + rebuilt + source.slice(closeIdx + 1),
    changed: true,
  };
}

/** Route by extension. Returns `{ source, changed, ... }`. */
export function applyQuarantine(source, { file, test, text }) {
  if (file.endsWith('.dart')) {
    return test ? addDartTestSkip(source, test, text) : addDartFileSkip(source, text);
  }
  if (/\.(?:mjs|cjs|js|ts|mts)$/.test(file)) {
    if (!test) {
      return { source, changed: false, ok: false, reason: 'Node files need --test' };
    }
    return addNodeTestSkip(source, test, text);
  }
  return { source, changed: false, ok: false, reason: `unsupported file type: ${file}` };
}

export function applyUnquarantine(source, { file, test }) {
  if (file.endsWith('.dart')) {
    return test ? removeDartTestSkip(source, test) : removeDartFileSkip(source);
  }
  if (/\.(?:mjs|cjs|js|ts|mts)$/.test(file)) {
    if (!test) return { source, changed: false, ok: false, reason: 'Node files need --test' };
    return removeNodeTestSkip(source, test);
  }
  return { source, changed: false, ok: false, reason: `unsupported file type: ${file}` };
}

/** Minimal unified-style diff (common prefix/suffix, changed middle). */
export function simpleDiff(before, after, file) {
  if (before === after) return '';
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  const out = [`--- a/${file}`, `+++ b/${file}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`];
  for (const l of a.slice(start, endA)) out.push(`-${l}`);
  for (const l of b.slice(start, endB)) out.push(`+${l}`);
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function ledgerPath(opts) {
  return path.join(stateDir('quarantine', opts), 'ledger.jsonl');
}

export function appendLedger(entry, opts) {
  const file = ledgerPath(opts);
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return file;
}

export function readLedger(opts) {
  const file = ledgerPath(opts);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

export function formatLedgerTable(entries) {
  if (entries.length === 0) return 'ledger empty';
  const cols = ['ts', 'action', 'repo', 'file', 'test', 'issue', 'pr'];
  const rows = entries.map((e) => cols.map((c) => String(e[c] ?? '')));
  const widths = cols.map((c, i) => Math.max(c.length, ...rows.map((r) => r[i].length)));
  const line = (cells) => cells.map((v, i) => v.padEnd(widths[i])).join('  ');
  return [line(cols), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

/** Quarantines still active for `pr` (quarantine minus later unquarantine). */
export function activeQuarantinesForPr(entries, pr) {
  const active = new Map();
  for (const e of entries) {
    if (String(e.pr ?? '') !== String(pr)) continue;
    const key = `${e.file}::${e.test ?? ''}`;
    if (e.action === 'quarantine') active.set(key, e);
    if (e.action === 'unquarantine') active.delete(key);
  }
  return [...active.values()];
}

// ---------------------------------------------------------------------------
// Issue
// ---------------------------------------------------------------------------

/**
 * @param {{
 *   pr: { number: number, url: string },
 *   failure: { check: string, runId: string|null, jobName: string,
 *     link?: string|null, attributable: boolean, reason: string,
 *     excerpt: string[] },
 *   testFile: string, test?: string|null, repoSlug: string,
 * }} input
 */
export function buildIssueBody({ pr, failure, testFile, test, repoSlug: slug }) {
  const runUrl =
    failure.link ??
    (failure.runId ? `https://github.com/${slug}/actions/runs/${failure.runId}` : 'n/a');
  const excerpt = (failure.excerpt ?? []).slice(0, EXCERPT_MAX_LINES);
  const testArg = test ? ` --test ${shellQuote(test)}` : '';
  return [
    `## Flaky test quarantined`,
    '',
    `| Field | Value |`,
    `| --- | --- |`,
    `| Test file | \`${testFile}\` |`,
    `| Test | ${test ? `\`${test}\`` : '(whole file)'} |`,
    `| Check | \`${failure.check}\` |`,
    `| Job | \`${failure.jobName}\` |`,
    `| Run | ${runUrl} |`,
    `| PR | ${pr.url ?? `#${pr.number}`} |`,
    `| Attributable to PR diff | ${failure.attributable ? 'yes' : 'no'} — ${failure.reason} |`,
    '',
    `### Failing assertion (excerpt)`,
    '',
    '```text',
    ...(excerpt.length > 0 ? excerpt : ['(no failure excerpt captured)']),
    '```',
    '',
    `### How to unquarantine`,
    '',
    'Fix the root cause, then remove the skip and close this issue:',
    '',
    '```bash',
    `node "$ST_PLUGIN_ROOT/scripts/hooks/flake-quarantine.mjs" unquarantine --file ${shellQuote(testFile)}${testArg}`,
    '```',
    '',
    `Opened by \`st-flake-quarantine\` from PR #${pr.number}.`,
  ].join('\n');
}

function shellQuote(s) {
  return /^[\w./@:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function issueTitle(testFile, test) {
  return `flaky: ${test ?? testFile}`;
}

/**
 * @param {{ prNumber: number, check: string, testFile: string,
 *   test?: string|null, repoRoot: string, dryRun?: boolean,
 *   run?: Runner, env?: NodeJS.ProcessEnv }} opts
 */
export function createIssue({
  prNumber,
  check,
  testFile,
  test = null,
  repoRoot,
  dryRun = false,
  run = defaultRunner,
  env = process.env,
}) {
  const snapshot = classify({ prNumber, repoRoot, run });
  const failure = snapshot.failures.find((f) => f.check === check);
  if (!failure) {
    throw new Error(`check "${check}" is not failing on PR #${prNumber}`);
  }
  const slug = repoSlug(run, repoRoot, env);
  const body = buildIssueBody({ pr: snapshot.pr, failure, testFile, test, repoSlug: slug });
  const title = issueTitle(testFile, test);
  if (dryRun) {
    return { dryRun: true, title, body, url: null };
  }
  run(
    'gh',
    ['label', 'create', FLAKY_LABEL, '--color', FLAKY_LABEL_COLOR, '--force'],
    { cwd: repoRoot },
  );
  const created = must(
    run(
      'gh',
      ['issue', 'create', '--title', title, '--label', FLAKY_LABEL, '--body', body],
      { cwd: repoRoot },
    ),
    'gh issue create',
  );
  const url = created.trim().split(/\r?\n/).pop();
  return { dryRun: false, title, body, url };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseCliArgs(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next != null && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function resolvePr(flags, argv) {
  if (flags.pr != null) return Number(flags.pr);
  return parsePrArgs(argv).prNumber;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const run = deps.run ?? defaultRunner;
  const out = deps.stdout ?? ((s) => process.stdout.write(s));
  const err = deps.stderr ?? ((s) => process.stderr.write(s));
  const repoRoot = deps.repoRoot ?? getRepoRoot();
  const env = deps.env ?? process.env;
  const { command, flags } = parseCliArgs(argv);

  switch (command) {
    case 'classify': {
      const prNumber = resolvePr(flags, argv);
      const result = classify({ prNumber, repoRoot, run });
      if (flags.json) {
        out(`${JSON.stringify(result, null, 2)}\n`);
      } else if (result.failures.length === 0) {
        out(`PR #${prNumber}: no failing PR Checks\n`);
      } else {
        for (const f of result.failures) {
          out(
            `${f.attributable ? 'REAL ' : 'MAYBE-FLAKY'}  ${f.check}  run=${f.runId ?? '-'}  job=${f.jobName}\n` +
              `  files: ${f.testFiles.join(', ') || '-'}\n` +
              `  tests: ${f.testNames.join(' | ') || '-'}\n` +
              `  reason: ${f.reason}\n` +
              (f.protected.length ? `  PROTECTED: ${f.protected.join(', ')}\n` : ''),
          );
        }
      }
      return 0;
    }
    case 'retry': {
      const prNumber = resolvePr(flags, argv);
      if (!flags.check) throw new Error('retry needs --check <name>');
      const result = await retry({
        prNumber,
        check: String(flags.check),
        repoRoot,
        isolated: Boolean(flags.isolated),
        run,
        intervalMs: flags.interval ? Number(flags.interval) * 1000 : undefined,
        maxWaitMs: flags['max-wait'] ? Number(flags['max-wait']) * 60_000 : undefined,
      });
      out(`${JSON.stringify(result, null, 2)}\n`);
      return result.passedOnRetry ? 0 : 1;
    }
    case 'quarantine':
    case 'unquarantine': {
      if (!flags.file) throw new Error(`${command} needs --file <path>`);
      const file = String(flags.file);
      const abs = path.isAbsolute(file) ? file : path.join(repoRoot, file);
      const rel = path.relative(repoRoot, abs).replace(/\\/g, '/');
      const before = fs.readFileSync(abs, 'utf8');
      const test = flags.test ? String(flags.test) : null;
      let result;
      if (command === 'quarantine') {
        if (!flags.reason) throw new Error('quarantine needs --reason "<text>"');
        if (!flags.issue) throw new Error('quarantine needs --issue <url>');
        const hits = protectedMatches(rel, test);
        if (hits.length > 0 && !flags.force) {
          throw new Error(`refusing to quarantine protected test (${hits.join(', ')}); fix it instead`);
        }
        result = applyQuarantine(before, {
          file: rel,
          test,
          text: skipText(String(flags.reason), String(flags.issue)),
        });
      } else {
        result = applyUnquarantine(before, { file: rel, test });
      }
      if (result.ok === false) throw new Error(result.reason);
      if (result.fallback) err(`note: ${result.fallback}\n`);
      if (!result.changed) {
        out(result.alreadySkipped ? 'already quarantined; no change\n' : 'no skip found; no change\n');
        return 0;
      }
      fs.writeFileSync(abs, result.source);
      out(`${simpleDiff(before, result.source, rel)}\n`);
      const ledgerFile = appendLedger(
        {
          ts: new Date().toISOString(),
          action: command,
          repo: repoSlug(run, repoRoot, env),
          file: rel,
          test,
          issue: flags.issue ? String(flags.issue) : null,
          pr: flags.pr != null ? Number(flags.pr) : null,
          reason: flags.reason ? String(flags.reason) : null,
          fallback: result.fallback ?? null,
        },
        { env },
      );
      err(`ledger: ${ledgerFile}\n`);
      return 0;
    }
    case 'issue': {
      const prNumber = resolvePr(flags, argv);
      if (!flags.check) throw new Error('issue needs --check <name>');
      if (!flags['test-file']) throw new Error('issue needs --test-file <path>');
      const result = createIssue({
        prNumber,
        check: String(flags.check),
        testFile: String(flags['test-file']),
        test: flags.test ? String(flags.test) : null,
        repoRoot,
        dryRun: Boolean(flags['dry-run']),
        run,
        env,
      });
      if (result.dryRun) {
        out(`# ${result.title}\n\n${result.body}\n`);
      } else {
        out(`${result.url}\n`);
      }
      return 0;
    }
    case 'ledger': {
      const entries = readLedger({ env });
      out(flags.json ? `${JSON.stringify(entries, null, 2)}\n` : `${formatLedgerTable(entries)}\n`);
      return 0;
    }
    default:
      err(
        'usage: flake-quarantine.mjs <classify|retry|quarantine|unquarantine|issue|ledger> [flags]\n',
      );
      return 2;
  }
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`${e?.message ?? e}\n`);
      process.exit(1);
    },
  );
}

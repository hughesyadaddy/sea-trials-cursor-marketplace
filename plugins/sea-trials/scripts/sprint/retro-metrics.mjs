#!/usr/bin/env node
/**
 * Sprint retro metrics from the shared telemetry JSONL plus git facts.
 *
 *   node retro-metrics.mjs --sprint <dir or name> [--since <date>]
 *     [--until <date>] [--repo <name>] [--repo-root <dir>] [--base <ref>]
 *     [--telemetry <path>] [--story <KEY>]... [--json|--md]
 *   node retro-metrics.mjs --sprint <dir> --story-comment <KEY>
 *   node retro-metrics.mjs --check-voice <file.md>
 *
 * Telemetry: `~/.cache/sea-trials/telemetry/gate-runs.jsonl` (root via
 * `ST_STATE_DIR`), one object per line:
 *   { ts, kind: 'gate'|'shard'|'review-loop', task, phase?, model?, host,
 *     ms, ok, cacheHit?, repo, pr?, exitCode? }
 *
 * `repo` is usually the checkout basename; `--repo owner/name`, a path,
 * or the bare name all match it. `cacheHit` is present only on hits.
 *
 * `--md` prints Confluence-friendly markdown (H2 Summary, Delivery, Build
 * tooling, Review loop, Follow-ups; tables only). `--json` prints the
 * report object. `--story-comment KEY` prints a short plain paragraph for
 * a Jira comment. `--check-voice` lists banned phrasing (sprint contract
 * section 5) found in a file and exits 1 when there is any.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { telemetryPath } from '../lib/st-state-dir.mjs';

// ===========================================================================
// CONSTANTS
// ===========================================================================

export const SLOWEST_COUNT = 5;
export const DEFAULT_BASE = 'origin/dev';
const KEY_RE = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const PR_NUMBER_RE = /\(#(\d+)\)/g;
const STORY_FILE_RE = /^(\d+)-us(\w+)-.*\.md$/i;
const RS = '\u001e';
const US = '\u001f';

/**
 * Sprint contract section 5, both groups. Matched on word boundaries,
 * case-insensitive except the all-caps tells.
 */
export const FORBIDDEN_TERMS = [
  // Lint errors
  'maybe',
  'consider',
  'might want to',
  'explore whether',
  'investigate if',
  'TBD',
  'TODO:',
  'look into',
  'Claude',
  'Cursor',
  'ChatGPT',
  'Copilot',
  'As an AI',
  'LLM',
  'subagent',
  'Task(',
  // Contract bans
  'research',
  'spike',
  'explore',
  'investigate',
  'evaluate options',
  'as needed',
  'if possible',
  'where appropriate',
  'etc.',
  'and so on',
  'works correctly',
  'looks good',
  'user-friendly',
  'handle edge cases',
  'see subtask',
  'see story',
  'per the overview',
  'Phase 0',
  'gate',
  'checkpoint',
  'rollback plan',
  'AI',
  'agent',
  'generated',
  'assistant',
  'prompt',
  'model output',
];
const CASE_SENSITIVE = new Set(['TBD', 'AI', 'LLM', 'Claude', 'Cursor']);
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const PLACEHOLDER_RE = /\{\{[^}]*\}\}|<[A-Za-z][A-Za-z0-9 _-]*>/g;

// ===========================================================================
// INJECTABLES
// ===========================================================================

let gitRunner = (args, cwd) => {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { status: res.status ?? 1, stdout: res.stdout ?? '' };
};

/** Replace the git runner (tests). Returns the previous one. */
export function setGitRunner(fn) {
  const prev = gitRunner;
  gitRunner = fn;
  return prev;
}

// ===========================================================================
// ARGS
// ===========================================================================

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = {
    sprint: null,
    since: null,
    until: null,
    repo: null,
    repoRoot: null,
    base: DEFAULT_BASE,
    telemetry: null,
    stories: [],
    format: 'json',
    storyComment: null,
    checkVoice: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sprint') out.sprint = argv[++i];
    else if (arg === '--since') out.since = argv[++i];
    else if (arg === '--until') out.until = argv[++i];
    else if (arg === '--repo') out.repo = argv[++i];
    else if (arg === '--repo-root') out.repoRoot = path.resolve(argv[++i]);
    else if (arg === '--base') out.base = argv[++i];
    else if (arg === '--telemetry') out.telemetry = argv[++i];
    else if (arg === '--story') out.stories.push(argv[++i]);
    else if (arg === '--json') out.format = 'json';
    else if (arg === '--md') out.format = 'md';
    else if (arg === '--story-comment') out.storyComment = argv[++i];
    else if (arg === '--check-voice') out.checkVoice = argv[++i];
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!out.sprint && !out.checkVoice) {
    throw new Error('--sprint is required');
  }
  return out;
}

// ===========================================================================
// VOICE CHECK
// ===========================================================================

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Banned phrasing found in `text`, with the 1-based line number.
 *
 * @param {string} text
 * @returns {Array<{ term: string, line: number }>}
 */
export function findForbidden(text) {
  const hits = [];
  const lines = String(text ?? '').split('\n');
  const patterns = FORBIDDEN_TERMS.map((term) => {
    const body = escapeRe(term);
    const leading = /^\w/.test(term) ? '\\b' : '';
    const trailing = /\w$/.test(term) ? '\\b' : '';
    const flags = CASE_SENSITIVE.has(term) ? '' : 'i';
    return { term, re: new RegExp(`${leading}${body}${trailing}`, flags) };
  });
  lines.forEach((line, i) => {
    for (const { term, re } of patterns) {
      if (re.test(line)) hits.push({ term, line: i + 1 });
    }
    if (EMOJI_RE.test(line)) hits.push({ term: 'emoji', line: i + 1 });
    if (PLACEHOLDER_RE.test(line)) {
      hits.push({ term: 'placeholder', line: i + 1 });
    }
    PLACEHOLDER_RE.lastIndex = 0;
  });
  return hits;
}

// ===========================================================================
// TELEMETRY
// ===========================================================================

/** Epoch ms from an ISO string or a number; NaN when unparseable. */
export function toEpoch(value) {
  if (value == null || value === '') return Number.NaN;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const n = Number(value);
  if (Number.isFinite(n)) return toEpoch(n);
  return Date.parse(String(value));
}

/**
 * Read the JSONL, skipping blank and malformed lines.
 *
 * @param {string} file
 * @returns {object[]}
 */
export function readTelemetry(file) {
  if (!file || !fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const rec = JSON.parse(t);
      if (rec && typeof rec === 'object') out.push(rec);
    } catch {
      // malformed line; ignore
    }
  }
  return out;
}

/**
 * Keep records inside [since, until] and matching `repo` (equal, or the
 * record's repo ends with the given name).
 *
 * @param {object[]} records
 * @param {{ since?: string|null, until?: string|null, repo?: string|null }} f
 */
export function filterRecords(records, f = {}) {
  const since = f.since ? toEpoch(f.since) : Number.NEGATIVE_INFINITY;
  const until = f.until ? endOfDay(f.until) : Number.POSITIVE_INFINITY;
  const repo = f.repo ? String(f.repo).replace(/\/+$/, '') : null;
  return records.filter((r) => {
    const ts = toEpoch(r.ts);
    if (Number.isFinite(ts) && (ts < since || ts > until)) return false;
    if (!Number.isFinite(ts) && (f.since || f.until)) return false;
    if (repo && !repoMatches(String(r.repo ?? ''), repo)) return false;
    return true;
  });
}

/**
 * `owner/name`, an absolute checkout path, or a bare name all refer to
 * the same repo when their last path segment agrees.
 */
export function repoMatches(own, want) {
  const a = own.replace(/\/+$/, '');
  const b = want.replace(/\/+$/, '');
  if (!a) return false;
  if (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return path.basename(a).toLowerCase() === path.basename(b).toLowerCase();
}

function endOfDay(value) {
  const ts = toEpoch(value);
  if (!Number.isFinite(ts)) return Number.POSITIVE_INFINITY;
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? ts + 86_399_999 : ts;
}

/** p in [0,100] over an unsorted numeric array (nearest-rank). */
export function percentile(values, p) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const rank = Math.ceil((p / 100) * nums.length);
  return nums[Math.min(nums.length, Math.max(1, rank)) - 1];
}

/** Median (average of the two middle values on even counts). */
export function median(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function rate(part, whole) {
  return whole ? Math.round((part / whole) * 1000) / 10 : null;
}

/**
 * Aggregate telemetry records into the retro metrics object.
 *
 * @param {object[]} records already filtered
 */
export function computeMetrics(records) {
  const ms = (r) => Number(r.ms);
  const shards = records.filter((r) => r.kind === 'shard');
  const gates = records.filter((r) => r.kind === 'gate');
  const loops = records.filter((r) => r.kind === 'review-loop');

  // The ledger writes `cacheHit` only on hits, so every gate run counts
  // as a sample and a missing flag is a miss.
  const cacheHits = gates.filter((r) => r.cacheHit === true).length;

  const perPr = new Map();
  for (const r of loops) {
    const pr = r.pr == null ? 'unknown' : String(r.pr);
    const e = perPr.get(pr) ?? { pr, iterations: 0, failed: 0, ms: 0 };
    e.iterations += 1;
    if (r.ok === false) e.failed += 1;
    e.ms += Number.isFinite(ms(r)) ? ms(r) : 0;
    perPr.set(pr, e);
  }

  const byModel = new Map();
  for (const r of records) {
    const model = r.model ? String(r.model) : 'unspecified';
    const e = byModel.get(model) ?? { model, runs: 0, failed: 0 };
    e.runs += 1;
    if (r.ok === false) e.failed += 1;
    byModel.set(model, e);
  }

  const slowest = records
    .filter((r) => Number.isFinite(ms(r)))
    .sort((a, b) => ms(b) - ms(a))
    .slice(0, SLOWEST_COUNT)
    .map((r) => ({
      task: String(r.task ?? ''),
      kind: r.kind ?? null,
      phase: r.phase ?? null,
      model: r.model ?? null,
      pr: r.pr ?? null,
      ms: ms(r),
      ok: r.ok !== false,
    }));

  const gateMs = gates.map(ms);
  return {
    records: records.length,
    shards: {
      run: shards.length,
      succeeded: shards.filter((r) => r.ok !== false).length,
    },
    gate: {
      runs: gates.length,
      failed: gates.filter((r) => r.ok === false).length,
      totalMinutes:
        Math.round(
          (gateMs.filter(Number.isFinite).reduce((a, b) => a + b, 0) / 60000) *
            10,
        ) / 10,
      medianMs: median(gateMs),
      p95Ms: percentile(gateMs, 95),
      cacheHitRate: rate(cacheHits, gates.length),
      cacheHitSamples: gates.length,
    },
    reviewLoop: {
      prs: perPr.size,
      totalIterations: loops.length,
      perPr: [...perPr.values()].sort((a, b) => b.iterations - a.iterations),
    },
    byModel: [...byModel.values()]
      .map((e) => ({ ...e, failRate: rate(e.failed, e.runs) }))
      .sort((a, b) => b.runs - a.runs),
    slowest,
  };
}

// ===========================================================================
// SPRINT FOLDER
// ===========================================================================

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function firstH1(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const m = /^#\s+(.+?)\s*$/m.exec(text);
    return m ? m[1].trim() : path.basename(file, '.md');
  } catch {
    return path.basename(file, '.md');
  }
}

/**
 * Resolve `--sprint` to a folder (when one exists) and read its stories.
 *
 * @param {string} spec directory or sprint name
 * @param {{ cwd?: string, repoRoot?: string|null }} [o]
 * @returns {{ name: string, dir: string|null, config: object,
 *   stories: Array<{ id: string, key: string|null, title: string,
 *   file: string|null }> }}
 */
export function resolveSprint(spec, o = {}) {
  const cwd = o.cwd ?? process.cwd();
  const candidates = [
    path.resolve(cwd, spec),
    path.join(cwd, 'sprint_planning', spec),
    ...(o.repoRoot ? [path.join(o.repoRoot, 'sprint_planning', spec)] : []),
  ];
  const dir = candidates.find(
    (d) => fs.existsSync(d) && fs.statSync(d).isDirectory(),
  );
  if (!dir) return { name: spec, dir: null, config: {}, stories: [] };

  const config = readJson(path.join(dir, 'sprint.json')) ?? {};
  const state = readJson(path.join(dir, 'jira_state.json')) ?? {};
  const stories = [];
  for (const entry of fs.readdirSync(dir).sort()) {
    const m = STORY_FILE_RE.exec(entry);
    if (!m) continue;
    const id = m[2];
    stories.push({
      id,
      key: state.stories?.[id]?.key ?? null,
      title: firstH1(path.join(dir, entry)),
      file: path.join(dir, entry),
    });
  }
  return { name: path.basename(dir), dir, config, stories };
}

// ===========================================================================
// GIT FACTS
// ===========================================================================

function gitOk(args, cwd) {
  const res = gitRunner(args, cwd);
  return res && res.status === 0 ? res.stdout : null;
}

/**
 * Parse `git log --format=<RS>%H<US>%aI<US>%s --name-only` output.
 *
 * @returns {Array<{ sha: string, date: string, subject: string,
 *   files: string[] }>}
 */
export function parseGitLog(text) {
  const out = [];
  for (const block of String(text ?? '').split(RS)) {
    if (!block.trim()) continue;
    const [head, ...rest] = block.split('\n');
    const [sha, date, subject] = head.split(US);
    if (!sha) continue;
    out.push({
      sha: sha.trim(),
      date: (date ?? '').trim(),
      subject: (subject ?? '').trim(),
      files: rest.map((l) => l.trim()).filter(Boolean),
    });
  }
  return out;
}

function logArgs(extra, w) {
  const args = ['log', `--format=${RS}%H${US}%aI${US}%s`, '--name-only'];
  if (w.since) args.push(`--since=${w.since}`);
  if (w.until) args.push(`--until=${w.until}`);
  return [...args, ...extra];
}

function topDirectory(files) {
  const counts = new Map();
  for (const f of files) {
    const parts = f.split('/');
    const dir = parts.length > 2 ? parts.slice(0, 2).join('/') : parts[0];
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  let best = null;
  for (const [dir, n] of counts) if (!best || n > best.n) best = { dir, n };
  return best?.dir ?? null;
}

/**
 * Commits, files, dates, PR numbers and branches for one story key.
 *
 * @param {string} key
 * @param {{ repoRoot: string, since?: string|null, until?: string|null,
 *   base?: string, branches?: string[] }} o
 */
export function storyGitFacts(key, o) {
  const w = { since: o.since, until: o.until };
  const cwd = o.repoRoot;
  const commits = new Map();
  const add = (c) => {
    if (!commits.has(c.sha)) commits.set(c.sha, c);
  };
  const grepArgs = ['--all', '-E', '-i', `--grep=${key}\\b`];
  parseGitLog(gitOk(logArgs(grepArgs, w), cwd)).forEach(add);

  const branches = (o.branches ?? []).filter((b) =>
    b.toUpperCase().includes(key.toUpperCase()),
  );
  for (const branch of branches) {
    const withBase = o.base
      ? gitOk(logArgs([branch, '--not', o.base], w), cwd)
      : null;
    const text =
      withBase ?? gitOk(logArgs([branch, '--max-count=200'], w), cwd);
    parseGitLog(text).forEach(add);
  }

  const list = [...commits.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const files = new Set();
  const prs = new Set();
  for (const c of list) {
    c.files.forEach((f) => files.add(f));
    for (const m of c.subject.matchAll(PR_NUMBER_RE)) prs.add(Number(m[1]));
  }
  return {
    key,
    commits: list.length,
    filesChanged: files.size,
    topDirectory: topDirectory([...files]),
    firstCommit: list[0]?.date ?? null,
    lastCommit: list[list.length - 1]?.date ?? null,
    prs: [...prs].sort((a, b) => a - b),
    branches,
    subjects: list.map((c) => c.subject),
  };
}

/** Local and remote branch names, or [] when git is unavailable. */
export function listBranches(repoRoot) {
  const text = gitOk(
    ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    repoRoot,
  );
  return String(text ?? '')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith('/HEAD'));
}

// ===========================================================================
// REPORT
// ===========================================================================

/**
 * Build the whole report.
 *
 * @param {ReturnType<typeof parseArgs>} args
 * @param {{ cwd?: string }} [o]
 */
export function buildReport(args, o = {}) {
  const sprint = resolveSprint(args.sprint, {
    cwd: o.cwd,
    repoRoot: args.repoRoot,
  });
  const since = args.since ?? sprint.config.startDate ?? null;
  const until = args.until ?? sprint.config.endDate ?? null;
  const repo = args.repo ?? sprint.config.repo ?? null;
  const file = args.telemetry ?? telemetryPath();
  const records = filterRecords(readTelemetry(file), { since, until, repo });
  const metrics = computeMetrics(records);

  const keys = new Set(args.stories);
  for (const s of sprint.stories) if (s.key) keys.add(s.key);
  const byKey = Object.fromEntries(
    sprint.stories.filter((s) => s.key).map((s) => [s.key, s]),
  );
  let stories = [];
  if (args.repoRoot) {
    const branches = listBranches(args.repoRoot);
    stories = [...keys].map((key) => ({
      ...storyGitFacts(key, {
        repoRoot: args.repoRoot,
        since,
        until,
        base: args.base,
        branches,
      }),
      id: byKey[key]?.id ?? null,
      title: byKey[key]?.title ?? null,
    }));
  } else {
    stories = [...keys].map((key) => ({
      key,
      id: byKey[key]?.id ?? null,
      title: byKey[key]?.title ?? null,
      commits: null,
      filesChanged: null,
      prs: [],
      branches: [],
      firstCommit: null,
      lastCommit: null,
    }));
  }

  return {
    sprint: sprint.name,
    sprintDir: sprint.dir,
    window: { since, until },
    repo,
    telemetryFile: file,
    metrics,
    stories,
    followUps: followUps(metrics),
  };
}

/** Rows a person should look at; the writer decides what to keep. */
export function followUps(m) {
  const rows = [];
  for (const p of m.reviewLoop.perPr) {
    if (p.iterations >= 4) {
      rows.push({
        item: `PR #${p.pr} needed ${p.iterations} review rounds`,
        source: 'Review loop',
      });
    }
  }
  for (const e of m.byModel) {
    if (e.runs >= 4 && e.failRate >= 25) {
      rows.push({
        item: `${e.model} failed ${e.failRate}% of ${e.runs} runs`,
        source: 'Build tooling',
      });
    }
  }
  for (const t of m.slowest) {
    if (t.ms >= 10 * 60000) {
      rows.push({
        item: `${t.task} took ${fmtMinutes(t.ms)} min`,
        source: 'Build tooling',
      });
    }
  }
  return rows;
}

// ===========================================================================
// RENDERING
// ===========================================================================

function fmtMinutes(ms) {
  return ms == null ? '-' : String(Math.round((ms / 60000) * 10) / 10);
}

function fmtSeconds(ms) {
  return ms == null ? '-' : String(Math.round(ms / 100) / 10);
}

function fmtDate(iso) {
  return iso ? String(iso).slice(0, 10) : '-';
}

function fmtPct(v) {
  return v == null ? '-' : `${v}%`;
}

function cell(v) {
  return String(v ?? '-').replace(/\|/g, '\\|');
}

const KIND_LABELS = {
  gate: 'push check',
  shard: 'shard',
  'review-loop': 'review round',
};

function kindLabel(kind) {
  return KIND_LABELS[kind] ?? kind ?? '-';
}

function table(headers, rows) {
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
  ];
  if (!rows.length) {
    const empty = headers.map((_, i) => (i === 0 ? 'none' : ''));
    lines.push(`| ${empty.join(' | ')} |`);
  }
  for (const r of rows) lines.push(`| ${r.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

function prLink(repo, n) {
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo)
    ? `[#${n}](https://github.com/${repo}/pull/${n})`
    : `#${n}`;
}

/**
 * Confluence-friendly markdown: five H2 sections, tables only.
 *
 * @param {ReturnType<typeof buildReport>} r
 */
export function renderMarkdown(r) {
  const m = r.metrics;
  const totalCommits = r.stories.reduce((a, s) => a + (s.commits ?? 0), 0);
  const hasGit = r.stories.some((s) => s.commits != null);
  const prCount = new Set(r.stories.flatMap((s) => s.prs ?? [])).size;
  const sections = [];

  sections.push(
    '## Summary',
    '',
    table(
      ['Item', 'Value'],
      [
        ['Sprint', r.sprint],
        ['Window', `${fmtDate(r.window.since)} to ${fmtDate(r.window.until)}`],
        ['Stories', r.stories.length],
        ['Commits', hasGit ? totalCommits : '-'],
        ['Pull requests', prCount],
        ['Push checks run', m.gate.runs],
        ['Push check minutes', m.gate.totalMinutes],
        ['Review rounds', m.reviewLoop.totalIterations],
      ],
    ),
  );

  sections.push(
    '',
    '## Delivery',
    '',
    table(
      ['Story', 'Key', 'Title', 'Commits', 'Files', 'PRs', 'First', 'Last'],
      r.stories.map((s) => [
        s.id ? `US${s.id}` : '-',
        s.key,
        s.title,
        s.commits,
        s.filesChanged,
        (s.prs ?? []).map((n) => prLink(r.repo, n)).join(', ') || '-',
        fmtDate(s.firstCommit),
        fmtDate(s.lastCommit),
      ]),
    ),
  );

  sections.push(
    '',
    '## Build tooling',
    '',
    table(
      ['Metric', 'Value'],
      [
        ['Shards run', m.shards.run],
        ['Shards succeeded', m.shards.succeeded],
        ['Push checks run', m.gate.runs],
        ['Push checks failed', m.gate.failed],
        ['Median push check task (s)', fmtSeconds(m.gate.medianMs)],
        ['p95 push check task (s)', fmtSeconds(m.gate.p95Ms)],
        [
          'Cache hit rate',
          m.gate.cacheHitSamples
            ? `${fmtPct(m.gate.cacheHitRate)} of ${m.gate.cacheHitSamples}`
            : '-',
        ],
      ],
    ),
    '',
    table(
      ['Runner', 'Runs', 'Failed', 'Fail rate'],
      m.byModel.map((e) => [e.model, e.runs, e.failed, fmtPct(e.failRate)]),
    ),
    '',
    table(
      ['Slowest task', 'Kind', 'Runner', 'PR', 'Minutes', 'Result'],
      m.slowest.map((t) => [
        t.task,
        kindLabel(t.kind),
        t.model,
        t.pr,
        fmtMinutes(t.ms),
        t.ok ? 'pass' : 'fail',
      ]),
    ),
  );

  sections.push(
    '',
    '## Review loop',
    '',
    table(
      ['PR', 'Rounds', 'Failed rounds', 'Minutes'],
      m.reviewLoop.perPr.map((p) => [
        /^\d+$/.test(p.pr) ? prLink(r.repo, p.pr) : p.pr,
        p.iterations,
        p.failed,
        fmtMinutes(p.ms),
      ]),
    ),
  );

  sections.push(
    '',
    '## Follow-ups',
    '',
    table(
      ['Item', 'Source', 'Owner'],
      r.followUps.map((f) => [f.item, f.source, 'open']),
    ),
    '',
  );
  return sections.join('\n');
}

function wrap(text, width = 78) {
  const words = text.split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && `${cur} ${w}`.length > width) {
      lines.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Plain paragraph for a Jira comment on one story: what shipped, PR
 * link(s), anything notable. At most six lines, no bullets, no labels.
 *
 * @param {ReturnType<typeof buildReport>} r
 * @param {string} key
 */
export function storyComment(r, key) {
  const s = r.stories.find((x) => x.key === key);
  if (!s) {
    throw new Error(
      `${key} is not in this sprint; pass --story ${key} or add it to ` +
        'jira_state.json',
    );
  }
  const what = s.title ? s.title.replace(/^User Story \w+:\s*/i, '') : key;
  const prs = (s.prs ?? []).map((n) =>
    r.repo && /^[\w.-]+\/[\w.-]+$/.test(r.repo)
      ? `#${n} (https://github.com/${r.repo}/pull/${n})`
      : `#${n}`,
  );
  const sentences = [];
  if (s.commits == null) {
    sentences.push(
      `Closing out ${what}. I did not have the repo at hand for commit ` +
        'counts, so this is from the board only.',
    );
  } else if (s.commits === 0) {
    sentences.push(
      `Closing out ${what}. No commits in the sprint window mention ` +
        `${key}, so the work landed under another name or before the window.`,
    );
  } else {
    const shipped = prs.length
      ? `${what} shipped in ${prs.join(' and ')}.`
      : s.branches.length
        ? `${what} went out on ${s.branches[0]}; I did not find a PR number ` +
          'in the commit messages.'
        : `${what} is in.`;
    sentences.push(shipped);
    const first = fmtDate(s.firstCommit);
    const last = fmtDate(s.lastCommit);
    let span = '';
    if (s.firstCommit && s.lastCommit && first !== last) {
      span = ` between ${first} and ${last}`;
    } else if (s.firstCommit) {
      span = ` on ${first}`;
    }
    const where = s.topDirectory
      ? `, most of them under ${s.topDirectory}`
      : '';
    sentences.push(
      `${s.commits} commit${s.commits === 1 ? '' : 's'}${span} touched ` +
        `${s.filesChanged} file${s.filesChanged === 1 ? '' : 's'}${where}.`,
    );
  }
  const loops = r.metrics.reviewLoop.perPr.filter((p) =>
    (s.prs ?? []).map(String).includes(String(p.pr)),
  );
  const rounds = loops.reduce((a, p) => a + p.iterations, 0);
  if (rounds > 1) {
    const across = loops.length > 1 ? ' across the PRs' : '';
    sentences.push(`Review took ${rounds} rounds${across}.`);
  } else if (rounds === 1) {
    sentences.push('Review closed in one round.');
  }
  const lines = wrap(sentences.join(' '));
  return lines.slice(0, 6).join('\n');
}

// ===========================================================================
// CLI
// ===========================================================================

const USAGE = `\
usage: retro-metrics.mjs --sprint <dir|name> [--since <date>] [--until <date>]
  [--repo owner/name] [--repo-root <dir>] [--base <ref>] [--telemetry <file>]
  [--story <KEY>]... [--json|--md] [--story-comment <KEY>]
       retro-metrics.mjs --check-voice <file>
`;

/**
 * @param {string[]} argv
 * @param {{ stdout?: Function, stderr?: Function, cwd?: string }} [io]
 */
export function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s));
  const err = io.stderr ?? ((s) => process.stderr.write(s));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    err(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args.help) {
    out(USAGE);
    return 0;
  }
  try {
    if (args.checkVoice) {
      const hits = findForbidden(fs.readFileSync(args.checkVoice, 'utf8'));
      for (const h of hits) out(`${args.checkVoice}:${h.line}: ${h.term}\n`);
      err(hits.length ? `${hits.length} banned term(s)\n` : 'voice ok\n');
      return hits.length ? 1 : 0;
    }
    const report = buildReport(args, { cwd: io.cwd });
    if (args.storyComment) {
      out(`${storyComment(report, args.storyComment)}\n`);
    } else if (args.format === 'md') {
      out(renderMarkdown(report));
    } else {
      out(`${JSON.stringify(report, null, 2)}\n`);
    }
    err(
      `sprint=${report.sprint} records=${report.metrics.records} ` +
        `stories=${report.stories.length} telemetry=${report.telemetryFile}\n`,
    );
    return 0;
  } catch (e) {
    err(`${e.message}\n`);
    return 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCli(process.argv.slice(2)));
}

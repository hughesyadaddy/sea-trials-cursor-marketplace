import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  buildReport,
  computeMetrics,
  filterRecords,
  findForbidden,
  followUps,
  median,
  parseArgs,
  parseGitLog,
  percentile,
  readTelemetry,
  renderMarkdown,
  repoMatches,
  resolveSprint,
  runCli,
  setGitRunner,
  storyComment,
  storyGitFacts,
  toEpoch,
} from './retro-metrics.mjs';

const RS = '\u001e';
const US = '\u001f';

let tmp;
let restoreGit;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-'));
  restoreGit = setGitRunner(() => ({ status: 1, stdout: '' }));
});

afterEach(() => {
  setGitRunner(restoreGit);
  fs.rmSync(tmp, { recursive: true, force: true });
});

function rec(over) {
  return {
    ts: '2026-09-10T10:00:00Z',
    kind: 'gate',
    task: 'format',
    host: 'cursor',
    ms: 1000,
    ok: true,
    repo: 'org/sea_trials_universal',
    ...over,
  };
}

function writeTelemetry(records, extraLines = []) {
  const file = path.join(tmp, 'gate-runs.jsonl');
  const lines = records.map((r) => JSON.stringify(r)).concat(extraLines);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

function makeSprint() {
  const dir = path.join(tmp, 'sprint_planning', 'sprint-12');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'sprint.json'),
    JSON.stringify({
      projectKey: 'STD',
      startDate: '2026-09-01',
      endDate: '2026-09-14',
      repo: 'org/sea_trials_universal',
    }),
  );
  fs.writeFileSync(
    path.join(dir, 'jira_state.json'),
    JSON.stringify({
      stories: {
        3: { key: 'STD-131', subtasks: {} },
        4: { key: 'STD-140', subtasks: {} },
      },
    }),
  );
  fs.writeFileSync(path.join(dir, '00-epic.md'), '# Epic: Billing\n');
  fs.writeFileSync(
    path.join(dir, '03-us3-invoice-pdf.md'),
    '# User Story 3: Members export a single invoice as PDF\n\n**SP:** 5\n',
  );
  fs.writeFileSync(
    path.join(dir, '04-us4-refunds.md'),
    '# User Story 4: Admins refund an invoice\n',
  );
  return dir;
}

const SAMPLE = [
  rec({ ts: '2026-09-02T09:00:00Z', task: 'format', ms: 30000, cacheHit: true, model: 'composer-2.5' }),
  rec({ ts: '2026-09-03T09:00:00Z', task: 'analyze', ms: 120000, cacheHit: false, model: 'composer-2.5' }),
  rec({ ts: '2026-09-04T09:00:00Z', task: 'test:client_app', ms: 900000, ok: false, cacheHit: false, model: 'sonnet', exitCode: 1 }),
  rec({ ts: '2026-09-05T09:00:00Z', task: 'lint', ms: 60000, model: 'composer-2.5' }),
  rec({ ts: '2026-09-05T10:00:00Z', kind: 'shard', task: 'shard:ui', ms: 400000, model: 'composer-2.5' }),
  rec({ ts: '2026-09-05T11:00:00Z', kind: 'shard', task: 'shard:repo', ms: 300000, ok: false, model: 'sonnet' }),
  rec({ ts: '2026-09-06T09:00:00Z', kind: 'review-loop', task: 'iteration', ms: 200000, pr: 123, model: 'sonnet' }),
  rec({ ts: '2026-09-06T10:00:00Z', kind: 'review-loop', task: 'iteration', ms: 250000, pr: 123, ok: false, model: 'sonnet' }),
  rec({ ts: '2026-09-07T09:00:00Z', kind: 'review-loop', task: 'iteration', ms: 100000, pr: 124, model: 'sonnet' }),
  rec({ ts: '2026-08-20T09:00:00Z', task: 'old', ms: 5 }),
  rec({ ts: '2026-09-08T09:00:00Z', task: 'other-repo', ms: 5, repo: 'org/other' }),
];

// ===========================================================================
// ARGS + VOICE
// ===========================================================================

test('parseArgs collects options and requires --sprint', () => {
  const a = parseArgs(['--sprint', 'sprint-12', '--md', '--story', 'A-1', '--story', 'A-2']);
  assert.equal(a.sprint, 'sprint-12');
  assert.equal(a.format, 'md');
  assert.deepEqual(a.stories, ['A-1', 'A-2']);
  assert.equal(a.base, 'origin/dev');
  assert.throws(() => parseArgs([]), /--sprint/);
  assert.throws(() => parseArgs(['--sprint', 'x', '--nope']), /unknown/);
  assert.equal(parseArgs(['--check-voice', 'f.md']).checkVoice, 'f.md');
});

test('findForbidden flags contract section 5 terms, emojis, placeholders', () => {
  const text = [
    'We shipped the PDF export.',
    'Maybe we should investigate the toast.',
    'The push gate ran twice.',
    'An AI agent generated this.',
    'Delegate to the service; navigate carefully.',
    'Fill in <PLACEHOLDER> and {{name}}.',
  ].join('\n');
  const hits = findForbidden(text);
  const terms = hits.map((h) => `${h.line}:${h.term}`);
  assert.ok(terms.includes('2:maybe'));
  assert.ok(terms.includes('2:investigate'));
  assert.ok(terms.includes('3:gate'));
  assert.ok(terms.includes('4:AI'));
  assert.ok(terms.includes('4:agent'));
  assert.ok(terms.includes('4:generated'));
  assert.ok(terms.includes('6:placeholder'));
  // Word boundaries: "delegate" and "navigate" are not "gate".
  assert.equal(terms.some((t) => t.startsWith('5:')), false);
  assert.equal(findForbidden('Plain sentence about invoices.').length, 0);
  // Case-sensitive tells: "ai" inside "said" or lowercase is not "AI".
  assert.equal(findForbidden('She said the ai-generated look was fine').some((h) => h.term === 'AI'), false);
});

// ===========================================================================
// TELEMETRY
// ===========================================================================

test('toEpoch accepts ISO strings, epoch ms and epoch seconds', () => {
  assert.equal(toEpoch('2026-09-10T00:00:00Z'), Date.UTC(2026, 8, 10));
  assert.equal(toEpoch(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(toEpoch(1_700_000_000), 1_700_000_000_000);
  assert.ok(Number.isNaN(toEpoch('nope')));
  assert.ok(Number.isNaN(toEpoch(null)));
});

test('readTelemetry skips blank and malformed lines', () => {
  const file = writeTelemetry(SAMPLE.slice(0, 2), ['', 'not json', '{broken']);
  assert.equal(readTelemetry(file).length, 2);
  assert.deepEqual(readTelemetry(path.join(tmp, 'missing.jsonl')), []);
});

test('filterRecords applies window and repo', () => {
  const inWindow = filterRecords(SAMPLE, {
    since: '2026-09-01',
    until: '2026-09-14',
    repo: 'org/sea_trials_universal',
  });
  assert.equal(inWindow.length, 9);
  assert.equal(inWindow.some((r) => r.task === 'old'), false);
  assert.equal(inWindow.some((r) => r.task === 'other-repo'), false);
  // `until` is inclusive of the whole day.
  const edge = filterRecords([rec({ ts: '2026-09-14T23:59:00Z' })], {
    until: '2026-09-14',
  });
  assert.equal(edge.length, 1);
  assert.equal(filterRecords(SAMPLE, {}).length, SAMPLE.length);
});

test('repoMatches compares owner/name, paths and bare names', () => {
  assert.ok(repoMatches('org/sea_trials_universal', 'sea_trials_universal'));
  assert.ok(repoMatches('/Users/me/sea_trials_universal', 'org/sea_trials_universal'));
  assert.ok(repoMatches('org/x', 'org/x'));
  assert.equal(repoMatches('org/other', 'org/x'), false);
  assert.equal(repoMatches('', 'org/x'), false);
});

test('percentile and median', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95), 10);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50), 5);
  assert.equal(percentile([], 95), null);
});

test('computeMetrics aggregates shards, gates, loops, models, slowest', () => {
  const records = filterRecords(SAMPLE, {
    since: '2026-09-01',
    until: '2026-09-14',
    repo: 'org/sea_trials_universal',
  });
  const m = computeMetrics(records);
  assert.deepEqual(m.shards, { run: 2, succeeded: 1 });
  assert.equal(m.gate.runs, 4);
  assert.equal(m.gate.failed, 1);
  assert.equal(m.gate.totalMinutes, 18.5);
  assert.equal(m.gate.medianMs, 90000);
  assert.equal(m.gate.p95Ms, 900000);
  assert.equal(m.gate.cacheHitRate, 25);
  assert.equal(m.gate.cacheHitSamples, 4);
  assert.equal(m.reviewLoop.prs, 2);
  assert.equal(m.reviewLoop.totalIterations, 3);
  assert.deepEqual(m.reviewLoop.perPr[0], {
    pr: '123',
    iterations: 2,
    failed: 1,
    ms: 450000,
  });
  const sonnet = m.byModel.find((e) => e.model === 'sonnet');
  assert.equal(sonnet.runs, 5);
  assert.equal(sonnet.failed, 3);
  assert.equal(sonnet.failRate, 60);
  assert.equal(m.slowest.length, 5);
  assert.equal(m.slowest[0].task, 'test:client_app');
  assert.equal(m.slowest[0].ok, false);
  assert.equal(m.slowest[1].task, 'shard:ui');
});

test('followUps lists long review loops, failing runners, slow tasks', () => {
  const m = computeMetrics([
    ...Array.from({ length: 4 }, (_, i) =>
      rec({ kind: 'review-loop', pr: 9, ms: 1000, ts: `2026-09-0${i + 1}` }),
    ),
    ...Array.from({ length: 4 }, (_, i) =>
      rec({ model: 'flaky', ok: i < 2, ms: 1000 }),
    ),
    rec({ task: 'e2e', ms: 11 * 60000 }),
  ]);
  const items = followUps(m).map((f) => f.item);
  assert.ok(items.some((i) => i.startsWith('PR #9 needed 4 review rounds')));
  assert.ok(items.some((i) => i.startsWith('flaky failed 50% of 4 runs')));
  assert.ok(items.some((i) => i === 'e2e took 11 min'));
});

// ===========================================================================
// SPRINT + GIT
// ===========================================================================

test('resolveSprint reads sprint.json, jira_state.json and story H1s', () => {
  const dir = makeSprint();
  const byDir = resolveSprint(dir);
  assert.equal(byDir.name, 'sprint-12');
  assert.equal(byDir.config.projectKey, 'STD');
  assert.deepEqual(
    byDir.stories.map((s) => [s.id, s.key, s.title]),
    [
      ['3', 'STD-131', 'User Story 3: Members export a single invoice as PDF'],
      ['4', 'STD-140', 'User Story 4: Admins refund an invoice'],
    ],
  );
  const byName = resolveSprint('sprint-12', { cwd: tmp });
  assert.equal(byName.dir, dir);
  const byRepoRoot = resolveSprint('sprint-12', { cwd: '/nowhere', repoRoot: tmp });
  assert.equal(byRepoRoot.dir, dir);
  const missing = resolveSprint('sprint-99', { cwd: tmp });
  assert.equal(missing.dir, null);
  assert.equal(missing.name, 'sprint-99');
  assert.deepEqual(missing.stories, []);
});

function gitLogText(commits) {
  return commits
    .map((c) => `${RS}${c.sha}${US}${c.date}${US}${c.subject}\n${c.files.join('\n')}\n`)
    .join('');
}

test('parseGitLog splits records and file lists', () => {
  const text = gitLogText([
    { sha: 'a1', date: '2026-09-02T10:00:00+02:00', subject: 'feat: pdf (STD-131)', files: ['lib/a.dart', 'test/a_test.dart'] },
    { sha: 'b2', date: '2026-09-03T10:00:00+02:00', subject: 'chore', files: [] },
  ]);
  const parsed = parseGitLog(text);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0].files, ['lib/a.dart', 'test/a_test.dart']);
  assert.equal(parsed[1].subject, 'chore');
  assert.deepEqual(parseGitLog(''), []);
});

function fakeGit() {
  const calls = [];
  setGitRunner((args, cwd) => {
    calls.push({ args, cwd });
    if (args[0] === 'for-each-ref') {
      return { status: 0, stdout: 'dev\norigin/dev\norigin/feature/std-131-pdf\norigin/HEAD\n' };
    }
    if (args.some((a) => a.startsWith('--grep=STD-131'))) {
      return {
        status: 0,
        stdout: gitLogText([
          { sha: 'a1', date: '2026-09-02T10:00:00Z', subject: 'feat(billing): pdf service (STD-131)', files: ['flutter/packages/billing/lib/pdf.dart', 'flutter/packages/billing/test/pdf_test.dart'] },
          { sha: 'm1', date: '2026-09-09T10:00:00Z', subject: 'feat: invoice PDF export (STD-131) (#123)', files: ['flutter/packages/billing/lib/pdf.dart', 'flutter/apps/client_app/lib/export.dart'] },
        ]),
      };
    }
    if (args.includes('origin/feature/std-131-pdf') && args.includes('--not')) {
      return {
        status: 0,
        stdout: gitLogText([
          { sha: 'a1', date: '2026-09-02T10:00:00Z', subject: 'feat(billing): pdf service (STD-131)', files: ['flutter/packages/billing/lib/pdf.dart'] },
          { sha: 'c3', date: '2026-09-05T10:00:00Z', subject: 'test: cover share sheet', files: ['flutter/packages/billing/test/share_test.dart'] },
        ]),
      };
    }
    if (args.some((a) => a.startsWith('--grep=STD-140'))) {
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  });
  return calls;
}

test('storyGitFacts merges grep and branch commits, extracts PRs', () => {
  const calls = fakeGit();
  const facts = storyGitFacts('STD-131', {
    repoRoot: '/repo',
    since: '2026-09-01',
    until: '2026-09-14',
    base: 'origin/dev',
    branches: ['dev', 'origin/dev', 'origin/feature/std-131-pdf'],
  });
  assert.equal(facts.commits, 3);
  assert.equal(facts.filesChanged, 4);
  assert.equal(facts.topDirectory, 'flutter/packages');
  assert.equal(facts.firstCommit, '2026-09-02T10:00:00Z');
  assert.equal(facts.lastCommit, '2026-09-09T10:00:00Z');
  assert.deepEqual(facts.prs, [123]);
  assert.deepEqual(facts.branches, ['origin/feature/std-131-pdf']);
  assert.ok(calls.every((c) => c.cwd === '/repo'));
  assert.ok(calls[0].args.includes('--since=2026-09-01'));
  assert.ok(calls[0].args.includes('--until=2026-09-14'));
});

// ===========================================================================
// REPORT + RENDERING
// ===========================================================================

function report() {
  const dir = makeSprint();
  const file = writeTelemetry(SAMPLE);
  fakeGit();
  const args = parseArgs([
    '--sprint',
    dir,
    '--telemetry',
    file,
    '--repo-root',
    '/repo',
  ]);
  return buildReport(args, { cwd: tmp });
}

test('buildReport combines sprint window, telemetry and git facts', () => {
  const r = report();
  assert.equal(r.sprint, 'sprint-12');
  assert.deepEqual(r.window, { since: '2026-09-01', until: '2026-09-14' });
  assert.equal(r.repo, 'org/sea_trials_universal');
  assert.equal(r.metrics.records, 9);
  const us3 = r.stories.find((s) => s.key === 'STD-131');
  assert.equal(us3.id, '3');
  assert.equal(us3.commits, 3);
  assert.deepEqual(us3.prs, [123]);
  const us4 = r.stories.find((s) => s.key === 'STD-140');
  assert.equal(us4.commits, 0);
});

test('buildReport without --repo-root leaves git facts null', () => {
  const dir = makeSprint();
  const file = writeTelemetry(SAMPLE);
  const args = parseArgs(['--sprint', dir, '--telemetry', file, '--story', 'STD-999']);
  const r = buildReport(args, { cwd: tmp });
  assert.equal(r.stories.length, 3);
  assert.equal(r.stories.find((s) => s.key === 'STD-131').commits, null);
  assert.ok(r.stories.some((s) => s.key === 'STD-999'));
});

test('renderMarkdown emits the five H2 sections as tables and clean voice', () => {
  const md = renderMarkdown(report());
  const headings = md.split('\n').filter((l) => l.startsWith('## '));
  assert.deepEqual(headings, [
    '## Summary',
    '## Delivery',
    '## Build tooling',
    '## Review loop',
    '## Follow-ups',
  ]);
  assert.match(md, /\| Sprint \| sprint-12 \|/);
  assert.match(md, /\| US3 \| STD-131 \| User Story 3: Members export a single invoice as PDF \| 3 \| 4 \| \[#123\]\(https:\/\/github\.com\/org\/sea_trials_universal\/pull\/123\) \| 2026-09-02 \| 2026-09-09 \|/);
  assert.match(md, /\| Shards run \| 2 \|/);
  assert.match(md, /\| Cache hit rate \| 25% of 4 \|/);
  assert.match(md, /\| sonnet \| 5 \| 3 \| 60% \|/);
  assert.match(md, /\| \[#123\]\([^)]+\) \| 2 \| 1 \| 7\.5 \|/);
  assert.match(md, /\| test:client_app took 15 min \| Build tooling \| open \|/);
  // Tables only: every non-blank, non-heading line is a table row.
  for (const line of md.split('\n')) {
    if (!line.trim() || line.startsWith('## ')) continue;
    assert.ok(line.startsWith('|'), `not a table row: ${line}`);
  }
  assert.deepEqual(findForbidden(md), []);
});

test('storyComment is short plain prose with the PR link and clean voice', () => {
  const r = report();
  const text = storyComment(r, 'STD-131');
  const lines = text.split('\n');
  assert.ok(lines.length <= 6, text);
  assert.ok(lines.every((l) => l.length <= 78));
  const flat = text.replace(/\n/g, ' ');
  assert.match(flat, /^Members export a single invoice as PDF shipped in #123/);
  assert.match(flat, /https:\/\/github\.com\/org\/sea_trials_universal\/pull\/123/);
  assert.match(flat, /3 commits between 2026-09-02 and 2026-09-09 touched 4 files/);
  assert.match(flat, /most of them under flutter\/packages/);
  assert.match(flat, /Review took 2 rounds\./);
  assert.equal(text.includes('- '), false);
  assert.deepEqual(findForbidden(text), []);

  const none = storyComment(r, 'STD-140').replace(/\n/g, ' ');
  assert.match(none, /No commits in the sprint window mention STD-140/);
  assert.deepEqual(findForbidden(none), []);
  assert.throws(() => storyComment(r, 'STD-1'), /not in this sprint/);
});

// ===========================================================================
// CLI
// ===========================================================================

function cli(argv) {
  const stdout = [];
  const stderr = [];
  const code = runCli(argv, {
    cwd: tmp,
    stdout: (s) => stdout.push(s),
    stderr: (s) => stderr.push(s),
  });
  return { code, out: stdout.join(''), err: stderr.join('') };
}

test('CLI --json, --md and --story-comment', () => {
  const dir = makeSprint();
  const file = writeTelemetry(SAMPLE);
  fakeGit();
  const base = ['--sprint', 'sprint-12', '--telemetry', file, '--repo-root', '/repo'];
  const json = cli([...base, '--json']);
  assert.equal(json.code, 0);
  assert.equal(JSON.parse(json.out).sprintDir, dir);
  assert.match(json.err, /sprint=sprint-12 records=9 stories=2/);
  const md = cli([...base, '--md']);
  assert.match(md.out, /^## Summary/);
  const comment = cli([...base, '--story-comment', 'STD-131']);
  assert.equal(comment.code, 0);
  assert.match(comment.out, /shipped in #123/);
});

test('CLI --check-voice exits 1 with hits and 0 when clean', () => {
  const bad = path.join(tmp, 'bad.md');
  fs.writeFileSync(bad, 'We might want to consider a spike.\nFine line.\n');
  const res = cli(['--check-voice', bad]);
  assert.equal(res.code, 1);
  assert.match(res.out, /bad\.md:1: might want to/);
  assert.match(res.out, /bad\.md:1: consider/);
  assert.match(res.out, /bad\.md:1: spike/);
  const good = path.join(tmp, 'good.md');
  fs.writeFileSync(good, 'The export ships on Friday.\n');
  assert.equal(cli(['--check-voice', good]).code, 0);
});

test('CLI exits 2 on usage errors and 1 on unknown story', () => {
  assert.equal(cli([]).code, 2);
  const file = writeTelemetry([]);
  const res = cli(['--sprint', 'nope', '--telemetry', file, '--story-comment', 'X-1']);
  assert.equal(res.code, 1);
  assert.match(res.err, /not in this sprint/);
});

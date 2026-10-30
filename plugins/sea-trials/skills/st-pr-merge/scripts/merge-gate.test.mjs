import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT, buildMergeArgs, checkMigrations, checkRenames, classifyChecks, classifyThreads,
  evaluate, parseArgs, runGate, targetEnvFor,
} from './merge-gate.mjs';

const pr = (o = {}) => ({ number: 7, state: 'OPEN', isDraft: false, headRefOid: 'abc123', headRefName: 'f', baseRefName: 'dev', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', ...o });
const run = (name, conclusion = 'SUCCESS', status = 'COMPLETED') => ({ kind: 'check', name, status, conclusion });
const opts = { allowHumanThreads: false };
const noThreads = classifyThreads([]);

test('zero checks is pending, never green', () => {
  assert.equal(classifyChecks([]).verdict, 'pending');
});
test('all workflows count, not only PR Checks', () => {
  const c = classifyChecks([run('dart-static'), run('Main Guardrails', 'FAILURE')]);
  assert.equal(c.verdict, 'fail');
});
test('skipped/neutral are green; queued is pending; cancelled/timed out fail', () => {
  assert.equal(classifyChecks([run('a', 'SKIPPED'), run('b', 'NEUTRAL')]).verdict, 'green');
  assert.equal(classifyChecks([run('a'), run('b', null, 'QUEUED')]).verdict, 'pending');
  assert.equal(classifyChecks([run('a', 'CANCELLED')]).verdict, 'fail');
  assert.equal(classifyChecks([run('a', 'TIMED_OUT')]).verdict, 'fail');
  assert.equal(classifyChecks([run('a', 'ACTION_REQUIRED')]).verdict, 'fail');
});
test('required check missing keeps pending', () => {
  assert.equal(classifyChecks([run('a')], ['PR Checks / dart-static']).verdict, 'pending');
});
test('unresolved AI review thread blocks even with --allow-human-threads', () => {
  const t = classifyThreads([{ id: 'T', isResolved: false, author: 'github-actions' }]);
  const v = evaluate({ prMeta: pr(), checks: classifyChecks([run('a')]), threads: t, migrations: null, opts: { allowHumanThreads: true } });
  assert.equal(v.exit, EXIT.THREADS);
});
test('outdated-but-unresolved AI review thread still blocks', () => {
  const t = classifyThreads([{ id: 'T', isResolved: false, isOutdated: true, author: 'github-actions' }]);
  assert.equal(t.bot.length, 1);
});
test('AI Review (advisory) check is never part of the CI verdict', () => {
  const ai = (status, conclusion) => ({ kind: 'check', name: 'review', workflow: 'AI Review (advisory)', status, conclusion });
  assert.equal(classifyChecks([run('a'), ai('IN_PROGRESS', null)]).verdict, 'green', 'never waits for it');
  assert.equal(classifyChecks([run('a'), ai('COMPLETED', 'FAILURE')]).verdict, 'green', 'never fails on it');
  assert.equal(classifyChecks([ai('COMPLETED', 'SUCCESS')]).verdict, 'pending', 'it alone is not CI');
  assert.equal(classifyChecks([run('a'), ai('COMPLETED', 'SUCCESS')]).advisory.length, 1);
});
test('BEHIND / BLOCKED / DIRTY never merge', () => {
  for (const ms of ['BEHIND', 'BLOCKED', 'DIRTY']) {
    const v = evaluate({ prMeta: pr({ mergeStateStatus: ms }), checks: classifyChecks([run('a')]), threads: noThreads, migrations: null, opts });
    assert.equal(v.exit, EXIT.NOT_MERGEABLE, ms);
  }
});
test('--admin is rejected at parse time and never built', () => {
  assert.throws(() => parseArgs(['--pr', '1', '--admin']), /forbidden/);
  const a = buildMergeArgs({ pr: 1, repo: 'o/n', method: 'merge', headOid: 'abc' });
  assert.ok(!a.includes('--admin'));
  assert.deepEqual(a.slice(-2), ['--match-head-commit', 'abc']);
});
test('migration ordering, duplicates and cross-PR collisions', () => {
  const base = ['20261013000000_a.sql', '20261013210000_b.sql'];
  assert.equal(checkMigrations({ added: ['supabase/migrations/20261014000000_x.sql'], baseNames: base, others: [] }).ok, true);
  const old = checkMigrations({ added: ['supabase/migrations/20261013140000_x.sql'], baseNames: base, others: [] });
  assert.equal(old.ok, false); assert.match(old.problems[0], /not newer/);
  const dup = checkMigrations({ added: ['supabase/migrations/20261013210000_x.sql'], baseNames: base, others: [] });
  assert.match(dup.problems[0], /already used on base/);
  const inherited = checkMigrations({ added: ['supabase/migrations/20261013210000_b.sql'], baseNames: base, others: [] });
  assert.equal(inherited.ok, true);
  const stacked = checkMigrations({ added: ['supabase/migrations/20261014000000_x.sql'], baseNames: base, others: [{ number: 5, files: ['supabase/migrations/20261014000000_x.sql'] }] });
  assert.equal(stacked.ok, true); assert.equal(stacked.shared.length, 1);
  const cross = checkMigrations({ added: ['supabase/migrations/20261014000000_x.sql'], baseNames: base, others: [{ number: 9, files: ['supabase/migrations/20261014000000_y.sql'] }] });
  assert.match(cross.problems[0], /open PR #9/);
});

function fakeGh(state) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    const ok = (o) => ({ status: 0, stdout: JSON.stringify(o), stderr: '' });
    if (args[0] === 'pr' && args[1] === 'view') return ok(state.pr());
    if (args[0] === 'pr' && args[1] === 'merge') return state.merge ? state.merge(args) : ok({});
    if (args[0] === 'api' && args[1] === 'graphql') {
      const q = args.find((a) => a.startsWith('query='));
      if (q.includes('statusCheckRollup')) return ok({ data: { repository: { object: { statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: state.checks().map((c) => ({ __typename: 'CheckRun', name: c.name, status: c.status, conclusion: c.conclusion })) } } } } } });
      return ok({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: state.threads ?? [] } } } } });
    }
    throw new Error(`unexpected ${args.join(' ')}`);
  };
  return { gh, calls };
}
const baseOpts = { pr: 7, repo: 'o/n', dryRun: false, method: 'merge', waitMin: 0, settleSec: 1, allowHumanThreads: false, migrations: false, required: [] };

test('merges green PR pinned to head, never --admin', () => {
  const { gh, calls } = fakeGh({ pr: () => pr(), checks: () => [run('a')] });
  const r = runGate(baseOpts, gh, () => {});
  assert.equal(r.verdict.exit, EXIT.OK);
  const m = calls.find((c) => c[1] === 'merge');
  assert.ok(m.includes('--match-head-commit') && !m.includes('--admin'));
});
test('head moving during settle aborts without merging', () => {
  let n = 0;
  const { gh, calls } = fakeGh({ pr: () => pr({ headRefOid: n++ === 0 ? 'abc' : 'def' }), checks: () => [run('a')] });
  const r = runGate(baseOpts, gh, () => {});
  assert.equal(r.verdict.exit, EXIT.HEAD_MOVED);
  assert.ok(!calls.some((c) => c[1] === 'merge'));
});
test('late-registering check during settle prevents merge', () => {
  let n = 0;
  const { gh, calls } = fakeGh({ pr: () => pr(), checks: () => (n++ === 0 ? [run('a')] : [run('a'), run('b', null, 'QUEUED')]) });
  const r = runGate(baseOpts, gh, () => {});
  assert.equal(r.verdict.exit, EXIT.CI_PENDING);
  assert.ok(!calls.some((c) => c[1] === 'merge'));
});
test('dry-run never merges', () => {
  const { gh, calls } = fakeGh({ pr: () => pr(), checks: () => [run('a')] });
  assert.equal(runGate({ ...baseOpts, dryRun: true }, gh, () => {}).verdict.exit, EXIT.OK);
  assert.ok(!calls.some((c) => c[1] === 'merge'));
});

// ------------------------------------------------ renames vs applied migrations
const D = 'supabase/migrations';
const ren = (o, n) => ({ status: 'renamed', oldFile: `${D}/${o}`, newFile: `${D}/${n}` });
const dev = targetEnvFor('feat/rich-content');

test('base → migration DB mapping (unknown base unmapped)', () => {
  assert.equal(targetEnvFor('feat/rich-content').ref, 'jchyjnxcnukbsmlsolha');
  assert.equal(targetEnvFor('dev').ref, 'jchyjnxcnukbsmlsolha');
  assert.equal(targetEnvFor('stg').ref, 'lbypalsqrvpwfxofqciz');
  assert.equal(targetEnvFor('main').ref, 'oulpgrsifasfsvkrjnrn');
  assert.equal(targetEnvFor('cursor/some-branch'), null);
  assert.equal(targetEnvFor('constructor'), null);
});
test('rename of a never-applied migration is allowed and logged', () => {
  const r = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013220500_a.sql')], env: dev, baseRef: 'feat/rich-content', applied: () => ({ applied: new Set(), maxApplied: '20261013220000' }) });
  assert.equal(r.ok, true);
  assert.equal(r.allowed.length, 1);
  assert.match(r.allowed[0], /20261013140000 never applied on Dev/);
});
test('rename or delete of an applied migration is blocked', () => {
  const r = checkRenames({ changes: [ren('20261013220000_b.sql', '20261013221000_b.sql'), { status: 'removed', oldFile: `${D}/20261012000000_c.sql` }], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(['20261013220000', '20261012000000']), maxApplied: '20261013220000' }) });
  assert.equal(r.ok, false);
  assert.equal(r.problems.length, 2);
  assert.match(r.problems[0], /is applied on Dev/);
  assert.match(r.problems[1], /deleted .* is applied on Dev/);
});
test('unreachable DB fails closed', () => {
  const r = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013220500_a.sql')], env: dev, baseRef: 'dev', applied: () => { throw new Error('HTTP 401'); } });
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /cannot read Dev .*fail closed/);
});
test('unmapped base fails closed without querying', () => {
  let called = false;
  const r = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013220500_a.sql')], env: null, baseRef: 'cursor/x', applied: () => { called = true; return { applied: new Set(), maxApplied: '0' }; } });
  assert.equal(r.ok, false); assert.equal(called, false);
  assert.match(r.problems[0], /no mapped migration DB/);
});
test('rename target colliding with base or another open PR is blocked', () => {
  const base = ['20261013140000_a.sql', '20261013220500_other.sql'];
  const r1 = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013220500_a.sql')], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(), maxApplied: '0' }), baseNames: base });
  assert.match(r1.problems[0], /already used on base/);
  const r2 = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013220500_a.sql')], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(), maxApplied: '0' }), others: [{ number: 9, files: [`${D}/20261013220500_z.sql`] }] });
  assert.match(r2.problems[0], /open PR #9/);
});

function migGh(state, files) {
  const inner = fakeGh(state);
  const gh = (args) => {
    if (args[0] === 'api' && args.some((a) => /pulls\/7\/files/.test(a))) return { status: 0, stdout: JSON.stringify([files]), stderr: '' };
    if (args[0] === 'api' && args.some((a) => /contents\//.test(a))) return { status: 0, stdout: JSON.stringify([{ name: '20261013140000_a.sql' }]), stderr: '' };
    if (args[0] === 'pr' && args[1] === 'list') return { status: 0, stdout: '[]', stderr: '' };
    return inner.gh(args);
  };
  return { gh, calls: inner.calls };
}
const renamedFiles = [{ status: 'renamed', previous_filename: `${D}/20261013140000_a.sql`, filename: `${D}/20261013220500_a.sql` }];
test('gate end-to-end: never-applied rename passes (dry-run), applied rename blocks', () => {
  const st = { pr: () => pr({ baseRefName: 'feat/rich-content' }), checks: () => [run('a')] };
  const o = { ...baseOpts, migrations: true, migrationsDir: D, dryRun: true };
  let seen;
  const ok = runGate(o, migGh(st, renamedFiles).gh, () => {}, (env, v) => { seen = [env.ref, v]; return { applied: new Set(), maxApplied: '20261013220000' }; });
  assert.equal(ok.verdict.exit, EXIT.OK);
  assert.deepEqual(seen, ['jchyjnxcnukbsmlsolha', ['20261013140000']]);
  assert.equal(ok.migrations.renames.length, 1);
  const bad = runGate(o, migGh(st, renamedFiles).gh, () => {}, () => ({ applied: new Set(['20261013140000']), maxApplied: '20261013220000' }));
  assert.equal(bad.verdict.exit, EXIT.MIGRATIONS);
  const down = runGate(o, migGh(st, renamedFiles).gh, () => {}, () => { throw new Error('ECONNREFUSED'); });
  assert.equal(down.verdict.exit, EXIT.MIGRATIONS);
});

test('rename destination must be newer than latest applied on the target DB', () => {
  const r = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013150000_a.sql')], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(), maxApplied: '20261013220000' }) });
  assert.match(r.problems[0], /not newer than the latest migration applied on Dev/);
});
test('rename destination colliding with another claim in the same PR is blocked', () => {
  const r = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013230000_a.sql'), ren('20261013141000_b.sql', '20261013230000_b.sql')], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(), maxApplied: '0' }) });
  assert.equal(r.ok, false); assert.match(r.problems[0], /more than once/);
  const r2 = checkRenames({ changes: [ren('20261013140000_a.sql', '20261013230000_a.sql')], addedFiles: [`${D}/20261013230000_new.sql`], env: dev, baseRef: 'dev', applied: () => ({ applied: new Set(), maxApplied: '0' }) });
  assert.match(r2.problems[0], /more than once/);
});
test('applied history is re-read right before merging', () => {
  let n = 0;
  const st = { pr: () => pr({ baseRefName: 'feat/rich-content' }), checks: () => [run('a')] };
  const { gh, calls } = migGh(st, renamedFiles);
  const r = runGate({ ...baseOpts, migrations: true, migrationsDir: D }, gh, () => {}, () => (n++ === 0 ? { applied: new Set(), maxApplied: '20261013220000' } : { applied: new Set(['20261013140000']), maxApplied: '20261013220000' }));
  assert.equal(r.verdict.exit, EXIT.MIGRATIONS);
  assert.ok(!calls.some((c) => c[1] === 'merge'));
});

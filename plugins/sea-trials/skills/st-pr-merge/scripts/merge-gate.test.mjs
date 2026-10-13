import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT, buildMergeArgs, checkMigrations, classifyChecks, classifyThreads,
  evaluate, parseArgs, runGate,
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
test('unresolved Codex thread blocks even with --allow-human-threads', () => {
  const t = classifyThreads([{ id: 'T', isResolved: false, author: 'chatgpt-codex-connector' }]);
  const v = evaluate({ prMeta: pr(), checks: classifyChecks([run('a')]), threads: t, migrations: null, opts: { allowHumanThreads: true } });
  assert.equal(v.exit, EXIT.THREADS);
});
test('outdated-but-unresolved Codex thread still blocks', () => {
  const t = classifyThreads([{ id: 'T', isResolved: false, isOutdated: true, author: 'chatgpt-codex-connector' }]);
  assert.equal(t.codex.length, 1);
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

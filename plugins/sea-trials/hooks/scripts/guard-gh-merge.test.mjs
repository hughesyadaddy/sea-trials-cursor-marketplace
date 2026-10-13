import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { decideMerge } from './guard-gh-merge.mjs';

const deny = (c) => assert.equal(decideMerge(c).permission, 'deny', c);
const allow = (c) => assert.equal(decideMerge(c).permission, 'allow', c);

test('denies --admin in every shape', () => {
  deny('gh pr merge 1800 --merge --admin');
  deny('cd /workspace && gh pr merge 1770 --merge --admin 2>&1');
  deny('bash -c "gh pr merge 5 --squash --admin"');
  deny('gh pr merge 5 --admin=true');
  assert.match(decideMerge('gh pr merge 1 --admin').message, /forbidden/);
});
test('denies manual merges and API bypasses', () => {
  deny('gh pr merge 1821 --merge --subject x');
  deny('gh api -X PUT repos/o/n/pulls/12/merge');
  deny("gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"x\"}){clientMutationId}}'");
  deny('gh api graphql -f query=mutation{enablePullRequestAutoMerge(input:{}){clientMutationId}}');
});
test('allows the merge gate and read-only gh', () => {
  allow('node "$ST_PLUGIN_ROOT/skills/st-pr-merge/scripts/merge-gate.mjs" --pr 5');
  allow('gh pr view 5 --json mergeStateStatus');
  allow('gh pr checks 5');
  allow('git merge origin/dev');
});
test('cursor JSON contract', () => {
  const script = fileURLToPath(new URL('./guard-gh-merge.mjs', import.meta.url));
  const r = spawnSync('node', [script], { input: JSON.stringify({ command: 'gh pr merge 3 --admin' }), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).permission, 'deny');
  const c = spawnSync('node', [script], { input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 3' } }), encoding: 'utf8' });
  assert.equal(c.status, 2);
});

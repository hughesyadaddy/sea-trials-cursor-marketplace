import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  decideCost,
  detectViolations,
  fastModelInAgentCall,
  hitsCursorCloudApi,
  isClaudeCloud,
  isCodexCloudExec,
} from './guard-cost-policy.mjs';

const noEnv = {};
const deny = (c, env = noEnv) =>
  assert.equal(decideCost(c, env).permission, 'deny', c);
const allow = (c, env = noEnv) =>
  assert.equal(decideCost(c, env).permission, 'allow', c);

test('denies *-fast models passed to cursor-agent/agent', () => {
  deny('cursor-agent --model composer-2.5-fast run "fix it"');
  deny('agent -m grok-4.7-high-fast');
  deny('cursor-agent --model=composer-2.5-fast');
  deny('cd /repo && agent --model gpt-5.6-luna-fast exec');
  deny('bash -c "cursor-agent --model composer-2.5-fast run"');
  assert.match(decideCost('agent --model x-fast').message, /\*-fast model/);
});

test('allows cursor-agent/agent on standard (non-fast) models', () => {
  allow('cursor-agent --model composer-2.5 run "fix it"');
  allow('agent -m composer-2.5');
  allow('agent --model=composer-2.5');
});

test('leaves unrelated "fast" words alone', () => {
  allow('pnpm agent-e2e-fast');
  allow('node human-cadence.mjs plan p.json --fast');
  allow('git push --force-with-lease');
  allow('echo "handling a non-fast-forward merge"');
  // A *-fast env override to a node script is not a cursor-agent CLI call.
  allow('ST_SHARD_MODEL_CODE=composer-2.5-fast node st-build-shard-tasks.mjs');
});

test('denies the Cursor cloud / background agents API', () => {
  deny('curl -X POST https://api.cursor.com/v0/agents -d @body.json');
  deny('curl https://api.cursor.com/v1/agents/abc');
  deny('curl https://api.cursor.com/v0/background-agents');
  assert.ok(hitsCursorCloudApi('GET https://api.cursor.com/v1/agents'));
  assert.ok(!hitsCursorCloudApi('curl https://api.cursor.com/v0/me'));
});

test('denies codex cloud exec and claude --cloud', () => {
  deny('codex cloud exec "do the thing"');
  deny('claude --cloud -p "implement feature"');
  deny('claude -p foo --cloud');
  assert.ok(isCodexCloudExec(['codex', 'cloud', 'exec', 'x']));
  assert.ok(!isCodexCloudExec(['codex', 'exec', 'x']));
  assert.ok(isClaudeCloud(['claude', '--cloud']));
  assert.ok(!isClaudeCloud(['claude', '-p', 'x']));
});

test('allows local codex/claude/agent runs', () => {
  allow('codex exec "do the thing"');
  allow('claude -p "implement feature"');
  allow('cursor-agent run "local work"');
});

test('ST_ALLOW_CLOUD=1 overrides, via env or command prefix', () => {
  allow('codex cloud exec "x"', { ST_ALLOW_CLOUD: '1' });
  allow('ST_ALLOW_CLOUD=1 codex cloud exec "x"');
  allow('ST_ALLOW_CLOUD=1 cursor-agent --model composer-2.5-fast run');
  const d = decideCost('codex cloud exec "x"', { ST_ALLOW_CLOUD: '1' });
  assert.equal(d.permission, 'allow');
  assert.match(d.note, /ST_ALLOW_CLOUD=1/);
  assert.match(d.note, /blocked|despite/);
});

test('deny message names the override escape hatch', () => {
  assert.match(decideCost('claude --cloud -p x').message, /ST_ALLOW_CLOUD=1/);
});

test('detectViolations dedupes by reason code', () => {
  const v = detectViolations('cursor-agent --model a-fast && agent -m b-fast');
  assert.equal(v.filter((x) => x.code === 'fastModel').length, 1);
});

test('fastModelInAgentCall only fires for agent CLIs', () => {
  assert.ok(fastModelInAgentCall(['cursor-agent', '--model', 'x-fast']));
  assert.ok(!fastModelInAgentCall(['node', '--model', 'x-fast']));
  assert.ok(!fastModelInAgentCall(['cursor-agent', '--model', 'composer-2.5']));
});

test('cursor + claude JSON hook contract', () => {
  const script = fileURLToPath(new URL('./guard-cost-policy.mjs', import.meta.url));
  const cursor = spawnSync('node', [script], {
    input: JSON.stringify({ command: 'claude --cloud -p x' }),
    encoding: 'utf8',
  });
  assert.equal(JSON.parse(cursor.stdout).permission, 'deny');
  const claude = spawnSync('node', [script], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'codex cloud exec x' } }),
    encoding: 'utf8',
  });
  assert.equal(claude.status, 2);
  const ok = spawnSync('node', [script], {
    input: JSON.stringify({ command: 'cursor-agent --model composer-2.5 run' }),
    encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).permission, 'allow');
});

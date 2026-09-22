import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CALL_TIMEOUT_MS,
  DEFAULT_MAX_AGE_MS,
  SOURCE_AGENT_LIST,
  SOURCE_CLAUDE_ALIASES,
  TOOLS_NOTE,
  applySets,
  coerceSetValue,
  collectMcpServers,
  defaultRunner,
  findExecutable,
  isFresh,
  parseAgentModelList,
  parseArgs,
  parseClaudePluginList,
  parseDuration,
  parseVersion,
  probe,
  runProbeCli,
} from './st-model-probe.mjs';
import {
  STATIC_CLAUDE_MODELS,
  STATIC_CURSOR_MODELS,
  SOURCE_STATIC,
} from './lib/host-capabilities.mjs';

const hooksDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(hooksDir, 'st-model-probe.mjs');

const BASE_ENV = { PATH: '/nonexistent-bin', HOME: '/nonexistent-home' };

function tmpDir(prefix = 'st-probe-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Fake runner: maps `basename(cmd) args...` to a canned result. */
function fakeRunner(table, calls = []) {
  return async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = `${path.basename(cmd)} ${args.join(' ')}`.trim();
    const hit = table[key];
    if (hit === undefined) return null;
    if (typeof hit === 'string') return { status: 0, stdout: hit, stderr: '' };
    return hit;
  };
}

/** `exists` that pretends both CLIs live in ~/.local/bin. */
function fakeExists(homeDir, names = ['agent', 'claude']) {
  const known = new Set(names.map((n) => path.join(homeDir, '.local', 'bin', n)));
  return (p) => known.has(p);
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseArgs', () => {
  assert.deepEqual(parseArgs([]), {
    quiet: false,
    json: false,
    force: false,
    maxAgeMs: DEFAULT_MAX_AGE_MS,
    sets: [],
    help: false,
  });
  const a = parseArgs([
    '--quiet',
    '--json',
    '--force',
    '--max-age',
    '30m',
    '--set',
    'tools.askQuestion=true',
    '--set=tools.askUserQuestion=false',
    '--max-age=2d',
  ]);
  assert.equal(a.quiet, true);
  assert.equal(a.json, true);
  assert.equal(a.force, true);
  assert.equal(a.maxAgeMs, 2 * 86_400_000);
  assert.deepEqual(a.sets, ['tools.askQuestion=true', 'tools.askUserQuestion=false']);
});

test('parseDuration', () => {
  assert.equal(parseDuration('24h'), 86_400_000);
  assert.equal(parseDuration('30m'), 1_800_000);
  assert.equal(parseDuration('10s'), 10_000);
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('1.5h'), 5_400_000);
  assert.equal(parseDuration('2d'), 172_800_000);
  assert.equal(parseDuration('4200'), 4200);
  assert.equal(parseDuration('soon'), DEFAULT_MAX_AGE_MS, 'garbage → default');
  assert.equal(parseDuration(undefined), DEFAULT_MAX_AGE_MS);
});

test('parseVersion', () => {
  assert.equal(parseVersion('2.1.247 (Claude Code)'), '2.1.247');
  assert.equal(parseVersion('2026.06.04-5fd875e\n'), '2026.06.04-5fd875e');
  assert.equal(parseVersion('agent version 1.2'), '1.2');
  assert.equal(parseVersion(''), undefined);
  assert.equal(parseVersion(undefined), undefined);
});

test('parseAgentModelList: the "no models" answer → []', () => {
  assert.deepEqual(parseAgentModelList('No models available for this account.\n'), []);
  assert.deepEqual(parseAgentModelList(''), []);
  assert.deepEqual(parseAgentModelList(undefined), []);
});

test('parseAgentModelList: plain text with bullets, headers, descriptions', () => {
  const text = [
    'Available models:',
    '  * composer-2.5          Fast agentic coder',
    '  - composer-2.5-fast (default)',
    '  gpt-5.6-sol-medium: OpenAI',
    '  grok-4.7-high-fast',
    '',
    '  composer-2.5',
  ].join('\n');
  assert.deepEqual(parseAgentModelList(text), [
    'composer-2.5',
    'composer-2.5-fast',
    'gpt-5.6-sol-medium',
    'grok-4.7-high-fast',
  ]);
});

test('parseAgentModelList: JSON arrays and objects', () => {
  assert.deepEqual(parseAgentModelList('["a-1","b-2"]'), ['a-1', 'b-2']);
  assert.deepEqual(
    parseAgentModelList(JSON.stringify([{ id: 'x-1' }, { slug: 'y-2' }, { name: 'z 3' }])),
    ['x-1', 'y-2'],
    'objects use id/slug/name; invalid slugs dropped',
  );
  assert.deepEqual(parseAgentModelList('{"models":["m-1"]}'), ['m-1']);
  assert.deepEqual(parseAgentModelList('{"data":[{"id":"d-1"}]}'), ['d-1']);
});

test('parseClaudePluginList', () => {
  const text = [
    'Installed plugins:',
    '',
    '  ❯ sea-trials@sea-trials-claude-marketplace',
    '    Version: 2026.09.21',
    '    Scope: user',
    '    Status: ✔ enabled',
    '',
    '  ❯ vgv-wingspan@sea-trials-claude-marketplace',
    '    Version: 0.0.5',
  ].join('\n');
  assert.deepEqual(parseClaudePluginList(text), ['sea-trials', 'vgv-wingspan']);
  assert.deepEqual(parseClaudePluginList(''), []);
});

test('findExecutable scans PATH then ~/.local/bin', () => {
  const home = '/h';
  const env = { PATH: ['/a', '/b'].join(path.delimiter) };
  const exists = (p) => p === '/b/agent' || p === path.join(home, '.local', 'bin', 'claude');
  assert.equal(findExecutable('agent', { env, homeDir: home, exists }), '/b/agent');
  assert.equal(
    findExecutable('claude', { env, homeDir: home, exists }),
    path.join(home, '.local', 'bin', 'claude'),
  );
  assert.equal(findExecutable('nope', { env, homeDir: home, exists }), undefined);
  assert.equal(findExecutable('agent', { env: {}, homeDir: home, exists: () => false }), undefined);
});

test('collectMcpServers reads keys only from the three config files', () => {
  const home = '/h';
  const files = {
    [path.join(home, '.cursor', 'mcp.json')]: JSON.stringify({
      mcpServers: { 'macos-use': { command: 'x', env: { TOKEN: 'secret' } } },
    }),
    '/plugin/mcp.json': JSON.stringify({
      mcpServers: { 'chrome-devtools': {}, 'atlassian-seatrials': {} },
    }),
    [path.join(home, '.claude.json')]: 'not json at all',
  };
  const out = collectMcpServers({
    homeDir: home,
    pluginMcpPath: '/plugin/mcp.json',
    readFile: (p) => files[p] ?? '',
  });
  assert.deepEqual(out, {
    servers: ['atlassian-seatrials', 'chrome-devtools', 'macos-use'],
    sources: {
      cursorUser: ['macos-use'],
      plugin: ['atlassian-seatrials', 'chrome-devtools'],
      claudeUser: [],
    },
  });
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('coerceSetValue', () => {
  assert.equal(coerceSetValue('true'), true);
  assert.equal(coerceSetValue('false'), false);
  assert.equal(coerceSetValue('null'), null);
  assert.equal(coerceSetValue('unknown'), 'unknown');
  assert.equal(coerceSetValue('42'), 42);
  assert.deepEqual(coerceSetValue('["a","b"]'), ['a', 'b']);
  assert.equal(coerceSetValue('[broken'), '[broken');
  assert.equal(coerceSetValue(' composer-2.5 '), 'composer-2.5');
});

test('applySets writes dotted paths, rejects bad keys and prototype pollution', () => {
  const target = { tools: { askQuestion: 'unknown', notes: 'n' } };
  const { applied, rejected } = applySets(target, [
    'tools.askQuestion=true',
    'tools.askUserQuestion=false',
    'cursor.models=["inherit","composer-2.5"]',
    'nested.deep.key=7',
    'noequals',
    '=novalue',
    'bad key=1',
    '__proto__.polluted=1',
    'constructor.prototype.x=1',
    'a..b=1',
  ]);
  assert.deepEqual(applied, [
    'tools.askQuestion',
    'tools.askUserQuestion',
    'cursor.models',
    'nested.deep.key',
  ]);
  assert.equal(rejected.length, 6);
  assert.equal(target.tools.askQuestion, true);
  assert.equal(target.tools.askUserQuestion, false);
  assert.equal(target.tools.notes, 'n');
  assert.deepEqual(target.cursor.models, ['inherit', 'composer-2.5']);
  assert.equal(target.nested.deep.key, 7);
  assert.equal({}.polluted, undefined);
  assert.equal(Object.prototype.x, undefined);
});

test('isFresh', () => {
  const now = () => new Date('2026-09-22T12:00:00Z');
  assert.equal(isFresh(null, 1000, now), false);
  assert.equal(isFresh({}, 1000, now), false);
  assert.equal(isFresh({ probedAt: 'garbage' }, 1000, now), false);
  assert.equal(isFresh({ probedAt: '2026-09-22T11:59:59.500Z' }, 1000, now), true);
  assert.equal(isFresh({ probedAt: '2026-09-22T11:59:58Z' }, 1000, now), false);
});

// ---------------------------------------------------------------------------
// probe() with injected runner
// ---------------------------------------------------------------------------

test('probe: both CLIs present, agent lists models → verified cursor list', async () => {
  const home = tmpDir();
  const calls = [];
  const runner = fakeRunner(
    {
      'agent --version': '2026.06.04-5fd875e\n',
      'agent --list-models': 'composer-2.5\ncomposer-2.5-fast\ngpt-5.6-sol-medium\n',
      'claude --version': '2.1.247 (Claude Code)\n',
      'claude plugin list': '  ❯ sea-trials@mkt\n  ❯ vgv-wingspan@mkt\n',
    },
    calls,
  );
  const caps = await probe({
    env: { ...BASE_ENV, CURSOR_AGENT: '1', CURSOR_TRACE_ID: 't' },
    homeDir: home,
    runner,
    exists: fakeExists(home),
    now: () => new Date('2026-09-22T12:00:00Z'),
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
  });
  assert.equal(caps.version, 1);
  assert.equal(caps.probedAt, '2026-09-22T12:00:00.000Z');
  assert.equal(caps.host, 'cursor');
  assert.deepEqual(caps.hostEnv, ['CURSOR_AGENT', 'CURSOR_TRACE_ID']);
  assert.deepEqual(caps.cursor, {
    models: ['inherit', 'composer-2.5', 'composer-2.5-fast', 'gpt-5.6-sol-medium'],
    source: SOURCE_AGENT_LIST,
    verified: true,
    cliPath: path.join(home, '.local', 'bin', 'agent'),
    cliVersion: '2026.06.04-5fd875e',
  });
  assert.deepEqual(caps.claude, {
    models: [...STATIC_CLAUDE_MODELS],
    source: SOURCE_CLAUDE_ALIASES,
    verified: true,
    cliPath: path.join(home, '.local', 'bin', 'claude'),
    cliVersion: '2.1.247',
    pluginsInstalled: ['sea-trials', 'vgv-wingspan'],
  });
  assert.deepEqual(caps.tools, {
    askQuestion: 'unknown',
    askUserQuestion: 'unknown',
    notes: TOOLS_NOTE,
  });
  assert.deepEqual(caps.mcp.servers, []);
  assert.equal(calls.length, 4);
  for (const c of calls) assert.equal(c.opts.timeoutMs, CALL_TIMEOUT_MS);
  // No env values leak into the file.
  const text = JSON.stringify(caps);
  assert.ok(!text.includes('"t"'), 'CURSOR_TRACE_ID value must not be written');
  fs.rmSync(home, { recursive: true, force: true });
});

test('probe: agent says no models → static fallback with note', async () => {
  const home = tmpDir();
  const caps = await probe({
    env: { ...BASE_ENV, CLAUDECODE: '1' },
    homeDir: home,
    runner: fakeRunner({
      'agent --version': '2026.06.04-5fd875e',
      'agent --list-models': 'No models available for this account.\n',
      'claude --version': '2.1.247 (Claude Code)',
      'claude plugin list': '',
    }),
    exists: fakeExists(home),
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
  });
  assert.equal(caps.host, 'claude');
  assert.deepEqual(caps.cursor.models, [...STATIC_CURSOR_MODELS]);
  assert.equal(caps.cursor.source, SOURCE_STATIC);
  assert.equal(caps.cursor.verified, false);
  assert.match(caps.cursor.note, /No models available/);
  assert.equal(caps.cursor.cliVersion, '2026.06.04-5fd875e');
  assert.equal(caps.claude.verified, true);
  assert.equal(caps.claude.pluginsInstalled, undefined);
  fs.rmSync(home, { recursive: true, force: true });
});

test('probe: no CLIs installed → static fallback for both hosts', async () => {
  const home = tmpDir();
  const calls = [];
  const caps = await probe({
    env: BASE_ENV,
    homeDir: home,
    runner: fakeRunner({}, calls),
    exists: () => false,
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
  });
  assert.equal(calls.length, 0, 'nothing spawned when nothing is installed');
  assert.equal(caps.host, 'unknown');
  assert.deepEqual(caps.hostEnv, []);
  assert.deepEqual(caps.cursor, {
    models: [...STATIC_CURSOR_MODELS],
    source: SOURCE_STATIC,
    verified: false,
    note: 'agent CLI not installed',
  });
  assert.deepEqual(caps.claude, {
    models: [...STATIC_CLAUDE_MODELS],
    source: SOURCE_STATIC,
    verified: false,
    note: 'claude CLI not installed',
  });
  fs.rmSync(home, { recursive: true, force: true });
});

test('probe: runner timeouts / throws are best-effort', async () => {
  const home = tmpDir();
  const caps = await probe({
    env: BASE_ENV,
    homeDir: home,
    runner: async (cmd) => {
      if (path.basename(cmd) === 'claude') throw new Error('boom');
      return null; // timed out
    },
    exists: fakeExists(home),
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
  });
  assert.equal(caps.cursor.source, SOURCE_STATIC);
  assert.match(caps.cursor.note, /timed out/);
  assert.equal(caps.claude.source, SOURCE_STATIC);
  assert.equal(caps.claude.verified, false);
  assert.equal(caps.claude.cliPath, path.join(home, '.local', 'bin', 'claude'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('probe preserves tool observations from the previous file', async () => {
  const home = tmpDir();
  const caps = await probe({
    env: BASE_ENV,
    homeDir: home,
    runner: fakeRunner({}),
    exists: () => false,
    previous: { tools: { askQuestion: true, askUserQuestion: false, notes: 'old' } },
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
  });
  assert.equal(caps.tools.askQuestion, true);
  assert.equal(caps.tools.askUserQuestion, false);
  assert.equal(caps.tools.notes, TOOLS_NOTE);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runProbeCli — cache, force, --set
// ---------------------------------------------------------------------------

function cliOpts(home, runner, extra = {}) {
  return {
    env: { ...BASE_ENV, ST_STATE_DIR: path.join(home, 'state') },
    homeDir: home,
    runner,
    exists: () => false,
    pluginMcpPath: '/none/mcp.json',
    readFile: () => '',
    ...extra,
  };
}

test('runProbeCli: probes cold, then serves the cache, then --force', async () => {
  const home = tmpDir();
  const calls = [];
  const runner = fakeRunner({}, calls);
  let clock = Date.parse('2026-09-22T12:00:00Z');
  const now = () => new Date(clock);

  const first = await runProbeCli(parseArgs([]), cliOpts(home, runner, { now }));
  assert.equal(first.action, 'probed');
  assert.equal(first.file, path.join(home, 'state', 'host', 'capabilities.json'));
  assert.ok(fs.existsSync(first.file));

  clock += 60_000;
  const second = await runProbeCli(parseArgs([]), cliOpts(home, runner, { now }));
  assert.equal(second.action, 'cached');
  assert.equal(second.caps.probedAt, first.caps.probedAt);

  clock += DEFAULT_MAX_AGE_MS;
  const third = await runProbeCli(parseArgs([]), cliOpts(home, runner, { now }));
  assert.equal(third.action, 'probed', 'stale cache re-probes');

  const forced = await runProbeCli(parseArgs(['--force']), cliOpts(home, runner, { now }));
  assert.equal(forced.action, 'probed');

  const shortAge = await runProbeCli(
    parseArgs(['--max-age', '0']),
    cliOpts(home, runner, { now }),
  );
  assert.equal(shortAge.action, 'probed');
  fs.rmSync(home, { recursive: true, force: true });
});

test('runProbeCli: --set updates a fresh cache without re-probing', async () => {
  const home = tmpDir();
  const calls = [];
  const runner = fakeRunner({}, calls);
  const exists = fakeExists(home);
  await runProbeCli(parseArgs([]), cliOpts(home, runner, { exists }));
  const spawnedCold = calls.length;
  assert.ok(spawnedCold > 0);

  const r = await runProbeCli(
    parseArgs(['--set', 'tools.askQuestion=true', '--set', 'garbage']),
    cliOpts(home, runner, { exists }),
  );
  assert.equal(r.action, 'cached');
  assert.equal(calls.length, spawnedCold, 'no re-probe');
  assert.deepEqual(r.rejected, ['garbage']);
  assert.equal(r.caps.tools.askQuestion, true);
  assert.equal(typeof r.caps.updatedAt, 'string');
  const onDisk = JSON.parse(fs.readFileSync(r.file, 'utf8'));
  assert.equal(onDisk.tools.askQuestion, true, 'persisted');

  // A later re-probe keeps the observation.
  const again = await runProbeCli(parseArgs(['--force']), cliOpts(home, runner, { exists }));
  assert.equal(again.action, 'probed');
  assert.equal(again.caps.tools.askQuestion, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runProbeCli: corrupt cache file is replaced', async () => {
  const home = tmpDir();
  const file = path.join(home, 'state', 'host', 'capabilities.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{broken');
  const r = await runProbeCli(parseArgs([]), cliOpts(home, fakeRunner({})));
  assert.equal(r.action, 'probed');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Real process: exit code, quiet, timeouts, fake CLIs on PATH
// ---------------------------------------------------------------------------

function writeFakeCli(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function runCli(args, env) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: env.PATH ?? '/nonexistent', ...env },
    timeout: 20_000,
  });
}

test('CLI: --quiet prints nothing, exits 0, writes the file', () => {
  const home = tmpDir();
  const state = path.join(home, 'state');
  const started = Date.now();
  const r = runCli(['--quiet'], { HOME: home, ST_STATE_DIR: state });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
  const file = path.join(state, 'host', 'capabilities.json');
  const caps = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(caps.host, 'unknown');
  assert.equal(caps.cursor.source, SOURCE_STATIC, 'no CLIs on the fake PATH');
  assert.ok(elapsed < 10_000, `cold run took ${elapsed}ms`);

  const t2 = Date.now();
  const cached = runCli(['--quiet'], { HOME: home, ST_STATE_DIR: state });
  assert.equal(cached.status, 0);
  assert.ok(Date.now() - t2 < 3000, 'cached run is fast');
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI: --json prints the file; summary goes to stderr', () => {
  const home = tmpDir();
  const r = runCli(['--json'], { HOME: home, ST_STATE_DIR: path.join(home, 'state') });
  assert.equal(r.status, 0);
  const caps = JSON.parse(r.stdout);
  assert.equal(caps.version, 1);
  assert.match(r.stderr, /\[st-model-probe\] probed host=unknown/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI: fake agent/claude on PATH are discovered and parsed', () => {
  const home = tmpDir();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  writeFakeCli(
    bin,
    'agent',
    'case "$1" in\n' +
      '  --version) echo "2026.06.04-abc";;\n' +
      '  --list-models) printf "composer-2.5\\ncomposer-2.5-fast\\n";;\n' +
      'esac',
  );
  writeFakeCli(
    bin,
    'claude',
    'case "$1" in\n' +
      '  --version) echo "2.1.247 (Claude Code)";;\n' +
      '  plugin) printf "Installed plugins:\\n  > sea-trials@mkt\\n";;\n' +
      'esac',
  );
  const r = runCli(['--json', '--quiet'], {
    HOME: home,
    ST_STATE_DIR: path.join(home, 'state'),
    PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
    CURSOR_AGENT: '1',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  const caps = JSON.parse(r.stdout);
  assert.equal(caps.host, 'cursor');
  assert.deepEqual(caps.hostEnv, ['CURSOR_AGENT']);
  assert.equal(caps.cursor.cliPath, path.join(bin, 'agent'));
  assert.equal(caps.cursor.cliVersion, '2026.06.04-abc');
  assert.deepEqual(caps.cursor.models, ['inherit', 'composer-2.5', 'composer-2.5-fast']);
  assert.equal(caps.cursor.verified, true);
  assert.equal(caps.claude.cliVersion, '2.1.247');
  assert.deepEqual(caps.claude.pluginsInstalled, ['sea-trials']);
  fs.rmSync(home, { recursive: true, force: true });
});

test('CLI: a hanging CLI is killed at the timeout and the run still exits 0', () => {
  const home = tmpDir();
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  writeFakeCli(bin, 'agent', 'sleep 30');
  const started = Date.now();
  const r = runCli(['--json', '--quiet'], {
    HOME: home,
    ST_STATE_DIR: path.join(home, 'state'),
    PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
  });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 0);
  const caps = JSON.parse(r.stdout);
  assert.equal(caps.cursor.source, SOURCE_STATIC);
  assert.match(caps.cursor.note, /timed out/);
  assert.ok(elapsed < 10_000, `hung CLI must not block the hook (${elapsed}ms)`);
  fs.rmSync(home, { recursive: true, force: true });
});

test('defaultRunner: missing binary resolves null, never throws', async () => {
  const r = await defaultRunner('/definitely/not/here', [], {
    timeoutMs: 1000,
    env: BASE_ENV,
  });
  assert.equal(r, null);
});

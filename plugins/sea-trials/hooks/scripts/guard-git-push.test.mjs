import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, describe, test } from 'node:test';

import {
  MESSAGES,
  classifyPushFlags,
  decide,
  detectHost,
  extractCommand,
  fallbackFlagDeny,
  findPushInvocations,
  render,
  repoHasGate,
  splitSegments,
} from './guard-git-push.mjs';
import { writeGatePassToken } from '../../scripts/hooks/lib/gate-pass-token.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(here, 'guard-git-push.mjs');
const isWindows = process.platform === 'win32';

/** Env with every escape hatch and gate override cleared. */
const CLEAN_ENV = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !/^ST_(ALLOW_|PREPUSH_FORCE|REVIEW_PUSH)/.test(k),
  ),
);

const tmpDirs = [];
after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', shell: isWindows });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * @param {{ gate?: 'husky' | 'package' | false }} [opts]
 */
function makeRepo({ gate = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-guard-'));
  tmpDirs.push(dir);
  const root = fs.realpathSync(dir);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'guard@test']);
  git(root, ['config', 'user.name', 'guard']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  if (gate === 'husky') {
    fs.mkdirSync(path.join(root, '.husky'));
    fs.writeFileSync(path.join(root, '.husky', 'st-plugin-run.sh'), '#!/bin/sh\n');
  } else if (gate === 'package') {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ scripts: { 'pr-review-push': 'node x.mjs' } }),
    );
  }
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

function writeFreshToken(root) {
  const headOid = git(root, ['rev-parse', 'HEAD']);
  return writeGatePassToken(root, {
    headOid,
    phases: ['dirty', 'prepush', 'ci'],
    prNumber: 1,
  });
}

function runGuard(input, env = CLEAN_ENV) {
  const r = spawnSync(process.execPath, [GUARD], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const cursor = (command, cwd) => ({ command, ...(cwd ? { cwd } : {}) });
const claude = (command, cwd) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Bash',
  tool_input: { command },
  ...(cwd ? { cwd } : {}),
});

// ---------------------------------------------------------------------------

describe('splitSegments', () => {
  test('splits on control operators and drops empties', () => {
    assert.deepEqual(splitSegments('a && b || c ; d | e |& f\ng &'), [
      ['a'],
      ['b'],
      ['c'],
      ['d'],
      ['e'],
      ['f'],
      ['g'],
    ]);
  });

  test('keeps quoted operators inside a word', () => {
    assert.deepEqual(splitSegments(`bash -c "git push && echo hi"`), [
      ['bash', '-c', 'git push && echo hi'],
    ]);
    assert.deepEqual(splitSegments(`echo 'a;b' 'it'"'"'s'`), [
      ['echo', 'a;b', "it's"],
    ]);
  });

  test('handles backslash escapes and line continuations', () => {
    assert.deepEqual(splitSegments('git push origin \\\n  main a\\ b'), [
      ['git', 'push', 'origin', 'main', 'a b'],
    ]);
  });
});

describe('classifyPushFlags', () => {
  test('detects long and bundled short flags', () => {
    assert.deepEqual(classifyPushFlags(['--no-verify']), {
      noVerify: true,
      force: false,
    });
    assert.deepEqual(classifyPushFlags(['-n', 'origin']), {
      noVerify: true,
      force: false,
    });
    assert.deepEqual(classifyPushFlags(['--dry-run']), {
      noVerify: true,
      force: false,
    });
    assert.deepEqual(classifyPushFlags(['-uf', 'origin', 'main']), {
      noVerify: false,
      force: true,
    });
    assert.deepEqual(classifyPushFlags(['--force-with-lease=main:abc']), {
      noVerify: false,
      force: true,
    });
    assert.deepEqual(classifyPushFlags(['-nf']), {
      noVerify: true,
      force: true,
    });
  });

  test('ignores tokens after -- and negated flags', () => {
    assert.deepEqual(classifyPushFlags(['origin', '--', '--no-verify']), {
      noVerify: false,
      force: false,
    });
    assert.deepEqual(classifyPushFlags(['--no-force-with-lease']), {
      noVerify: false,
      force: false,
    });
  });
});

describe('findPushInvocations', () => {
  test('finds only git push segments', () => {
    assert.equal(findPushInvocations('git status && git log').length, 0);
    assert.equal(findPushInvocations('echo push').length, 0);
    assert.equal(findPushInvocations('git pull && git push').length, 1);
  });

  test('evaluates every push in a chain', () => {
    const pushes = findPushInvocations('git push origin a; git push -f origin b');
    assert.equal(pushes.length, 2);
    assert.equal(pushes[0].force, false);
    assert.equal(pushes[1].force, true);
  });

  test('handles -C, global options, env prefixes and wrappers', () => {
    const [p] = findPushInvocations(
      'FOO=1 BAR=x command git -C sub -c push.default=simple --no-pager push --no-verify',
    );
    assert.ok(p);
    assert.deepEqual(p.cDirs, ['sub']);
    assert.equal(p.noVerify, true);
    assert.equal(findPushInvocations('env -i A=1 exec git push')[0].cDirs.length, 0);
    assert.equal(findPushInvocations('/usr/bin/git push').length, 1);
    assert.equal(findPushInvocations('git.exe push').length, 1);
  });

  test('does not confuse a ref named push or -C without push', () => {
    assert.equal(findPushInvocations('git checkout push').length, 0);
    assert.equal(findPushInvocations('git -C sub status').length, 0);
  });

  test('looks inside sh -c and eval', () => {
    assert.equal(findPushInvocations(`bash -c "git push --no-verify"`)[0].noVerify, true);
    assert.equal(findPushInvocations(`sh -c 'cd x && git push'`).length, 1);
    assert.equal(findPushInvocations(`eval "git push -f"`)[0].force, true);
  });
});

describe('host detection and command extraction', () => {
  test('Cursor shape', () => {
    assert.equal(detectHost({ command: 'git push' }, {}), 'cursor');
    assert.equal(extractCommand({ command: 'git push' }), 'git push');
  });

  test('Claude shape', () => {
    const input = claude('git push');
    assert.equal(detectHost(input, {}), 'claude');
    assert.equal(extractCommand(input), 'git push');
  });

  test('falls back to env when the shape is ambiguous', () => {
    assert.equal(detectHost(null, { CLAUDE_PLUGIN_ROOT: '/x' }), 'claude');
    assert.equal(detectHost(null, {}), 'cursor');
    assert.equal(extractCommand(null), '');
    assert.equal(extractCommand({ tool_input: {} }), '');
  });
});

describe('repoHasGate', () => {
  test('husky marker', () => {
    assert.equal(repoHasGate(makeRepo({ gate: 'husky' })), true);
  });
  test('package.json script', () => {
    assert.equal(repoHasGate(makeRepo({ gate: 'package' })), true);
  });
  test('neither', () => {
    assert.equal(repoHasGate(makeRepo()), false);
  });
});

describe('decide', () => {
  test('non-push commands allow without touching git', async () => {
    assert.deepEqual(await decide(cursor('ls -la'), { env: CLEAN_ENV }), {
      permission: 'allow',
    });
    assert.deepEqual(await decide(null, { env: CLEAN_ENV }), { permission: 'allow' });
    assert.deepEqual(
      await decide(cursor('git status && pnpm pr-review-push -- --pr 5'), { env: CLEAN_ENV }),
      { permission: 'allow' },
    );
  });

  test('--no-verify / -n / --dry-run deny regardless of env or repo', async () => {
    for (const cmd of ['git push --no-verify', 'git push -n origin', 'git push --dry-run']) {
      const d = await decide(cursor(cmd, os.tmpdir()), {
        env: { ...CLEAN_ENV, ST_ALLOW_BARE_PUSH: '1', ST_ALLOW_FORCE_PUSH: '1' },
      });
      assert.equal(d.permission, 'deny', cmd);
      assert.equal(d.message, MESSAGES.noVerify);
    }
  });

  test('force denies unless ST_ALLOW_FORCE_PUSH=1', async () => {
    const root = makeRepo();
    for (const cmd of ['git push --force', 'git push -f', 'git push --force-with-lease origin x']) {
      const d = await decide(cursor(cmd, root), { env: CLEAN_ENV });
      assert.equal(d.permission, 'deny', cmd);
      assert.equal(d.message, MESSAGES.force);
    }
    const allowed = await decide(cursor('git push --force', root), {
      env: { ...CLEAN_ENV, ST_ALLOW_FORCE_PUSH: '1' },
    });
    assert.equal(allowed.permission, 'allow');
  });

  test('no-verify wins over force', async () => {
    const d = await decide(cursor('git push -nf'), { env: CLEAN_ENV });
    assert.equal(d.message, MESSAGES.noVerify);
  });

  test('bare push in a repo without the gate allows', async () => {
    const root = makeRepo();
    assert.equal((await decide(cursor('git push', root), { env: CLEAN_ENV })).permission, 'allow');
    assert.equal((await decide(claude('git push origin HEAD:main', root), { env: CLEAN_ENV })).permission, 'allow');
  });

  test('bare push outside any repo allows', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-guard-norepo-'));
    tmpDirs.push(dir);
    assert.equal((await decide(cursor('git push', dir), { env: CLEAN_ENV })).permission, 'allow');
    assert.equal(
      (await decide(cursor('git push', path.join(dir, 'missing')), { env: CLEAN_ENV })).permission,
      'allow',
    );
  });

  test('bare push in a gated repo without a token denies (both markers, both shapes)', async () => {
    for (const gate of ['husky', 'package']) {
      const root = makeRepo({ gate });
      for (const input of [cursor('git push', root), claude('git push origin main', root)]) {
        const d = await decide(input, { env: CLEAN_ENV });
        assert.equal(d.permission, 'deny', gate);
        assert.ok(d.message.startsWith(MESSAGES.barePush), d.message);
        assert.match(d.message, /no gate token/);
      }
    }
  });

  test('bare push in a gated repo with a fresh token allows', async () => {
    const root = makeRepo({ gate: 'husky' });
    writeFreshToken(root);
    const d = await decide(cursor('git push', root), { env: CLEAN_ENV });
    assert.equal(d.permission, 'allow');
    assert.match(d.note ?? '', /gate already passed/);
  });

  test('token for a different HEAD or a changed tree denies', async () => {
    const root = makeRepo({ gate: 'husky' });
    writeFreshToken(root);
    fs.writeFileSync(path.join(root, 'README.md'), 'changed\n');
    const changed = await decide(cursor('git push', root), { env: CLEAN_ENV });
    assert.equal(changed.permission, 'deny');
    assert.match(changed.message, /working tree changed/);

    git(root, ['commit', '-q', '-am', 'next']);
    const moved = await decide(cursor('git push', root), { env: CLEAN_ENV });
    assert.equal(moved.permission, 'deny');
    assert.match(moved.message, /different HEAD/);
  });

  test('stale token denies', async () => {
    const root = makeRepo({ gate: 'package' });
    const token = writeFreshToken(root);
    const file = path.join(root, '.git', 'st-push-gate-pass.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ ...token, at: new Date(Date.now() - 60 * 60 * 1000).toISOString() }),
    );
    const d = await decide(cursor('git push', root), { env: CLEAN_ENV });
    assert.equal(d.permission, 'deny');
    assert.match(d.message, /stale/);
  });

  test('token lacking the prepush phase denies', async () => {
    const root = makeRepo({ gate: 'husky' });
    writeGatePassToken(root, {
      headOid: git(root, ['rev-parse', 'HEAD']),
      phases: ['dirty'],
    });
    const d = await decide(cursor('git push', root), { env: CLEAN_ENV });
    assert.equal(d.permission, 'deny');
    assert.match(d.message, /lacks phase prepush/);
  });

  test('ST_ALLOW_BARE_PUSH=1 allows with a warning note', async () => {
    const root = makeRepo({ gate: 'husky' });
    const d = await decide(cursor('git push', root), {
      env: { ...CLEAN_ENV, ST_ALLOW_BARE_PUSH: '1' },
    });
    assert.equal(d.permission, 'allow');
    assert.match(d.note, /ST_ALLOW_BARE_PUSH/);
  });

  test('escape hatches also work as a VAR=1 prefix on the push segment', async () => {
    const root = makeRepo({ gate: 'husky' });
    const bare = await decide(cursor('ST_ALLOW_BARE_PUSH=1 git push', root), { env: CLEAN_ENV });
    assert.equal(bare.permission, 'allow');
    const viaEnv = await decide(cursor('env ST_ALLOW_FORCE_PUSH=1 git push --force', makeRepo()), {
      env: CLEAN_ENV,
    });
    assert.equal(viaEnv.permission, 'allow');

    // A prefix on a different segment does not vouch for the push.
    const other = await decide(cursor('ST_ALLOW_BARE_PUSH=1 true && git push', root), {
      env: CLEAN_ENV,
    });
    assert.equal(other.permission, 'deny');
    // Every push in a chain must carry it.
    const partial = await decide(
      cursor('ST_ALLOW_BARE_PUSH=1 git push && git push origin x', root),
      { env: CLEAN_ENV },
    );
    assert.equal(partial.permission, 'deny');
    // Nothing unlocks --no-verify.
    const nv = await decide(cursor('ST_ALLOW_BARE_PUSH=1 ST_ALLOW_FORCE_PUSH=1 git push -n', root), {
      env: CLEAN_ENV,
    });
    assert.equal(nv.permission, 'deny');
  });

  test('git -C resolves the gate relative to cwd; chained pushes each gated', async () => {
    const gated = makeRepo({ gate: 'husky' });
    const open = makeRepo();
    const rel = path.relative(open, gated);
    const viaC = await decide(cursor(`git -C ${JSON.stringify(rel)} push`, open), {
      env: CLEAN_ENV,
    });
    assert.equal(viaC.permission, 'deny');

    const chain = await decide(
      cursor(`git push && git -C ${JSON.stringify(gated)} push`, open),
      { env: CLEAN_ENV },
    );
    assert.equal(chain.permission, 'deny');

    const ok = await decide(cursor(`git -C ${JSON.stringify(open)} push`, gated), {
      env: CLEAN_ENV,
    });
    assert.equal(ok.permission, 'allow');
  });

  test('falls back to opts.cwd when input has no cwd', async () => {
    const root = makeRepo({ gate: 'husky' });
    const d = await decide(cursor('git push'), { env: CLEAN_ENV, cwd: root });
    assert.equal(d.permission, 'deny');
  });
});

describe('render', () => {
  test('Cursor deny: JSON with messages, exit 0', () => {
    const out = render('cursor', { permission: 'deny', message: 'm' });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(JSON.parse(out.stdout), {
      permission: 'deny',
      user_message: 'm',
      agent_message: 'm',
    });
  });

  test('Cursor allow: JSON allow, note on stderr', () => {
    const out = render('cursor', { permission: 'allow', note: 'n' });
    assert.equal(out.exitCode, 0);
    assert.deepEqual(JSON.parse(out.stdout), { permission: 'allow' });
    assert.equal(out.stderr, 'n\n');
  });

  test('Claude deny: hookSpecificOutput + exit 2 + reason on stderr', () => {
    const out = render('claude', { permission: 'deny', message: 'm' });
    assert.equal(out.exitCode, 2);
    assert.deepEqual(JSON.parse(out.stdout), {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'm',
      },
    });
    assert.equal(out.stderr, 'm\n');
  });

  test('Claude allow: silent exit 0', () => {
    const out = render('claude', { permission: 'allow' });
    assert.deepEqual(out, { stdout: '', stderr: '', exitCode: 0 });
  });
});

describe('fallbackFlagDeny', () => {
  test('denies bypass flags from raw text', () => {
    assert.equal(fallbackFlagDeny('{"command":"git push --no-verify"}')?.message, MESSAGES.noVerify);
    assert.equal(fallbackFlagDeny('{"command":"git push -f"}')?.message, MESSAGES.force);
    assert.equal(fallbackFlagDeny('{"command":"git push"}'), null);
    assert.equal(fallbackFlagDeny('{"command":"ls -n"}'), null);
  });
});

describe('CLI end to end', () => {
  test('Cursor shape: allow and deny', () => {
    const allow = runGuard(cursor('ls'));
    assert.equal(allow.status, 0);
    assert.deepEqual(JSON.parse(allow.stdout), { permission: 'allow' });

    const deny = runGuard(cursor('git push --no-verify'));
    assert.equal(deny.status, 0);
    assert.equal(JSON.parse(deny.stdout).permission, 'deny');
    assert.equal(JSON.parse(deny.stdout).user_message, MESSAGES.noVerify);
  });

  test('Claude shape: allow is silent, deny exits 2', () => {
    const allow = runGuard(claude('ls'));
    assert.deepEqual(allow, { status: 0, stdout: '', stderr: '' });

    const deny = runGuard(claude('git push --force'));
    assert.equal(deny.status, 2);
    assert.equal(
      JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision,
      'deny',
    );
    assert.match(deny.stderr, /force push is blocked/);
  });

  test('gated repo via CLI, both shapes', () => {
    const root = makeRepo({ gate: 'husky' });
    assert.equal(JSON.parse(runGuard(cursor('git push', root)).stdout).permission, 'deny');
    assert.equal(runGuard(claude('git push', root)).status, 2);
    writeFreshToken(root);
    assert.equal(JSON.parse(runGuard(cursor('git push', root)).stdout).permission, 'allow');
    assert.equal(runGuard(claude('git push', root)).status, 0);
  });

  test('garbage stdin never crashes: allows, unless a bypass flag is visible', () => {
    const empty = runGuard('');
    assert.equal(empty.status, 0);
    assert.deepEqual(JSON.parse(empty.stdout), { permission: 'allow' });

    const junk = runGuard('not json at all');
    assert.equal(junk.status, 0);
    assert.deepEqual(JSON.parse(junk.stdout), { permission: 'allow' });
  });

  test('bash shim delegates to the guard', { skip: isWindows }, () => {
    const r = spawnSync('bash', [path.join(here, 'deny-no-verify-push.sh')], {
      input: JSON.stringify(cursor('git push -n')),
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).permission, 'deny');
  });

  test('session-start hook is silent and exits 0', () => {
    const r = spawnSync(process.execPath, [path.join(here, 'session-start.mjs')], {
      encoding: 'utf8',
      env: CLEAN_ENV,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
});

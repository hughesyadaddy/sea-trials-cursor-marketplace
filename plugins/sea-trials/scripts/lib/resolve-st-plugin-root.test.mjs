import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  cacheCandidates,
  newestRoot,
  resolveStPluginRoot,
} from './resolve-st-plugin-root.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const marker = 'scripts/resolve-plugin-root.mjs';

/** @type {string[]} */
const tmpDirs = [];

/** @returns {string} fresh temp HOME */
function makeHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-root-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {number} mtimeSec
 * @returns {string}
 */
function makePlugin(root, mtimeSec) {
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  const file = path.join(root, marker);
  fs.writeFileSync(file, '// marker\n');
  fs.utimesSync(file, mtimeSec, mtimeSec);
  return root;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveStPluginRoot', () => {
  it('prefers ST_PLUGIN_ROOT over everything', () => {
    const home = makeHome();
    const envRoot = makePlugin(path.join(home, 'env-root'), 1000);
    makePlugin(
      path.join(home, '.cursor/plugins/cache/__DEFAULT__/sea-trials/abc'),
      9000,
    );
    const result = resolveStPluginRoot({
      env: { ST_PLUGIN_ROOT: envRoot },
      homeDir: home,
      skipRepo: true,
      selfRoot: null,
    });
    assert.equal(result, envRoot);
  });

  it('throws when ST_PLUGIN_ROOT lacks the marker', () => {
    const home = makeHome();
    assert.throws(
      () =>
        resolveStPluginRoot({
          env: { ST_PLUGIN_ROOT: path.join(home, 'nope') },
          homeDir: home,
          skipRepo: true,
          selfRoot: null,
        }),
      /ST_PLUGIN_ROOT is set but missing/,
    );
  });

  it('accepts CLAUDE_PLUGIN_ROOT when it is this plugin', () => {
    const home = makeHome();
    const claudeRoot = makePlugin(path.join(home, 'claude-root'), 1000);
    const result = resolveStPluginRoot({
      env: { CLAUDE_PLUGIN_ROOT: claudeRoot },
      homeDir: home,
      skipRepo: true,
      selfRoot: null,
    });
    assert.equal(result, claudeRoot);
  });

  it('ignores CLAUDE_PLUGIN_ROOT pointing at another plugin', () => {
    const home = makeHome();
    const other = path.join(home, 'other-plugin');
    fs.mkdirSync(other, { recursive: true });
    const cached = makePlugin(
      path.join(home, '.claude/plugins/cache/mk/sea-trials/2026.09.22'),
      2000,
    );
    const result = resolveStPluginRoot({
      env: { CLAUDE_PLUGIN_ROOT: other },
      homeDir: home,
      skipRepo: true,
      selfRoot: null,
    });
    assert.equal(result, cached);
  });

  it('finds Cursor and Claude caches and picks the newest', () => {
    const home = makeHome();
    const cursorOld = makePlugin(
      path.join(home, '.cursor/plugins/cache/__DEFAULT__/sea-trials/aaa'),
      1000,
    );
    const claudeNew = makePlugin(
      path.join(home, '.claude/plugins/cache/mk/sea-trials/2026.09.22'),
      3000,
    );
    const marketplaceMid = makePlugin(
      path.join(home, '.claude/plugins/marketplaces/mk/plugins/sea-trials'),
      2000,
    );
    const candidates = cacheCandidates(home);
    assert.deepEqual(
      new Set(candidates),
      new Set([cursorOld, claudeNew, marketplaceMid]),
    );
    assert.equal(newestRoot(candidates), claudeNew);
    const result = resolveStPluginRoot({
      env: {},
      homeDir: home,
      skipRepo: true,
      selfRoot: null,
    });
    assert.equal(result, claudeNew);
  });

  it('reads installPath from installed_plugins.json', () => {
    const home = makeHome();
    const installed = makePlugin(path.join(home, 'custom/install'), 5000);
    fs.mkdirSync(path.join(home, '.claude/plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.claude/plugins/installed_plugins.json'),
      JSON.stringify({
        version: 2,
        plugins: {
          'sea-trials@sea-trials-claude-marketplace': [
            { scope: 'user', installPath: installed },
          ],
          'vgv-wingspan@x': [{ installPath: path.join(home, 'nowhere') }],
        },
      }),
    );
    assert.deepEqual(cacheCandidates(home), [installed]);
  });

  it('falls back to the self root when no cache exists', () => {
    const home = makeHome();
    const self = makePlugin(path.join(home, 'dev-checkout'), 1000);
    const result = resolveStPluginRoot({
      env: {},
      homeDir: home,
      skipRepo: true,
      selfRoot: self,
    });
    assert.equal(result, self);
  });

  it('throws a helpful error when nothing resolves', () => {
    const home = makeHome();
    assert.throws(
      () =>
        resolveStPluginRoot({
          env: {},
          homeDir: home,
          skipRepo: true,
          selfRoot: null,
        }),
      /Sea Trials plugin not found/,
    );
  });

  it('honours a temp HOME in a subprocess (default options)', () => {
    const home = makeHome();
    const cached = makePlugin(
      path.join(home, '.cursor/plugins/cache/mk/sea-trials/sha'),
      1000,
    );
    const script = [
      `import { resolveStPluginRoot } from ${JSON.stringify(
        path.join(here, 'resolve-st-plugin-root.mjs'),
      )};`,
      'console.log(resolveStPluginRoot({ skipRepo: true, selfRoot: null }));',
    ].join('\n');
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        encoding: 'utf8',
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), cached);
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  banner,
  parseArgs,
  renderCopy,
  sharedRel,
  skillsRel,
  sourcesDirName,
  syncSkillSources,
} from './sync-skill-sources.mjs';

const script = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'sync-skill-sources.mjs',
);

/** @type {string[]} */
const tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Build a marketplace fixture with two sources and three skills.
 *
 * @returns {{ root: string, skillsDir: string, sourcesDir: string }}
 */
function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sync-'));
  tmpDirs.push(root);
  const skillsDir = path.join(root, skillsRel);
  const sourcesDir = path.join(skillsDir, sourcesDirName);
  fs.mkdirSync(sourcesDir, { recursive: true });
  fs.writeFileSync(path.join(sourcesDir, 'contract.md'), '# Contract\n\nA\n');
  fs.writeFileSync(path.join(sourcesDir, 'body.md'), '# Body\n');
  fs.writeFileSync(path.join(sourcesDir, 'notes.txt'), 'ignored\n');
  for (const skill of ['st-a', 'st-b', 'st-c']) {
    fs.mkdirSync(path.join(skillsDir, skill), { recursive: true });
    fs.writeFileSync(path.join(skillsDir, skill, 'SKILL.md'), '---\n---\n');
  }
  fs.mkdirSync(path.join(skillsDir, 'not-a-skill'));
  return { root, skillsDir, sourcesDir };
}

/**
 * @param {string} skillsDir
 * @param {string} skill
 * @param {string} name
 * @returns {string} absolute path of a skill's shared copy
 */
function copyPath(skillsDir, skill, name) {
  return path.join(skillsDir, skill, sharedRel, name);
}

/**
 * @param {string} skillsDir
 * @param {string} skill
 * @param {string} name
 */
function readCopy(skillsDir, skill, name) {
  return fs.readFileSync(copyPath(skillsDir, skill, name), 'utf8');
}

/**
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runCli(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

describe('sync-skill-sources', () => {
  it('renders the generated banner before the source text', () => {
    const text = renderCopy('contract.md', '# X\n');
    assert.ok(
      text.startsWith('<!-- GENERATED from skills/_sources/contract.md'),
    );
    assert.ok(text.includes('node scripts/sync-skill-sources.mjs -->\n# X\n'));
    assert.equal(text, banner('contract.md') + '# X\n');
  });

  it('copies every .md source into every st-* skill', () => {
    const { root, skillsDir } = makeFixture();
    const result = syncSkillSources({ root });
    assert.deepEqual(result.sources, ['body.md', 'contract.md']);
    assert.equal(result.written.length, 6);
    assert.equal(result.stale.length, 0);
    assert.equal(
      readCopy(skillsDir, 'st-c', 'contract.md'),
      renderCopy('contract.md', '# Contract\n\nA\n'),
    );
    assert.equal(
      readCopy(skillsDir, 'st-a', 'body.md'),
      renderCopy('body.md', '# Body\n'),
    );
    assert.ok(!fs.existsSync(path.join(skillsDir, 'not-a-skill', sharedRel)));
    assert.ok(!fs.existsSync(copyPath(skillsDir, 'st-a', 'notes.txt')));
  });

  it('is idempotent and --check passes after a sync', () => {
    const { root } = makeFixture();
    syncSkillSources({ root });
    const second = syncSkillSources({ root });
    assert.equal(second.written.length, 0);
    assert.equal(second.upToDate.length, 6);
    const check = syncSkillSources({ root, check: true });
    assert.equal(check.stale.length, 0);
  });

  it('--check reports drifted and missing copies without writing', () => {
    const { root, skillsDir } = makeFixture();
    syncSkillSources({ root });
    const drifted = copyPath(skillsDir, 'st-b', 'contract.md');
    const removed = copyPath(skillsDir, 'st-c', 'body.md');
    fs.appendFileSync(drifted, 'local edit\n');
    fs.rmSync(removed);

    const check = syncSkillSources({ root, check: true });
    assert.deepEqual(
      check.stale.sort(),
      [path.relative(root, drifted), path.relative(root, removed)].sort(),
    );
    assert.ok(fs.readFileSync(drifted, 'utf8').endsWith('local edit\n'));
    assert.ok(!fs.existsSync(removed));
  });

  it('rewrites drifted copies on a plain run', () => {
    const { root, skillsDir } = makeFixture();
    syncSkillSources({ root });
    const drifted = copyPath(skillsDir, 'st-a', 'body.md');
    fs.writeFileSync(drifted, 'garbage\n');
    const result = syncSkillSources({ root });
    assert.deepEqual(result.written, [path.relative(root, drifted)]);
    assert.equal(
      readCopy(skillsDir, 'st-a', 'body.md'),
      renderCopy('body.md', '# Body\n'),
    );
  });

  it('throws when no sources exist', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-sync-empty-'));
    tmpDirs.push(root);
    assert.throws(() => syncSkillSources({ root }), /no sources found/);
  });

  it('parses --check and --root', () => {
    assert.deepEqual(parseArgs([]), { check: false, root: undefined });
    assert.deepEqual(parseArgs(['--check']), { check: true, root: undefined });
    assert.deepEqual(parseArgs(['--root', '/x']), { check: false, root: '/x' });
    assert.deepEqual(parseArgs(['--root=/y', '--check']), {
      check: true,
      root: '/y',
    });
    assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  });

  it('CLI --check exits 1 listing stale copies, 0 when clean', () => {
    const { root, skillsDir } = makeFixture();
    const stale = runCli(['--check', '--root', root]);
    assert.equal(stale.status, 1);
    assert.match(stale.stderr, /stale copies/);
    assert.match(stale.stderr, /st-a\/references\/shared\/contract\.md/);

    const apply = runCli(['--root', root]);
    assert.equal(apply.status, 0, apply.stderr);
    assert.match(apply.stdout, /6 written, 0 unchanged/);
    assert.ok(fs.existsSync(copyPath(skillsDir, 'st-b', 'body.md')));

    const clean = runCli(['--check', '--root', root]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /6 copies up to date/);
  });
});

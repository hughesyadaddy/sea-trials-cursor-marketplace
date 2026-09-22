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
  referencedSources,
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
 * Build a marketplace fixture with two sources and four skills.
 *
 * st-a links both sources (one from SKILL.md, one from a reference file),
 * st-b and st-c link only contract.md, st-d links nothing. Expected copies
 * after a sync: 4 (a×2, b, c).
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
  const link = (name) => `See [x](references/shared/${name}).\n`;
  for (const skill of ['st-a', 'st-b', 'st-c', 'st-d']) {
    fs.mkdirSync(path.join(skillsDir, skill, 'references'), {
      recursive: true,
    });
    const body = skill === 'st-d' ? '' : link('contract.md');
    fs.writeFileSync(
      path.join(skillsDir, skill, 'SKILL.md'),
      `---\n---\n${body}`,
    );
  }
  fs.writeFileSync(
    path.join(skillsDir, 'st-a', 'references', 'extra.md'),
    `Also [body](shared/body.md)\n`,
  );
  fs.mkdirSync(path.join(skillsDir, 'not-a-skill'));
  fs.writeFileSync(
    path.join(skillsDir, 'not-a-skill', 'SKILL.md'),
    link('contract.md'),
  );
  return { root, skillsDir, sourcesDir };
}

const expectedCopies = 4;

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

  it('copies each .md source only into the st-* skills that link it', () => {
    const { root, skillsDir } = makeFixture();
    const result = syncSkillSources({ root });
    assert.deepEqual(result.sources, ['body.md', 'contract.md']);
    assert.equal(result.written.length, expectedCopies);
    assert.equal(result.stale.length, 0);
    assert.equal(
      readCopy(skillsDir, 'st-c', 'contract.md'),
      renderCopy('contract.md', '# Contract\n\nA\n'),
    );
    // Linked from a reference file, not SKILL.md.
    assert.equal(
      readCopy(skillsDir, 'st-a', 'body.md'),
      renderCopy('body.md', '# Body\n'),
    );
    // Unlinked source and unlinking skill get nothing.
    assert.ok(!fs.existsSync(copyPath(skillsDir, 'st-b', 'body.md')));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'st-d', sharedRel)));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'not-a-skill', sharedRel)));
    assert.ok(!fs.existsSync(copyPath(skillsDir, 'st-a', 'notes.txt')));
  });

  it('reports referenced sources per skill', () => {
    const { skillsDir } = makeFixture();
    const sources = ['body.md', 'contract.md'];
    assert.deepEqual(
      [...referencedSources(path.join(skillsDir, 'st-a'), sources)].sort(),
      sources,
    );
    assert.deepEqual(
      [...referencedSources(path.join(skillsDir, 'st-d'), sources)],
      [],
    );
  });

  it('is idempotent and --check passes after a sync', () => {
    const { root } = makeFixture();
    syncSkillSources({ root });
    const second = syncSkillSources({ root });
    assert.equal(second.written.length, 0);
    assert.equal(second.removed.length, 0);
    assert.equal(second.upToDate.length, expectedCopies);
    const check = syncSkillSources({ root, check: true });
    assert.equal(check.stale.length, 0);
  });

  it('flags orphan copies in --check and deletes them on a plain run', () => {
    const { root, skillsDir } = makeFixture();
    syncSkillSources({ root });
    const orphan = copyPath(skillsDir, 'st-d', 'contract.md');
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'stale copy nobody links\n');
    // A file that is not a known source is left alone.
    const foreign = copyPath(skillsDir, 'st-d', 'foreign.md');
    fs.writeFileSync(foreign, 'keep\n');

    const check = syncSkillSources({ root, check: true });
    assert.deepEqual(check.stale, [path.relative(root, orphan)]);
    assert.ok(fs.existsSync(orphan));

    const apply = syncSkillSources({ root });
    assert.deepEqual(apply.removed, [path.relative(root, orphan)]);
    assert.ok(!fs.existsSync(orphan));
    assert.ok(fs.existsSync(foreign));
  });

  it('removes the copy when a skill drops its link', () => {
    const { root, skillsDir } = makeFixture();
    syncSkillSources({ root });
    fs.writeFileSync(path.join(skillsDir, 'st-c', 'SKILL.md'), '---\n---\n');
    const apply = syncSkillSources({ root });
    assert.deepEqual(apply.removed, [
      path.relative(root, copyPath(skillsDir, 'st-c', 'contract.md')),
    ]);
    // Empty shared dir is pruned.
    assert.ok(!fs.existsSync(path.join(skillsDir, 'st-c', sharedRel)));
  });

  it('--check reports drifted and missing copies without writing', () => {
    const { root, skillsDir } = makeFixture();
    syncSkillSources({ root });
    const drifted = copyPath(skillsDir, 'st-b', 'contract.md');
    const removed = copyPath(skillsDir, 'st-a', 'body.md');
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
    assert.match(apply.stdout, /4 written, 0 removed, 0 unchanged/);
    assert.ok(fs.existsSync(copyPath(skillsDir, 'st-b', 'contract.md')));

    const clean = runCli(['--check', '--root', root]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /4 copies up to date/);
  });
});

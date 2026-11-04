import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  changedPaths,
  checkPromotionDiff,
  pathsFromNameStatus,
  runSelfTest,
  violation,
} from './forbid-promotion-migrations.mjs';

const SAMPLE_POLICY = {
  version: 1,
  forbiddenNamePattern:
    '(xmedia|question_explanations?(_|\\.|$)|rich_content|reference_rag)',
  denylist: ['20261013002842_question_explanations_xmedia.sql'],
  forbiddenPrefixes: ['scripts/reference_rag/'],
  sqlDirs: ['supabase/migrations/', 'supabase/templates/'],
};

test('runSelfTest passes', () => {
  assert.equal(runSelfTest(), 0);
});

test('pure deletion is ignored in name-status parsing', () => {
  const line =
    'D\tsupabase/migrations/20261013002842_question_explanations_xmedia.sql';
  assert.deepEqual(pathsFromNameStatus(line), []);
});

test('rename includes source and destination paths', () => {
  const text =
    'R100\tsupabase/migrations/20261013002842_question_explanations_xmedia.sql' +
    '\tsupabase/migrations/20261013120000_dedupe_anchor_threads.sql\n';
  const paths = pathsFromNameStatus(text);
  assert.ok(
    paths.includes(
      'supabase/migrations/20261013002842_question_explanations_xmedia.sql',
    ),
  );
  assert.ok(
    paths.includes('supabase/migrations/20261013120000_dedupe_anchor_threads.sql'),
  );
});

test('rename source still violates even when dest is innocent', () => {
  const src =
    'supabase/migrations/20261013002842_question_explanations_xmedia.sql';
  const dest = 'supabase/migrations/20261013120000_dedupe_anchor_threads.sql';
  assert.ok(violation(src, SAMPLE_POLICY));
  assert.equal(violation(dest, SAMPLE_POLICY), null);
});

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forbid-promo-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const write = (name, body) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    git('add', '-A');
  };
  const commit = (msg) => {
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('git diff integration flags added forbidden migration', () => {
  const r = makeRepo();
  try {
    r.write('supabase/migrations/20261013120000_ok.sql', '-- ok\n');
    const base = r.commit('base');
    r.write(
      'supabase/migrations/20261013002842_question_explanations_xmedia.sql',
      '-- bad\n',
    );
    const head = r.commit('add forbidden');
    const paths = changedPaths(base, head, { cwd: r.dir });
    assert.ok(
      paths.includes(
        'supabase/migrations/20261013002842_question_explanations_xmedia.sql',
      ),
    );
    const result = checkPromotionDiff(base, head, SAMPLE_POLICY, { cwd: r.dir });
    assert.equal(result.ok, false);
  } finally {
    r.cleanup();
  }
});

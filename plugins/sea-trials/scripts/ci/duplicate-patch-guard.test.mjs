import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import {
  EXEMPT_ACTORS,
  PATCH_ID_WINDOW,
  countCommits,
  findDuplicatePatches,
  formatFindings,
  normalizeDiffLine,
  normalizedDiffDigest,
  parsePatchIdOutput,
  rangeHitsShallowBoundary,
  shouldRunGuard,
} from './duplicate-patch-guard.mjs';

/**
 * Real git repository. Conflicts, patch equality and empty diffs are all
 * decided by git here — a mock would only assert what the test author
 * already believed.
 */
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-patch-'));
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    assert.equal(r.status, 0, `git ${args.join(' ')}\n${r.stderr}`);
    return (r.stdout ?? '').trim();
  };
  git('init', '-q', '-b', 'dev');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  const write = (name, body) => {
    fs.writeFileSync(path.join(dir, name), body);
    git('add', '-A');
  };
  const commit = (msg) => {
    git('commit', '-qm', msg);
    return git('rev-parse', 'HEAD');
  };
  return { dir, git, write, commit, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('a cherry-picked trunk commit is detected', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.write('fix.txt', 'the fix\n');
    const trunkFix = r.commit('fix: the trunk fix');

    // Branch from BEFORE the fix, add divergent work, then cherry-pick —
    // the exact shape that produced five SHAs of one commit here. The
    // divergent commit matters: cherry-picking a tip onto its own parent
    // recreates a byte-identical commit, so there would be no second SHA.
    r.git('checkout', '-q', '-b', 'feature', 'HEAD~1');
    r.write('branch.txt', 'branch work\n');
    r.commit('feat: unrelated branch work');
    r.git('cherry-pick', trunkFix);

    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    assert.equal(findings.length, 1);
    assert.equal(findings[0].trunkCommit, trunkFix);
    assert.notEqual(findings[0].commit, trunkFix, 'a different SHA is the point');
  } finally {
    r.cleanup();
  }
});

test('a revert is not a duplicate', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.write('feature.txt', 'feature\n');
    const target = r.commit('feat: add it');
    r.git('checkout', '-q', '-b', 'feature');
    r.git('revert', '--no-edit', target);

    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    // A revert's diff is the inverse, so its patch-id differs. Subject
    // matching would have fired here: `Revert "..."` repeats 4x on dev.
    assert.deepEqual(findings, []);
  } finally {
    r.cleanup();
  }
});

test('an empty commit is never a duplicate', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.git('checkout', '-q', '-b', 'feature');
    r.git('commit', '-q', '--allow-empty', '-m', 'chore: empty one');
    r.git('commit', '-q', '--allow-empty', '-m', 'chore: empty two');

    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    // Empty diffs produce no patch-id at all. Treating "no patch-id" as a
    // wildcard would make every empty commit collide with every other.
    assert.deepEqual(findings, []);
  } finally {
    r.cleanup();
  }
});

test('a merge commit is not inspected', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('feature.txt', 'feature\n');
    r.commit('feat: branch work');
    r.git('checkout', '-q', 'dev');
    r.write('trunk.txt', 'trunk\n');
    r.commit('feat: trunk work');
    r.git('checkout', '-q', 'feature');
    r.git('merge', '--no-edit', 'dev');

    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    // Merging the trunk in is the sanctioned behaviour this guard exists
    // to encourage. It must never be what the guard punishes.
    assert.deepEqual(findings, []);
  } finally {
    r.cleanup();
  }
});

test('the guard survives a diff larger than Node default maxBuffer', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');

    // >1 MB of diff on the trunk. A buffered implementation dies with
    // ENOBUFS here; only a streamed `git log -p | git patch-id` passes.
    // This is the guard's own origin story: the maxBuffer/ENOBUFS fix is
    // the most-duplicated commit in the repo.
    const big = `${'x'.repeat(64)}\n`.repeat(20000);
    r.write('big.txt', big);
    r.commit('feat: a large file');
    r.write('fix.txt', 'the fix\n');
    const trunkFix = r.commit('fix: the trunk fix');

    r.git('checkout', '-q', '-b', 'feature', 'HEAD~1');
    r.write('branch.txt', 'branch work\n');
    r.commit('feat: unrelated branch work');
    r.git('cherry-pick', trunkFix);

    const bytes = spawnSync('git', ['log', '--no-merges', '-p', 'dev'], {
      cwd: r.dir,
      maxBuffer: 64 * 1024 * 1024,
    }).stdout.length;
    assert.ok(bytes > 1024 * 1024, `fixture diff must exceed 1 MB, got ${bytes}`);

    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    assert.equal(findings.length, 1, 'the planted duplicate is still found');
    assert.equal(findings[0].trunkCommit, trunkFix);
  } finally {
    r.cleanup();
  }
});

test('the window bounds how far back the trunk is read', async () => {
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.write('fix.txt', 'the fix\n');
    const trunkFix = r.commit('fix: the trunk fix');
    for (let i = 0; i < 5; i += 1) {
      r.write(`filler${i}.txt`, `filler ${i}\n`);
      r.commit(`chore: filler ${i}`);
    }
    r.git('checkout', '-q', '-b', 'feature', `${trunkFix}~1`);
    r.write('branch.txt', 'branch work\n');
    r.commit('feat: unrelated branch work');
    r.git('cherry-pick', trunkFix);

    const { findings: outside } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      window: 2,
      cwd: r.dir,
    });
    assert.deepEqual(outside, [], 'a window of 2 cannot see the older fix');

    const { findings: inside } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      window: 50,
      cwd: r.dir,
    });
    assert.equal(inside.length, 1, 'a wide enough window sees it');
  } finally {
    r.cleanup();
  }
});

test('the guard only runs for PRs landing on the trunk', () => {
  // Every commit in main..stg carries a patch already on dev, so running
  // on a promotion PR would fail the release train on all of them.
  assert.equal(shouldRunGuard({ baseRef: 'dev', actor: 'someone' }).run, true);
  assert.equal(shouldRunGuard({ baseRef: 'main', actor: 'someone' }).run, false);
  assert.equal(shouldRunGuard({ baseRef: 'stg', actor: 'someone' }).run, false);
});

test('dependabot is exempt by actor and by head branch', () => {
  for (const actor of EXEMPT_ACTORS) {
    assert.equal(shouldRunGuard({ baseRef: 'dev', actor }).run, false, actor);
  }
  assert.equal(
    shouldRunGuard({
      baseRef: 'dev',
      actor: 'someone',
      headRef: 'dependabot/npm_and_yarn/functions/x',
    }).run,
    false,
  );
  // A bot cannot apply the escape-hatch label, and a grouped bump can
  // legitimately repeat a patch after a downgrade-then-rebump.
});

test('parsePatchIdOutput ignores blank and malformed lines', () => {
  const map = parsePatchIdOutput('abc123 def456\n\n  \ngarbage\nfff111 000222\n');
  assert.deepEqual([...map.entries()], [
    ['abc123', ['def456']],
    ['fff111', ['000222']],
  ]);
});

test('formatFindings says whether it blocks, and stays quiet when clean', () => {
  assert.match(formatFindings([]), /No cherry-picked trunk commits/);
  const body = formatFindings(
    [{ commit: 'a'.repeat(40), patchId: 'b'.repeat(40), trunkCommit: 'c'.repeat(40) }],
    { failing: false },
  );
  assert.match(body, /is reported, not enforced/);
  assert.match(body, /Merge `dev` instead of cherry-picking/);
});

test('the default window is bounded, not the whole history', () => {
  // Unbounded would mean 403 MB of diff and a 12s read on this repo.
  assert.ok(PATCH_ID_WINDOW > 0 && PATCH_ID_WINDOW <= 5000);
});

test('an unreadable trunk throws instead of reporting no duplicates', async () => {
  // The worst failure this guard can have: `git log` dies on a missing
  // ref, `git patch-id` reads empty stdin and exits 0, and the run reports
  // a clean bill of health having read nothing. That is a false skip
  // wearing a positive result — the exact class the PR-checks audit closed
  // 16 instances of.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    await assert.rejects(
      () =>
        findDuplicatePatches({
          baseRange: 'origin/definitely-missing',
          prRange: 'dev',
          cwd: r.dir,
        }),
      /git log .* exited/,
    );
  } finally {
    r.cleanup();
  }
});

test('a commit is never flagged as a duplicate of itself', async () => {
  // With overlapping ranges the same commit appears on both sides. Without
  // the self-exclusion every PR would flag its own commits.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.write('fix.txt', 'the fix\n');
    r.commit('fix: the trunk fix');
    const { findings } = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev',
      cwd: r.dir,
    });
    assert.deepEqual(findings, []);
  } finally {
    r.cleanup();
  }
});

test('every commit sharing a patch-id is retained, in order', () => {
  // Keeping only a representative meant that when the representative
  // failed the whitespace-confirmation digest, a byte-identical older
  // commit behind it was never checked — the confirmation step created
  // its own false negative. Order is stable so reports stay reproducible.
  const map = parsePatchIdOutput('same111 first222\nsame111 second333\nsame111 first222\n');
  assert.deepEqual(map.get('same111'), ['first222', 'second333']);
  assert.equal(map.size, 1);
});

test('formatFindings states that it blocks when enforcing', () => {
  const body = formatFindings(
    [{ commit: 'a'.repeat(40), patchId: 'b'.repeat(40), trunkCommit: 'c'.repeat(40) }],
    { failing: true },
  );
  assert.match(body, /blocks this PR/);
});

test('a clean result always states how much trunk it read', async () => {
  // "No cherry-picked trunk commits found" is a positive claim. Without a
  // denominator it is indistinguishable from having read nothing — which
  // is precisely how the missing-base-ref bug looked before it was found.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('f.txt', 'f\n');
    r.commit('feat: work');
    const res = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    assert.equal(res.findings.length, 0);
    assert.ok(res.trunkRead >= 1, 'trunkRead must be reported');
    assert.equal(res.prRead, 1);
    assert.match(formatFindings(res.findings, res), /Compared 1 PR commit/);
  } finally {
    r.cleanup();
  }
});

test('a shallow clone is reported as inconclusive, not clean', async () => {
  // A shallow clone cannot see past its graft, so "no duplicates" is a
  // claim with no evidence behind it. Cloned for real: only git decides
  // what a graft hides.
  const r = makeRepo();
  const shallow = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-shallow-'));
  try {
    for (let i = 0; i < 4; i += 1) {
      r.write(`f${i}.txt`, `body ${i}\n`);
      r.commit(`chore: commit ${i}`);
    }
    const clone = spawnSync(
      'git',
      ['clone', '-q', '--depth=1', '--no-local', `file://${r.dir}`, shallow],
      { encoding: 'utf8' },
    );
    assert.equal(clone.status, 0, clone.stderr);
    const git = (...args) => {
      const out = spawnSync('git', args, { cwd: shallow, encoding: 'utf8' });
      assert.equal(out.status, 0, `git ${args.join(' ')}\n${out.stderr}`);
      return out;
    };
    git('config', 'user.email', 't@example.com');
    git('config', 'user.name', 'T');
    git('checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(shallow, 'new.txt'), 'new\n');
    git('add', '-A');
    git('commit', '-qm', 'feat: work');

    const res = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      window: 50,
      cwd: shallow,
    });
    assert.equal(res.shallow, true, 'the fixture must actually be shallow');
    assert.equal(res.findings.length, 0);
    const body = formatFindings(res.findings, res);
    assert.match(body, /Inconclusive/);
    assert.ok(!body.includes('No cherry-picked trunk commits found'));
  } finally {
    r.cleanup();
    fs.rmSync(shallow, { recursive: true, force: true });
  }
});

test('a complete trunk shorter than the window is clean, not inconclusive', async () => {
  // The regression this replaces: "did we read the whole window?" was
  // decided by the size of the patch-id map, which collapses duplicate
  // patches and drops empty commits. It is below the window on every
  // real repository, so every clean run claimed to be inconclusive and
  // the verdict carried no information at all.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    // A repeated patch and an empty commit: exactly what shrinks the map
    // below the commit count.
    r.write('dup.txt', 'same body\n');
    r.commit('feat: add dup');
    fs.rmSync(path.join(r.dir, 'dup.txt'));
    r.git('add', '-A');
    r.commit('chore: remove dup');
    r.write('dup.txt', 'same body\n');
    r.commit('feat: re-add dup');
    r.git('commit', '-q', '--allow-empty', '-m', 'chore: empty');
    r.git('checkout', '-q', '-b', 'feature');
    r.write('f.txt', 'f\n');
    r.commit('feat: work');

    const res = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      window: 500,
      cwd: r.dir,
    });
    const walked = countCommits(['--no-merges', '--max-count=500', 'dev'], { cwd: r.dir });
    assert.equal(res.shallow, false);
    assert.equal(res.trunkCommits, walked, 'the denominator is commits walked');
    assert.equal(res.trunkCommits, 5, 'base + 3 dup commits + 1 empty');
    assert.ok(
      res.trunkRead < res.trunkCommits,
      `unique patch-ids (${res.trunkRead}) must sit below commits (${res.trunkCommits})`,
    );

    const body = formatFindings(res.findings, res);
    assert.ok(
      !body.includes('Inconclusive'),
      'a fully read trunk shorter than the window is conclusive',
    );
    assert.match(body, /No cherry-picked trunk commits found/);
    assert.match(body, /against 5 trunk commit\(s\)/);
  } finally {
    r.cleanup();
  }
});

test('a whitespace-only difference is not reported as a cherry-pick', async () => {
  // `git patch-id --stable` hashes the diff with whitespace stripped, so
  // changing a YAML value in place and changing it while outdenting it
  // under a different parent produce the SAME patch-id (git 2.50). Those
  // are different configurations, and the guard must not call the second
  // one a copy of the first.
  const r = makeRepo();
  try {
    r.write('conf.yml', 'root:\n  child:\n    value: 1\nother: 2\n');
    r.commit('base');
    r.write('conf.yml', 'root:\n  child:\n    value: 9\nother: 2\n');
    const trunkChange = r.commit('chore: bump the nested value');

    r.git('checkout', '-q', '-b', 'feature', 'HEAD~1');
    r.write('branch.txt', 'branch work\n');
    r.commit('feat: unrelated branch work');
    // Same value, hoisted out from under `child` — a structural change.
    r.write('conf.yml', 'root:\n  child:\n  value: 9\nother: 2\n');
    r.commit('chore: hoist the value to the root');

    // The premise: git really does collapse these two into one patch-id.
    const ids = (ref) => {
      const log = spawnSync('git', ['log', '-p', '-1', ref], {
        cwd: r.dir,
        encoding: 'utf8',
      }).stdout;
      return spawnSync('git', ['patch-id', '--stable'], {
        cwd: r.dir,
        input: log,
        encoding: 'utf8',
      }).stdout.trim().split(/\s+/)[0];
    };
    assert.equal(
      ids(trunkChange),
      ids('feature'),
      'fixture is pointless unless patch-id actually collides',
    );

    const res = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    assert.deepEqual(res.findings, [], 'indentation is content in YAML');
    assert.equal(res.unconfirmed, 1, 'the dropped candidate is counted');
    assert.match(formatFindings(res.findings, res), /whitespace only/);
  } finally {
    r.cleanup();
  }
});

test('a whitespace-variant on trunk does not mask an exact match behind it', async () => {
  // patch-id ignores whitespace, so several trunk commits can share one id.
  // The confirmation step compares real bytes, so if the map kept only one
  // SHA per id and that one happened to be a whitespace variant, the
  // byte-identical commit behind it was never compared and a real
  // cherry-pick went unreported. Fixture: a change lands, is reverted, then
  // re-applied reindented — the add and the re-add share a patch-id.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    const root = r.commit('base');

    r.write('fix.txt', 'if (x) {\n  doIt();\n}\n');
    const exact = r.commit('fix: guard the call');
    r.git('revert', '--no-edit', exact);
    r.write('fix.txt', 'if (x) {\n    doIt();\n}\n');
    const variant = r.commit('fix: guard the call, reindented');

    // The branch carries the EXACT form, which sits behind the variant in
    // `git log` order.
    r.git('checkout', '-q', '-b', 'feature', root);
    r.write('branch.txt', 'branch\n');
    r.commit('feat: unrelated');
    r.git('cherry-pick', exact);

    const res = await findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    });
    assert.equal(res.findings.length, 1, 'the exact match must still be found');
    assert.equal(res.findings[0].trunkCommit, exact);
    assert.notEqual(res.findings[0].trunkCommit, variant);
  } finally {
    r.cleanup();
  }
});

test('a whitespace variant on the PR side does not mask its own exact match', () => {
  // Mirror image of the trunk-side bug. One patch id can cover several PR
  // commits too, so taking commits[0] meant a newer whitespace variant
  // could hide an older byte-identical cherry-pick sitting behind it.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    const root = r.commit('base');
    r.write('fix.txt', 'if (x) {\n  doIt();\n}\n');
    const trunkFix = r.commit('fix: guard the call');

    r.git('checkout', '-q', '-b', 'feature', root);
    r.write('branch.txt', 'branch\n');
    r.commit('feat: unrelated');
    // The exact cherry-pick lands first...
    r.git('cherry-pick', trunkFix);
    const picked = r.git('rev-parse', 'HEAD');
    // ...then a revert plus a reindented re-apply puts a whitespace
    // variant with the SAME patch id ahead of it in `git log` order.
    r.git('revert', '--no-edit', picked);
    r.write('fix.txt', 'if (x) {\n    doIt();\n}\n');
    r.commit('fix: guard the call, reindented');

    return findDuplicatePatches({
      baseRange: 'dev',
      prRange: 'dev..feature',
      cwd: r.dir,
    }).then((res) => {
      const hit = res.findings.find((f) => f.commit === picked);
      assert.ok(hit, 'the exact cherry-pick behind the variant must be found');
      assert.equal(hit.trunkCommit, trunkFix);
      r.cleanup();
    });
  } catch (e) {
    r.cleanup();
    throw e;
  }
});

test('a multi-byte character split across a stdout chunk survives decoding', async () => {
  // `String(buf)` decodes each chunk on its own, so a UTF-8 code point
  // straddling the 64 KiB pipe boundary becomes U+FFFD and the trailing
  // bytes are lost. Two `git show` runs over byte-identical diffs can
  // chunk differently, so their digests would disagree and a genuine
  // cherry-pick would be dropped. This diff is a solid run of 3-byte
  // characters, which puts a character across the boundary at 65536.
  const r = makeRepo();
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    const wide = `${'\u4e2d'.repeat(40)}\n`;
    r.write('wide.txt', wide.repeat(600));
    const sha = r.commit('feat: a wide non-ASCII file');

    const actual = await normalizedDiffDigest(sha, { cwd: r.dir });

    // Independent oracle: one buffered read, so decoding never crosses a
    // chunk boundary, plus the same exported line normalization.
    const raw = execFileSync(
      'git',
      ['show', '--format=', '--no-color', '--no-textconv', sha],
      { cwd: r.dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    assert.ok(
      Buffer.byteLength(raw, 'utf8') > 65536,
      'the fixture must exceed one 64 KiB chunk',
    );
    assert.ok(!raw.includes('\uFFFD'), 'the oracle itself must decode cleanly');
    const h = createHash('sha256');
    for (const line of raw.split('\n').slice(0, -1)) {
      const kept = normalizeDiffLine(line);
      if (kept !== null) h.update(`${kept}\n`);
    }
    assert.equal(actual, h.digest('hex'));
  } finally {
    r.cleanup();
  }
});

test('a PR range truncated by a shallow checkout is detected', () => {
  // The trunk read is bounded on purpose and its short-read check catches
  // a graft. The PR side is bounded only by the checkout depth, so a deep
  // head branch is silently cut off and "no duplicates" is claimed over
  // commits that were never read.
  const r = makeRepo();
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'dup-shallow-'));
  try {
    r.write('base.txt', 'base\n');
    r.commit('base');
    r.write('t.txt', 'trunk\n');
    r.commit('feat: trunk work');
    r.git('checkout', '-q', '-b', 'feature');
    for (const n of ['f1', 'f2', 'f3']) {
      r.write(`${n}.txt`, `${n}\n`);
      r.commit(`feat: ${n}`);
    }
    // A complete range ends at a real merge-base, never at a root.
    assert.equal(rangeHitsShallowBoundary('dev..feature', { cwd: r.dir }), false);

    const sh = (...args) => {
      const out = spawnSync('git', args, { cwd: clone, encoding: 'utf8' });
      assert.equal(out.status, 0, `git ${args.join(' ')}\n${out.stderr}`);
    };
    spawnSync('git', ['clone', '-q', '--depth', '2', '--branch', 'feature', `file://${r.dir}`, clone], {
      encoding: 'utf8',
    });
    sh('fetch', '-q', '--depth', '1', 'origin', 'dev:refs/remotes/origin/dev');
    // Only 2 of the 3 branch commits are present; the third is grafted
    // and therefore presents as a parentless root inside the range.
    assert.equal(rangeHitsShallowBoundary('origin/dev..HEAD', { cwd: clone }), true);
  } finally {
    r.cleanup();
    fs.rmSync(clone, { recursive: true, force: true });
  }
});

test('a truncated PR range is reported as inconclusive, not clean', () => {
  const body = formatFindings([], {
    trunkCommits: 2000,
    prCommits: 2,
    shallow: true,
    prTruncated: true,
  });
  assert.match(body, /Inconclusive/);
  assert.match(body, /stops at a shallow boundary/);
  assert.ok(!body.includes('No cherry-picked trunk commits found'));
});

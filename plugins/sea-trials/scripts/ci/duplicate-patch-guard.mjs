/**
 * Detects a PR commit whose patch already exists on the base trunk under
 * a different SHA — i.e. a cherry-picked trunk fix.
 *
 * Why this exists: one logical change (`fix: shard dart-test and skip
 * unchanged packages`) shipped under five distinct SHAs across seven
 * refs. Git cannot reconcile those, so every pair of refs conflicts on
 * those files permanently and re-conflicts after each resolution. The
 * cause is a workflow gap — when trunk CI breaks, patching your own
 * branch is faster than landing on `dev` and waiting.
 *
 * Patch-id, not subject equality: 974 of `dev`'s commit subjects (11%)
 * already repeat, so subject matching fires on noise and trains reflexive
 * use of the escape hatch. Patch-id grouping over the last 1,500 commits
 * yields 30 groups, every one a genuine duplicate, and it also catches
 * duplicates whose subject was reworded.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';

/**
 * How far back on the trunk to look.
 *
 * `actions/checkout` clones shallow, so this bounds what must be fetched.
 * ~2,000 commits covers all of 2026 and costs about 2.4s; the full
 * history costs 12s and 403 MB of diff.
 */
export const PATCH_ID_WINDOW = 2000;

/** Actors whose duplicate patches are expected and must not be flagged. */
export const EXEMPT_ACTORS = new Set(['dependabot[bot]', 'dependabot-preview[bot]']);

/** Head-branch prefixes exempt for the same reason. */
export const EXEMPT_HEAD_PREFIXES = ['dependabot/'];

/** The only base branch this guard applies to. */
export const GUARDED_BASE_REF = 'dev';

/**
 * Whether the guard should run at all for this PR.
 *
 * Promotion PRs (`dev` -> `stg` -> `main`) are merge-only by
 * construction and legitimately carry commits whose patches are already
 * on `dev`: every commit in `main..stg` does. Running there would fail
 * the release train on every eligible commit, so the guard is scoped to
 * PRs landing on the trunk itself.
 *
 * @param {{baseRef?: string, actor?: string, headRef?: string}} ctx
 * @returns {{run: boolean, reason: string}}
 */
export function shouldRunGuard(ctx) {
  const baseRef = (ctx.baseRef ?? '').trim();
  const actor = (ctx.actor ?? '').trim();
  const headRef = (ctx.headRef ?? '').trim();
  if (baseRef !== GUARDED_BASE_REF) {
    return { run: false, reason: `base is '${baseRef}', not '${GUARDED_BASE_REF}'` };
  }
  if (EXEMPT_ACTORS.has(actor)) {
    return { run: false, reason: `actor '${actor}' is exempt` };
  }
  if (EXEMPT_HEAD_PREFIXES.some((p) => headRef.startsWith(p))) {
    return { run: false, reason: `head '${headRef}' is exempt` };
  }
  return { run: true, reason: 'base is the trunk and the author is not exempt' };
}

/**
 * Stream `git log -p` into `git patch-id`, never buffering the diff.
 *
 * `git log --no-merges -p origin/dev` is 403 MB on this repo. Reading
 * that into a string is the exact ENOBUFS failure whose fix
 * (`GIT_STDOUT_MAX_BUFFER`) is the single most-duplicated commit here —
 * so the guard would fall over on its own primary test case. Only
 * `patch-id`'s output (one short line per commit) is collected.
 *
 * @param {string[]} logArgs arguments after `git log`
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<Map<string, string>>} patch-id -> commit sha
 */
export function patchIdsFor(logArgs, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    const log = spawn('git', ['log', ...logArgs], { cwd });
    const patchId = spawn('git', ['patch-id', '--stable'], { cwd });
    /** @type {Buffer[]} */
    const out = [];
    /** @type {string[]} */
    const errs = [];

    log.stdout.pipe(patchId.stdin);
    patchId.stdout.on('data', (b) => out.push(b));
    log.stderr.on('data', (b) => errs.push(String(b)));
    patchId.stderr.on('data', (b) => errs.push(String(b)));

    // A closed downstream (patch-id exiting early) must not raise EPIPE.
    log.stdout.on('error', () => {});
    patchId.stdin.on('error', () => {});

    let settled = false;
    let logCode = null;
    let patchCode = null;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const settle = () => {
      if (settled || logCode === null || patchCode === null) return;
      settled = true;
      // `git log` must be checked explicitly. When it dies — an unknown
      // revision, a shallow clone missing the trunk — `git patch-id`
      // reads empty stdin and exits 0, so keying on patch-id alone turns
      // "I could not read the trunk" into "there are no duplicates".
      // That is a false clean bill of health, the exact failure class
      // this guard exists to prevent.
      if (logCode !== 0) {
        reject(
          new Error(
            `git log ${logArgs.join(' ')} exited ${logCode}: ${errs.join('').trim()}`,
          ),
        );
        return;
      }
      if (patchCode !== 0) {
        reject(new Error(`git patch-id exited ${patchCode}: ${errs.join('').trim()}`));
        return;
      }
      resolve(parsePatchIdOutput(Buffer.concat(out).toString('utf8')));
    };

    log.on('error', fail);
    patchId.on('error', fail);
    log.on('close', (code) => {
      logCode = code;
      settle();
    });
    patchId.on('close', (code) => {
      patchCode = code;
      settle();
    });
  });
}

/**
 * Parse `git patch-id --stable` output into patch-id -> commit.
 *
 * A commit with an empty diff produces no line at all. Treating a missing
 * patch-id as a wildcard would make every empty commit collide with every
 * other, so absent entries are simply absent.
 *
 * @param {string} stdout
 * @returns {Map<string, string>}
 */
export function parsePatchIdOutput(stdout) {
  // Every SHA per patch-id, not just the first. patch-id ignores
  // whitespace, so one id can cover several trunk commits; keeping only a
  // representative meant that if the representative failed the digest
  // confirmation, a byte-identical older commit was never tried and a
  // real cherry-pick went unreported — a false negative introduced by the
  // confirmation step itself.
  /** @type {Map<string, string[]>} */
  const map = new Map();
  for (const line of stdout.split('\n')) {
    const [patch, commit] = line.trim().split(/\s+/);
    if (!patch || !commit) continue;
    const existing = map.get(patch);
    if (existing) {
      if (!existing.includes(commit)) existing.push(commit);
    } else {
      map.set(patch, [commit]);
    }
  }
  return map;
}

/**
 * How many commits `git log` actually walked.
 *
 * NOT derivable from the patch-id map: `parsePatchIdOutput` collapses
 * repeated patches and `git patch-id` emits nothing at all for an empty
 * diff. On this repo a fully-walked window of 555 trunk commits yields
 * 511 map entries — 42 collapsed duplicates and 2 empty commits. Reading
 * the map size as a commit count therefore understates the denominator
 * and, worse, makes the "did we read the whole window?" test fire on
 * every run. Counted from a separate metadata-only walk, which costs
 * nothing next to the `-p` read.
 *
 * @param {string[]} logArgs arguments after `git log`
 * @param {{cwd?: string}} [opts]
 * @returns {number}
 */
export function countCommits(logArgs, opts = {}) {
  const r = spawnSync('git', ['log', '--format=%H', ...logArgs], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error(`git log ${logArgs.join(' ')} exited ${r.status}: ${(r.stderr ?? '').trim()}`);
  }
  return (r.stdout ?? '').split('\n').filter((l) => l.trim()).length;
}

/**
 * Is this clone grafted, i.e. is there history git cannot see?
 *
 * The distinction that matters for the verdict: walking fewer commits
 * than the window asks for means either the trunk history is genuinely
 * that short (a complete read — conclusive) or the clone is shallow (an
 * incomplete read — inconclusive). Only this tells the two apart.
 *
 * @param {{cwd?: string}} [opts]
 * @returns {boolean}
 */
/**
 * Does a revision range stop at a shallow boundary rather than a real root?
 *
 * The trunk read is bounded deliberately by `--max-count`, and
 * `isShallowRepository` plus the commit count catch a short read there.
 * The PR side has no such bound, so a head branch deeper than the
 * checkout's `fetch-depth` is silently truncated: the older PR commits
 * are simply invisible and the guard reports "no duplicates found"
 * without having looked at them. A grafted commit has its parents
 * stripped, so it presents as a root — inside `origin/dev..HEAD`, which
 * should never contain one, that is the truncation signal.
 *
 * @param {string} range
 * @param {{cwd?: string}} [opts]
 * @returns {boolean}
 */
export function rangeHitsShallowBoundary(range, opts = {}) {
  const r = spawnSync('git', ['rev-list', '--max-parents=0', range], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) return false;
  return (r.stdout ?? '').trim() !== '';
}

export function isShallowRepository(opts = {}) {
  const r = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: 'utf8',
  });
  return (r.stdout ?? '').trim() === 'true';
}

/**
 * One diff line reduced to what a genuine duplicate must share.
 *
 * `git patch-id --stable` hashes the diff with whitespace stripped, so
 * two patches that differ only in indentation collide. In a
 * whitespace-significant file that is a semantic difference: changing
 * `value` under `root.child` and changing it while outdenting it to
 * `root` produce the same stable patch-id (verified against git 2.50),
 * so the guard would report a config restructure as a cherry-pick.
 *
 * Kept: every +/-/context line byte-for-byte, indentation included.
 * Dropped: `index` lines (blob SHAs, not content) and hunk headers (line
 * numbers, which legitimately move under a cherry-pick). That is
 * strictly finer than patch-id and strictly coarser than a raw diff
 * comparison, so it rejects whitespace-only differences without
 * rejecting a real cherry-pick that landed at a different offset.
 *
 * @param {string} line
 * @returns {string|null} null when the line carries no content signal
 */
export function normalizeDiffLine(line) {
  if (line.startsWith('index ')) return null;
  if (line.startsWith('@@')) return '@@';
  return line;
}

/**
 * SHA-256 of a commit's normalized diff, read as a stream.
 *
 * Streamed for the same reason `patchIdsFor` is: a single commit's diff
 * is unbounded (this repo's own test fixture exceeds 1 MB), and
 * buffering it is the ENOBUFS failure the guard exists to catch.
 *
 * @param {string} sha
 * @param {{cwd?: string}} [opts]
 * @returns {Promise<string>}
 */
export function normalizedDiffDigest(sha, opts = {}) {
  const cwd = opts.cwd ?? process.cwd();
  return new Promise((resolve, reject) => {
    const p = spawn(
      'git',
      ['show', '--format=', '--no-color', '--no-textconv', sha],
      { cwd },
    );
    const hash = createHash('sha256');
    /** @type {string[]} */
    const errs = [];
    // Decode across chunk boundaries, not per chunk. `String(buf)` on a
    // buffer that ends mid-code-point emits U+FFFD and loses the trailing
    // bytes. Chunk boundaries are set by the pipe, so two `git show` runs
    // over byte-identical diffs can split differently and produce
    // different digests — which would drop a genuine cherry-pick.
    const decoder = new StringDecoder('utf8');
    let pending = '';
    const feed = (chunk, final) => {
      const text = pending + chunk;
      const lines = text.split('\n');
      pending = final ? '' : (lines.pop() ?? '');
      if (final && lines.length && lines[lines.length - 1] === '') lines.pop();
      for (const line of lines) {
        const kept = normalizeDiffLine(line);
        if (kept !== null) hash.update(`${kept}\n`);
      }
    };
    p.stdout.on('data', (b) => feed(decoder.write(b), false));
    p.stderr.on('data', (b) => errs.push(String(b)));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`git show ${sha} exited ${code}: ${errs.join('').trim()}`));
        return;
      }
      feed(decoder.end(), true);
      resolve(hash.digest('hex'));
    });
  });
}

/**
 * Commits on the PR whose patch already exists on the trunk window.
 *
 * @param {{
 *   baseRange: string,
 *   prRange: string,
 *   window?: number,
 *   cwd?: string,
 * }} opts
 * @returns {Promise<{
 *   findings: Array<{commit: string, patchId: string, trunkCommit: string}>,
 *   unconfirmed: number,
 *   trunkRead: number,
 *   prRead: number,
 *   trunkCommits: number,
 *   prCommits: number,
 *   shallow: boolean,
 *   window: number,
 * }>}
 */
export async function findDuplicatePatches(opts) {
  const window = opts.window ?? PATCH_ID_WINDOW;
  const cwd = opts.cwd;
  const trunkArgs = ['--no-merges', `--max-count=${window}`, opts.baseRange];
  const prArgs = ['--no-merges', opts.prRange];
  const trunk = await patchIdsFor(
    ['--no-merges', '-p', `--max-count=${window}`, opts.baseRange],
    { cwd },
  );
  const pr = await patchIdsFor(['--no-merges', '-p', opts.prRange], { cwd });
  const trunkCommits = countCommits(trunkArgs, { cwd });
  const prCommits = countCommits(prArgs, { cwd });

  /** @type {Array<{commit: string, patchId: string, trunkCommit: string}>} */
  const findings = [];
  let unconfirmed = 0;
  const shallow = isShallowRepository({ cwd });
  // One digest per SHA no matter how many groups reference it.
  /** @type {Map<string, string>} */
  const digests = new Map();
  const digestOf = async (sha) => {
    const hit = digests.get(sha);
    if (hit !== undefined) return hit;
    const d = await normalizedDiffDigest(sha, { cwd });
    digests.set(sha, d);
    return d;
  };

  for (const [patchId, commits] of pr) {
    const group = trunk.get(patchId) ?? [];
    if (group.length === 0) continue;
    // Both sides are lists. patch-id ignores whitespace, so one id can
    // cover several commits on the PR *and* several on the trunk; taking a
    // representative from either side lets a whitespace-different commit
    // mask a byte-identical one behind it, and the cherry-pick goes
    // unreported. Compare every PR commit against every trunk candidate.
    let confirmedAny = false;
    for (const commit of commits) {
      const candidates = group.filter((c) => c !== commit);
      if (candidates.length === 0) continue;
      // eslint-disable-next-line no-await-in-loop -- groups are rare and tiny
      const mine = await digestOf(commit);
      let matched = null;
      for (const trunkCommit of candidates) {
        // eslint-disable-next-line no-await-in-loop -- candidates are rare
        const theirs = await digestOf(trunkCommit);
        if (mine === theirs) {
          matched = trunkCommit;
          break;
        }
      }
      if (matched) {
        findings.push({ commit, patchId, trunkCommit: matched });
        confirmedAny = true;
      }
    }
    if (!confirmedAny) unconfirmed += 1;
  }
  // The counts travel with the result so the report can state its own
  // denominator. "No duplicates found" over an unread trunk is a false
  // clean bill, and a shallow clone produces exactly that silently.
  return {
    findings,
    unconfirmed,
    trunkRead: trunk.size,
    prRead: pr.size,
    trunkCommits,
    prCommits,
    shallow,
    prTruncated: shallow && rangeHitsShallowBoundary(opts.prRange, { cwd }),
    window,
  };
}

/**
 * GitHub job-summary markdown for the findings.
 *
 * @param {Array<{commit: string, patchId: string, trunkCommit: string}>} findings
 * @param {{failing?: boolean}} [opts]
 * @returns {string}
 */
export function formatFindings(findings, opts = {}) {
  const window = opts.window ?? PATCH_ID_WINDOW;
  const dropped =
    opts.unconfirmed
      ? `${opts.unconfirmed} candidate(s) matched by patch-id were dropped: ` +
        'their diffs differ in whitespace only, which patch-id ignores.\n'
      : '';
  const scope =
    opts.trunkCommits === undefined
      ? ''
      : `\nCompared ${opts.prCommits ?? 0} PR commit(s) against ` +
        `${opts.trunkCommits} trunk commit(s) (window ${window}).\n${dropped}`;
  // Reading fewer commits than the window asked for has two causes, and
  // only one is a problem. If the trunk history is simply shorter than
  // the window, the read was complete. If the clone is grafted, there is
  // history git could not see and "no duplicates" is a positive claim
  // with no evidence behind it. Counting unique patch-ids here instead of
  // commits made this fire on every run, since duplicate and empty
  // commits always collapse the map below the window.
  const short =
    opts.trunkCommits !== undefined &&
    opts.shallow === true &&
    opts.trunkCommits < window;
  if (findings.length === 0) {
    // The PR side is bounded by the checkout depth, not by this window,
    // so a head branch deeper than `fetch-depth` is truncated without
    // anything above noticing. Reporting that as clean is the same false
    // clean bill as an unread trunk, just on the other side of the range.
    if (opts.prTruncated === true) {
      return (
        '## Duplicate-patch guard\n\n' +
        'Inconclusive: the PR range stops at a shallow boundary, so the ' +
        'older commits on this branch were never read. A cherry-pick among ' +
        'them would not be seen. Increase the checkout depth for this ' +
        'branch. This is not a clean result.\n' +
        scope
      );
    }
    if (short) {
      return (
        '## Duplicate-patch guard\n\n' +
        `Inconclusive: the clone is shallow and only ${opts.trunkCommits} trunk ` +
        `commit(s) were readable, fewer than the ${window}-commit window. A ` +
        'cherry-pick older than that would not be seen. This is not a clean ' +
        'result.\n' +
        scope
      );
    }
    return `## Duplicate-patch guard\n\nNo cherry-picked trunk commits found.\n${scope}`;
  }
  const verb = opts.failing ? 'blocks this PR' : 'is reported, not enforced';
  const rows = findings
    .map(
      (f) =>
        `| \`${f.commit.slice(0, 9)}\` | \`${f.trunkCommit.slice(0, 9)}\` | \`${f.patchId.slice(0, 12)}\` |`,
    )
    .join('\n');
  return [
    '## Duplicate-patch guard',
    '',
    `Found ${findings.length} commit(s) whose patch is already on \`${GUARDED_BASE_REF}\` under a different SHA. This ${verb}.`,
    '',
    '| PR commit | already on trunk as | patch-id |',
    '| --- | --- | --- |',
    rows,
    '',
    `Cherry-picking a trunk fix creates a second SHA for one change, and git cannot reconcile the two — the branches then conflict on those files permanently. Merge \`${GUARDED_BASE_REF}\` instead of cherry-picking from it.`,
    scope,
  ].join('\n');
}

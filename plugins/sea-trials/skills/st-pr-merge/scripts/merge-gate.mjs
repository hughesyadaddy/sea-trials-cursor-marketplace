#!/usr/bin/env node
/**
 * st-pr-merge gate — the ONLY sanctioned merge path for Sea Trials PRs.
 *
 * Skill-local and self-contained: needs only `node` (>=20) and an
 * authenticated `gh`. No project scripts, no pnpm, no checkout required.
 *
 *   node merge-gate.mjs --pr <n> [--repo owner/name] [--dry-run] [--json]
 *        [--method merge|squash|rebase] [--wait <min>] [--settle-sec <s>]
 *        [--allow-human-threads] [--migrations-dir supabase/migrations]
 *        [--no-migration-check] [--require-check <name>]...
 *
 * Merge rules enforced (Alex's standing rules):
 *   1. Every check on the HEAD commit (all workflows, check runs AND
 *      commit statuses) is complete and green. Zero checks = not green.
 *      The verdict is re-read after --settle-sec (default 60) and must be
 *      identical for the same head, so late-registering suites count.
 *   2. Zero unresolved Codex review threads (and, by default, zero
 *      unresolved threads of any author).
 *   3. Never `--admin`. The merge call is pinned with
 *      `--match-head-commit <sha>` so a push that lands mid-gate aborts.
 *   4. New migrations: unique version, strictly newer than every version on
 *      the base branch, no collision with other open PRs into the same base.
 *   5. Renaming/deleting an existing migration is blocked iff its old version
 *      is APPLIED (present in supabase_migrations.schema_migrations) on the
 *      environment that owns the PR's base branch (feat/rich-content, dev →
 *      Dev; stg → Staging; main → Prod). Read-only lookup via the Supabase
 *      Management API read-only query endpoint; unreachable DB or unmapped
 *      base = blocked (fail closed). Never-applied renames are allowed and
 *      logged. The rename target must not collide with base / open PRs.
 *
 * Exit codes: 0 merged (or ready with --dry-run) · 2 unresolved threads ·
 * 3 CI failed · 4 migration collision/order · 5 not mergeable (behind,
 * conflict, blocked, draft) · 6 head moved during gate · 8 CI pending ·
 * 1 usage / API error.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CODEX_LOGINS = new Set([
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
]);
const GREEN_CONCLUSIONS = new Set(['SUCCESS', 'SKIPPED', 'NEUTRAL']);
const MIGRATION_RE = /^(\d+)_.+\.sql$/;

export const EXIT = {
  OK: 0, ERROR: 1, THREADS: 2, CI_FAIL: 3, MIGRATIONS: 4,
  NOT_MERGEABLE: 5, HEAD_MOVED: 6, CI_PENDING: 8,
};

// ---------------------------------------------------------------- gh runner

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** @returns {{status:number, stdout:string, stderr:string}} */
export function defaultGh(args) {
  for (let attempt = 1; ; attempt += 1) {
    const r = spawnSync('gh', args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    const msg = `${out.stderr}\n${out.stdout}`;
    const limited = /rate limit|RATE_LIMITED|secondary rate|abuse detection/i.test(msg);
    if (out.status === 0 || !limited || attempt >= 5) return out;
    sleepMs(Math.min(60_000 * attempt, 300_000));
  }
}

function ghJson(gh, args) {
  const r = gh(args);
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 3).join(' ')} failed: ${r.stderr || r.stdout}`);
  return JSON.parse(r.stdout);
}

function graphql(gh, query, vars) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) {
    if (v === null || v === undefined) continue;
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`);
  }
  const res = ghJson(gh, args);
  if (res.errors?.length) throw new Error(`graphql: ${JSON.stringify(res.errors)}`);
  return res.data;
}

// ---------------------------------------------------------------- readers

export function readPr(gh, repo, pr) {
  return ghJson(gh, [
    'pr', 'view', String(pr), '--repo', repo, '--json',
    'number,state,isDraft,headRefOid,headRefName,baseRefName,mergeable,mergeStateStatus,url',
  ]);
}

const ROLLUP_Q = `query($owner:String!,$name:String!,$oid:GitObjectID!,$cursor:String){
  repository(owner:$owner,name:$name){ object(oid:$oid){ ... on Commit {
    statusCheckRollup{ contexts(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{ __typename
        ... on CheckRun{ name status conclusion checkSuite{ workflowRun{ workflow{ name } } } }
        ... on StatusContext{ context state }
      } } } } } } }`;

/** Every check run + status on the head commit, paginated. */
export function readHeadChecks(gh, repo, oid) {
  const [owner, name] = repo.split('/');
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const d = graphql(gh, ROLLUP_Q, { owner, name, oid, cursor });
    const ctx = d?.repository?.object?.statusCheckRollup?.contexts;
    if (!ctx) break;
    for (const n of ctx.nodes) {
      if (n.__typename === 'CheckRun') {
        out.push({
          kind: 'check', name: n.name,
          workflow: n.checkSuite?.workflowRun?.workflow?.name ?? null,
          status: n.status, conclusion: n.conclusion,
        });
      } else {
        out.push({ kind: 'status', name: n.context, status: n.state === 'PENDING' || n.state === 'EXPECTED' ? 'PENDING' : 'COMPLETED', conclusion: n.state });
      }
    }
    if (!ctx.pageInfo.hasNextPage) break;
    cursor = ctx.pageInfo.endCursor;
  }
  return out;
}

export function classifyChecks(checks, required = []) {
  const failed = [];
  const pending = [];
  const green = [];
  for (const c of checks) {
    if (c.status !== 'COMPLETED') pending.push(c);
    else if (GREEN_CONCLUSIONS.has(String(c.conclusion).toUpperCase())) green.push(c);
    else failed.push(c);
  }
  const names = new Set(checks.map((c) => c.name));
  const missing = required.filter((r) => !names.has(r));
  let verdict = 'green';
  if (failed.length) verdict = 'fail';
  else if (pending.length || missing.length || checks.length === 0) verdict = 'pending';
  return { verdict, failed, pending, green, missing, total: checks.length };
}

const THREADS_Q = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$pr){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{ id isResolved isOutdated path
        comments(first:1){ nodes{ author{ login } } } } } } } }`;

export function readThreads(gh, repo, pr) {
  const [owner, name] = repo.split('/');
  const out = [];
  let cursor = null;
  for (let page = 0; page < 50; page += 1) {
    const d = graphql(gh, THREADS_Q, { owner, name, pr: Number(pr), cursor });
    const rt = d.repository.pullRequest.reviewThreads;
    for (const n of rt.nodes) {
      out.push({
        id: n.id, isResolved: n.isResolved, isOutdated: n.isOutdated, path: n.path,
        author: n.comments.nodes[0]?.author?.login ?? null,
      });
    }
    if (!rt.pageInfo.hasNextPage) break;
    cursor = rt.pageInfo.endCursor;
  }
  return out;
}

export function classifyThreads(threads) {
  const unresolved = threads.filter((t) => !t.isResolved);
  const codex = unresolved.filter((t) => CODEX_LOGINS.has(t.author ?? ''));
  return { unresolved, codex, total: threads.length };
}

// ---------------------------------------------------------------- migrations

function listPrFiles(gh, repo, pr) {
  const pages = ghJson(gh, ['api', '--paginate', '--slurp', `repos/${repo}/pulls/${pr}/files?per_page=100`]);
  return pages.flat();
}

function listDir(gh, repo, dir, ref) {
  const r = gh(['api', `repos/${repo}/contents/${dir}?ref=${encodeURIComponent(ref)}`]);
  if (r.status !== 0) return null; // dir absent on base → nothing to check
  const items = JSON.parse(r.stdout);
  return Array.isArray(items) ? items.map((i) => i.name) : null;
}

export function versionOf(file) {
  const m = MIGRATION_RE.exec(file.split('/').pop() ?? '');
  return m ? m[1] : null;
}

/**
 * Pure check: added migration versions must be unique, strictly greater
 * than every base version, and not claimed by another open PR.
 */
export function checkMigrations({ added, baseNames, others }) {
  const problems = [];
  const shared = [];
  const base = new Map(); // version -> basename
  for (const n of baseNames) { const v = versionOf(n); if (v) base.set(v, n); }
  const maxBase = [...base.keys()].reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a), '0');
  const seen = new Map(); // version -> path
  for (const f of added) {
    const v = versionOf(f);
    if (!v) continue;
    const name = f.split('/').pop();
    if (seen.has(v)) problems.push(`duplicate version ${v} in PR: ${seen.get(v)} and ${f}`);
    seen.set(v, f);
    if (base.get(v) === name) { shared.push(`${name} already on base (identical file name — inherited, not a collision)`); continue; }
    if (base.has(v)) problems.push(`version ${v} already used on base by ${base.get(v)} (${f})`);
    else if (BigInt(v) <= BigInt(maxBase)) problems.push(`version ${v} is not newer than base max ${maxBase} (${f}); renumber above ${maxBase}`);
  }
  for (const o of others) {
    for (const f of o.files) {
      const v = versionOf(f);
      if (!v || !seen.has(v)) continue;
      const mine = seen.get(v).split('/').pop();
      if (base.get(v) === mine) continue;
      if (f.split('/').pop() === mine) shared.push(`${mine} also carried by open PR #${o.number} (stacked/shared commit)`);
      else problems.push(`version ${v} also added by open PR #${o.number} as ${f.split('/').pop()}`);
    }
  }
  return { ok: problems.length === 0, problems, shared, maxBase, added: [...seen.keys()] };
}

// ------------------------------------------------- applied-migration lookup

/** Base branch → environment whose DB records which migrations are applied. */
export const MIGRATION_ENVS = {
  'feat/rich-content': { name: 'Dev', flavor: 'dev', ref: 'jchyjnxcnukbsmlsolha' },
  dev: { name: 'Dev', flavor: 'dev', ref: 'jchyjnxcnukbsmlsolha' },
  stg: { name: 'Staging', flavor: 'stg', ref: 'lbypalsqrvpwfxofqciz' },
  main: { name: 'Prod', flavor: 'prod', ref: 'oulpgrsifasfsvkrjnrn' },
};

export function targetEnvFor(baseRef) {
  return Object.hasOwn(MIGRATION_ENVS, baseRef) ? MIGRATION_ENVS[baseRef] : null;
}

function envFileValue(file, key) {
  if (!existsSync(file)) return null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim().replace(/^(['"])(.*)\1$/, '$2') || null;
  }
  return null;
}

/** Same lookup order as scripts/supabase_deploy.sh: env, .env.<flavor>, .env.base. */
function managementToken(flavor) {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const top = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  const root = top.status === 0 ? top.stdout.trim() : process.cwd();
  return envFileValue(join(root, `.env.${flavor}`), 'SUPABASE_ACCESS_TOKEN')
    ?? envFileValue(join(root, '.env.base'), 'SUPABASE_ACCESS_TOKEN');
}

// Child process so the gate stays synchronous; uses Node's built-in fetch
// (no curl dependency). Request (incl. token) arrives on stdin, never argv.
const FETCH_CHILD = `let b='';process.stdin.on('data',(c)=>{b+=c;}).on('end',async()=>{
const r=JSON.parse(b);try{const res=await fetch(r.url,{method:'POST',
headers:{Authorization:'Bearer '+r.token,'Content-Type':'application/json'},
body:JSON.stringify({query:r.query}),signal:AbortSignal.timeout(30000)});
process.stdout.write(JSON.stringify({status:res.status,body:await res.text()}));
}catch(e){process.stdout.write(JSON.stringify({status:0,body:String(e&&e.message||e)}));}});`;

/**
 * Read-only lookup on env.ref's supabase_migrations.schema_migrations.
 * Returns { applied: Set<version> (subset of `versions`), maxApplied }.
 * Throws on any failure (callers fail closed). Token never printed.
 */
export function defaultAppliedVersions(env, versions) {
  if (!versions.every((v) => /^\d{1,20}$/.test(v))) throw new Error('non-numeric migration version');
  const token = managementToken(env.flavor);
  if (!token) throw new Error(`no SUPABASE_ACCESS_TOKEN (env, .env.${env.flavor} or .env.base)`);
  const list = versions.length ? versions.map((v) => `'${v}'`).join(',') : 'null';
  const query = `select coalesce(json_agg(version) filter (where version in (${list})), '[]'::json) as hits, max(version) as max_applied from supabase_migrations.schema_migrations`;
  const url = `https://api.supabase.com/v1/projects/${env.ref}/database/query/read-only`;
  const r = spawnSync(process.execPath, ['-e', FETCH_CHILD], { encoding: 'utf8', input: JSON.stringify({ url, token, query }), timeout: 45_000 });
  if (r.status !== 0) throw new Error(`lookup process failed (${r.status ?? r.signal}): ${(r.stderr ?? '').trim().slice(0, 200)}`);
  const { status, body } = JSON.parse(r.stdout);
  if (status < 200 || status >= 300) throw new Error(status === 0 ? `request failed: ${body}` : `Management API HTTP ${status}: ${String(body).slice(0, 200)}`);
  const rows = JSON.parse(body);
  if (!Array.isArray(rows) || rows.length !== 1 || !Array.isArray(rows[0].hits)) throw new Error('unexpected Management API response');
  return { applied: new Set(rows[0].hits.map(String)), maxApplied: rows[0].max_applied ? String(rows[0].max_applied) : '0' };
}

/**
 * Pure check for renamed/removed migrations.
 * changes: [{ status: 'renamed'|'removed', oldFile, newFile? }]
 * applied: () => { applied: Set<version>, maxApplied } (may throw → fail closed).
 * addedFiles: files this PR adds (claims). others: open PRs' claims
 * (added files + rename destinations).
 */
export function checkRenames({ changes, env, baseRef, applied, baseNames = [], others = [], addedFiles = [], dir = 'supabase/migrations' }) {
  const problems = [];
  const allowed = [];
  if (changes.length === 0) return { ok: true, problems, allowed };
  const label = (c) => (c.status === 'renamed' ? `renamed ${c.oldFile} → ${c.newFile}` : `deleted ${c.oldFile}`);
  const versions = [];
  for (const c of changes) {
    const v = versionOf(c.oldFile);
    if (!v) problems.push(`existing migration ${label(c)}: old file has no migration version (never rename/delete applied migrations)`);
    else versions.push(v);
  }
  if (!env) {
    for (const c of changes) problems.push(`existing migration ${label(c)}: base ${baseRef} has no mapped migration DB — cannot verify it was never applied (fail closed)`);
    return { ok: false, problems, allowed };
  }
  let set;
  let maxApplied;
  try {
    ({ applied: set, maxApplied } = applied());
  } catch (e) {
    for (const c of changes) problems.push(`existing migration ${label(c)}: cannot read ${env.name} (${env.ref}) schema_migrations — ${e.message} (fail closed)`);
    return { ok: false, problems, allowed };
  }
  const base = new Map();
  for (const n of baseNames) { const v = versionOf(n); if (v) base.set(v, n); }
  // Every version this PR claims: added files + rename destinations.
  const claims = new Map();
  for (const f of [...addedFiles, ...changes.filter((c) => c.status === 'renamed' && c.newFile.startsWith(`${dir}/`)).map((c) => c.newFile)]) {
    const v = versionOf(f);
    if (!v) continue;
    claims.set(v, (claims.get(v) ?? 0) + 1);
  }
  for (const c of changes) {
    const v = versionOf(c.oldFile);
    if (!v) continue;
    if (set.has(v)) { problems.push(`existing migration ${label(c)}: version ${v} is applied on ${env.name} (${env.ref}) (never rename/delete applied migrations)`); continue; }
    if (c.status === 'renamed' && c.newFile.startsWith(`${dir}/`)) {
      const nv = versionOf(c.newFile);
      const nn = c.newFile.split('/').pop();
      const oldName = c.oldFile.split('/').pop();
      if (!nv) { problems.push(`${label(c)}: new name has no migration version`); continue; }
      if (base.has(nv) && base.get(nv) !== oldName && base.get(nv) !== nn) { problems.push(`${label(c)}: version ${nv} already used on base by ${base.get(nv)}`); continue; }
      if ((claims.get(nv) ?? 0) > 1) { problems.push(`${label(c)}: version ${nv} claimed more than once in this PR`); continue; }
      if (BigInt(nv) <= BigInt(maxApplied)) { problems.push(`${label(c)}: new version ${nv} is not newer than the latest migration applied on ${env.name} (${maxApplied}); db push would skip it — renumber above ${maxApplied}`); continue; }
      const clash = others.find((o) => o.files.some((f) => versionOf(f) === nv && f.split('/').pop() !== nn));
      if (clash) { problems.push(`${label(c)}: version ${nv} also added by open PR #${clash.number}`); continue; }
    }
    allowed.push(`${label(c)} — version ${v} never applied on ${env.name} (${env.ref}); allowed`);
  }
  return { ok: problems.length === 0, problems, allowed };
}

function migrationReport(gh, repo, prMeta, dir, appliedFn = defaultAppliedVersions) {
  const files = listPrFiles(gh, repo, prMeta.number);
  const added = files
    .filter((f) => f.status === 'added' && f.filename.startsWith(`${dir}/`))
    .map((f) => f.filename);
  const changes = files
    .filter((f) => (f.status === 'removed' || f.status === 'renamed') && (f.filename.startsWith(`${dir}/`) || (f.previous_filename ?? '').startsWith(`${dir}/`)))
    .map((f) => (f.status === 'renamed'
      ? { status: 'renamed', oldFile: f.previous_filename, newFile: f.filename }
      : { status: 'removed', oldFile: f.filename }));
  if (added.length === 0 && changes.length === 0) return { ok: true, problems: [], added: [], renames: [] };
  const baseNames = listDir(gh, repo, dir, prMeta.baseRefName) ?? [];
  const open = ghJson(gh, ['pr', 'list', '--repo', repo, '--state', 'open', '--base', prMeta.baseRefName, '--limit', '200', '--json', 'number']);
  const others = [];
  for (const { number } of open) {
    if (number === prMeta.number) continue;
    const f = listPrFiles(gh, repo, number)
      .filter((x) => (x.status === 'added' || x.status === 'renamed') && x.filename.startsWith(`${dir}/`))
      .map((x) => x.filename);
    if (f.length) others.push({ number, files: f });
  }
  const rep = checkMigrations({ added, baseNames, others });
  const renameDests = new Set(changes.filter((c) => c.status === 'renamed').map((c) => versionOf(c.newFile)).filter(Boolean));
  for (const f of added) { const v = versionOf(f); if (v && renameDests.has(v)) rep.problems.push(`version ${v} added (${f}) and also a rename destination in this PR`); }
  const env = targetEnvFor(prMeta.baseRefName);
  const versions = changes.map((c) => versionOf(c.oldFile)).filter(Boolean);
  const rn = checkRenames({
    changes, env, baseRef: prMeta.baseRefName, baseNames, others, addedFiles: added, dir,
    applied: () => appliedFn(env, versions),
  });
  rep.problems.push(...rn.problems);
  rep.renames = rn.allowed;
  rep.ok = rep.problems.length === 0;
  return rep;
}

// ---------------------------------------------------------------- gate

export function evaluate({ prMeta, checks, threads, migrations, opts }) {
  if (prMeta.state !== 'OPEN') return { exit: EXIT.NOT_MERGEABLE, reason: `PR is ${prMeta.state}` };
  if (prMeta.isDraft) return { exit: EXIT.NOT_MERGEABLE, reason: 'PR is draft' };
  if (threads.codex.length) return { exit: EXIT.THREADS, reason: `${threads.codex.length} unresolved Codex thread(s)` };
  if (!opts.allowHumanThreads && threads.unresolved.length) return { exit: EXIT.THREADS, reason: `${threads.unresolved.length} unresolved thread(s)` };
  if (checks.verdict === 'fail') return { exit: EXIT.CI_FAIL, reason: `failed: ${checks.failed.map((c) => c.name).join(', ')}` };
  if (checks.verdict === 'pending') {
    const why = checks.total === 0 ? 'no checks reported on head yet'
      : checks.missing.length ? `required check(s) missing: ${checks.missing.join(', ')}`
        : `pending: ${checks.pending.map((c) => c.name).join(', ')}`;
    return { exit: EXIT.CI_PENDING, reason: why };
  }
  if (migrations && !migrations.ok) return { exit: EXIT.MIGRATIONS, reason: migrations.problems.join('; ') };
  const ms = prMeta.mergeStateStatus;
  if (prMeta.mergeable === 'CONFLICTING' || ms === 'DIRTY') return { exit: EXIT.NOT_MERGEABLE, reason: 'merge conflict with base — sync the branch (merge base in, gate, push), never force' };
  if (ms === 'BEHIND') return { exit: EXIT.NOT_MERGEABLE, reason: 'branch behind base (strict protection) — merge base in, gate, push, re-run loop' };
  if (ms === 'BLOCKED') return { exit: EXIT.NOT_MERGEABLE, reason: 'blocked by branch protection (review approval or rule) — never --admin; report to Alex' };
  if (ms === 'UNKNOWN' || prMeta.mergeable === 'UNKNOWN') return { exit: EXIT.CI_PENDING, reason: 'GitHub still computing mergeability' };
  return { exit: EXIT.OK, reason: 'ready' };
}

export function buildMergeArgs({ pr, repo, method, headOid }) {
  const args = ['pr', 'merge', String(pr), '--repo', repo, `--${method}`, '--match-head-commit', headOid];
  if (args.some((a) => a === '--admin' || a.startsWith('--admin='))) throw new Error('refusing --admin');
  return args;
}

function snapshot(gh, opts) {
  const prMeta = readPr(gh, opts.repo, opts.pr);
  const checks = classifyChecks(readHeadChecks(gh, opts.repo, prMeta.headRefOid), opts.required);
  const threads = classifyThreads(readThreads(gh, opts.repo, opts.pr));
  return { prMeta, checks, threads };
}

export function runGate(opts, gh = defaultGh, sleep = sleepMs, appliedFn = defaultAppliedVersions) {
  const deadline = Date.now() + opts.waitMin * 60_000;
  let migrations = null;
  for (;;) {
    const s = snapshot(gh, opts);
    if (opts.migrations && !migrations) migrations = migrationReport(gh, opts.repo, s.prMeta, opts.migrationsDir, appliedFn);
    let verdict = evaluate({ ...s, migrations, opts });
    if (verdict.exit === EXIT.OK && opts.settleSec > 0) {
      sleep(opts.settleSec * 1000);
      const again = snapshot(gh, opts);
      if (again.prMeta.headRefOid !== s.prMeta.headRefOid) {
        return { ...again, migrations, verdict: { exit: EXIT.HEAD_MOVED, reason: 'head moved during settle — re-run loop' } };
      }
      const v2 = evaluate({ ...again, migrations, opts });
      if (v2.exit !== EXIT.OK || again.checks.total !== s.checks.total) {
        verdict = v2.exit === EXIT.OK ? { exit: EXIT.CI_PENDING, reason: 'check set changed during settle' } : v2;
      } else {
        Object.assign(s, again);
      }
    }
    if (verdict.exit === EXIT.CI_PENDING && Date.now() < deadline) {
      sleep(Math.min(60_000, Math.max(1000, deadline - Date.now())));
      continue;
    }
    if (verdict.exit !== EXIT.OK || opts.dryRun) return { ...s, migrations, verdict };
    if (opts.migrations) {
      // Applied history can change during waits: re-read right before merging.
      migrations = migrationReport(gh, opts.repo, s.prMeta, opts.migrationsDir, appliedFn);
      if (!migrations.ok) return { ...s, migrations, verdict: { exit: EXIT.MIGRATIONS, reason: migrations.problems.join('; ') } };
    }
    const r = gh(buildMergeArgs({ pr: opts.pr, repo: opts.repo, method: opts.method, headOid: s.prMeta.headRefOid }));
    if (r.status !== 0) {
      const msg = `${r.stderr}${r.stdout}`;
      const moved = /head.*(changed|moved|match)|expected head/i.test(msg);
      return { ...s, migrations, verdict: { exit: moved ? EXIT.HEAD_MOVED : EXIT.NOT_MERGEABLE, reason: `gh pr merge failed: ${msg.trim()}` } };
    }
    return { ...s, migrations, verdict: { exit: EXIT.OK, reason: 'merged', mergedHead: s.prMeta.headRefOid } };
  }
}

// ---------------------------------------------------------------- cli

function resolveRepo(gh) {
  if (process.env.GH_REPO) return process.env.GH_REPO;
  const r = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
  if (r.status !== 0) throw new Error('cannot resolve repo; pass --repo owner/name');
  return r.stdout.trim();
}

export function parseArgs(argv) {
  const o = { pr: null, repo: null, dryRun: false, json: false, method: 'merge', waitMin: 0, settleSec: 60, allowHumanThreads: false, migrations: true, migrationsDir: 'supabase/migrations', required: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '--admin' || a.startsWith('--admin')) throw new Error('--admin is forbidden (standing rule). Fix the blocker instead.');
    if (a === '--pr') o.pr = Number(argv[++i]);
    else if (a === '--repo') o.repo = argv[++i];
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--json') o.json = true;
    else if (a === '--method') o.method = argv[++i];
    else if (a === '--wait') o.waitMin = Number(argv[++i]);
    else if (a === '--settle-sec') o.settleSec = Number(argv[++i]);
    else if (a === '--allow-human-threads') o.allowHumanThreads = true;
    else if (a === '--no-migration-check') o.migrations = false;
    else if (a === '--migrations-dir') o.migrationsDir = argv[++i];
    else if (a === '--require-check') o.required.push(argv[++i]);
    else throw new Error(`unknown arg ${a}`);
  }
  if (!Number.isInteger(o.pr) || o.pr <= 0) throw new Error('--pr <n> required');
  if (!['merge', 'squash', 'rebase'].includes(o.method)) throw new Error('--method merge|squash|rebase');
  return o;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    opts.repo ??= resolveRepo(defaultGh);
  } catch (e) {
    process.stderr.write(`merge-gate: ${e.message}\n`);
    process.exit(EXIT.ERROR);
  }
  let res;
  try {
    res = runGate(opts);
  } catch (e) {
    process.stderr.write(`merge-gate: ${e.message}\n`);
    process.exit(EXIT.ERROR);
  }
  const { prMeta, checks, threads, migrations, verdict } = res;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ pr: prMeta.number, head: prMeta.headRefOid, verdict, checks: { verdict: checks.verdict, total: checks.total, failed: checks.failed, pending: checks.pending, missing: checks.missing }, threads: { unresolved: threads.unresolved.length, codex: threads.codex.map((t) => t.id) }, migrations }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `PR #${prMeta.number} @ ${prMeta.headRefOid.slice(0, 10)} → ${prMeta.baseRefName}\n`
      + `  checks: ${checks.verdict} (${checks.green.length}/${checks.total} green, ${checks.pending.length} pending, ${checks.failed.length} failed)\n`
      + `  threads: ${threads.unresolved.length} unresolved (${threads.codex.length} Codex)\n`
      + `  migrations: ${migrations ? (migrations.ok ? `ok (${migrations.added.length} new)` : 'BLOCKED') : 'skipped'}\n`
      + (migrations?.renames ?? []).map((r) => `    rename allowed: ${r}\n`).join('')
      + (migrations && !migrations.ok ? migrations.problems.map((p) => `    problem: ${p}\n`).join('') : '')
      + `>>> MERGE-GATE: exit=${verdict.exit} ${verdict.reason}\n`,
    );
  }
  process.exit(verdict.exit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

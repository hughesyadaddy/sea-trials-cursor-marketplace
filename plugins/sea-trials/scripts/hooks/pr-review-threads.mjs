#!/usr/bin/env node
/**
 * Canonical reply-and-resolve for GitHub PR review threads.
 *
 * `pr-review-loop.mjs` only DETECTS unresolved threads — it exits
 * non-zero as a handoff signal and never replies or resolves. That left
 * every agent hand-rolling the GraphQL, and the failure modes are all
 * silent: a first-page-only query hides threads past 100 and reads as
 * "nothing left to do"; a reply posted as a new top-level comment leaves
 * the thread unresolved; and `resolveReviewThread` returning without
 * error is not proof the thread is resolved.
 *
 * So every mutation here is verified by re-reading the thread (a single
 * `node(id:)` query, not the whole PR), and `close` refuses to resolve a
 * thread it could not reply to. A bot that cannot see the reply will just
 * raise the finding again. Every reply must cite the commit it refers to.
 *
 * Usage:
 *   pr-review-threads.mjs list   --pr <n> [--repo owner/name] [--all] [--json]
 *   pr-review-threads.mjs close  --pr <n> --thread <id> --sha <sha>
 *     (--body <text> | --body-file <path>) [--repo owner/name]
 *   pr-review-threads.mjs comment --pr <n> --sha <sha> --body <text>
 *     [--minimize <review-node-id>] [--repo owner/name]
 *   pr-review-threads.mjs verify --pr <n> [--repo owner/name]
 *   pr-review-threads.mjs format --verdict valid|reject|stale|defer
 *     --summary <text> [--sha <short>] [--bounded]
 *
 * `--repo` falls back to `GH_REPO`, then to `gh repo view` on the current
 * checkout. `list` shows unresolved threads only unless `--all` is passed.
 * `verify` exits 1 while any thread is unresolved, so it can gate a push.
 * `comment` handles top-level review bodies that have no inline thread
 * (those cannot be resolved): it posts an issue comment and optionally
 * minimizes the original review as RESOLVED.
 */

import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { getRepoRoot, resolveGithubOwnerRepo } from './lib/pr-review-lib.mjs';

const execFileAsync = promisify(execFile);
const GH_MAX_BUFFER = 64 * 1024 * 1024;

/** Parallel comment-pagination fan-out per thread list. */
export const COMMENT_FETCH_CONCURRENCY = 6;

/**
 * Machine-readable verdict prefix for bot reviewers (Codex, Bugbot, etc.).
 * Codex re-reads resolved threads on later pushes; explicit VALID/REJECT/STALE
 * labels reduce repeat false positives and document why no code changed.
 *
 * @typedef {'valid'|'reject'|'stale'|'defer'} BotReviewVerdict
 */

/**
 * @param {{
 *   verdict: BotReviewVerdict,
 *   summary: string,
 *   sha?: string,
 *   bounded?: boolean,
 * }} opts
 * @returns {string}
 */
export function formatBotReviewReply({ verdict, summary, sha, bounded }) {
  const label = verdict.toUpperCase();
  let header;
  if (verdict === 'valid') {
    const applied = sha ? ` — applied in \`${sha}\`` : '';
    const boundedTag = bounded ? ' (bounded)' : '';
    header = `**Adversarial vet: VALID${boundedTag}${applied}.**`;
  } else if (verdict === 'stale') {
    header = '**Adversarial vet: STALE — no code change.**';
  } else if (verdict === 'defer') {
    header = '**Adversarial vet: DEFER — follow-up, not blocking merge.**';
  } else {
    header = `**Adversarial vet: ${label}.**`;
  }
  const detail = summary.trim();
  let body = detail ? `${header} ${detail}` : header;
  // Non-VALID verdicts still name the head they were judged against so
  // a bot re-reviewing a later push can tell the reply is current.
  if (sha && verdict !== 'valid') {
    body += ` (reviewed at \`${sha}\`)`;
  }
  return body;
}

/**
 * True when the body already names a commit (7–40 hex chars, usually
 * inside backticks).
 *
 * @param {string} body
 */
export function bodyCitesSha(body) {
  return /(?:^|[^0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/i.test(body ?? '');
}

/**
 * Guarantee a reply cites the fix commit. Appends a `Head:` line when the
 * caller passed `--sha` and the body has none; throws when neither.
 *
 * @param {string} body
 * @param {string | undefined} sha
 */
export function ensureReplyCitesSha(body, sha) {
  if (bodyCitesSha(body)) return body;
  if (sha && /^[0-9a-f]{7,40}$/i.test(sha)) {
    return `${body.trimEnd()}\n\nHead: \`${sha}\``;
  }
  throw new Error(
    'reply must cite the fix commit: include the SHA in --body or pass '
      + '--sha $(git rev-parse --short HEAD)',
  );
}

/**
 * @param {string | undefined} explicit `--repo owner/name` or GH_REPO
 * @param {{ lookup?: () => { owner: string, name: string } }} [deps]
 * @returns {{owner:string,name:string}}
 */
export function resolveRepo(explicit, { lookup } = {}) {
  const slug = explicit ?? process.env.GH_REPO;
  if (!slug) {
    const fallback = lookup ?? (() => resolveGithubOwnerRepo(getRepoRoot()));
    try {
      return fallback();
    } catch (err) {
      throw new Error(
        'target repository required: pass --repo owner/name, set GH_REPO, '
          + `or run inside a GitHub checkout (${err.message})`,
      );
    }
  }
  const slash = slug.indexOf('/');
  if (slash <= 0 || slash === slug.length - 1) {
    throw new Error('target repository must be owner/name');
  }
  return { owner: slug.slice(0, slash), name: slug.slice(slash + 1) };
}

/**
 * @param {string[]} args
 * @param {string} [input]
 */
function gh(args, input) {
  const res = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    maxBuffer: GH_MAX_BUFFER,
  });
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed (${res.status}): ` +
        `${res.stderr?.trim() || res.stdout?.trim()}`,
    );
  }
  return res.stdout;
}

/** @param {string[]} args */
async function ghAsync(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8',
      maxBuffer: GH_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    const detail = err.stderr?.trim() || err.stdout?.trim() || err.message;
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed (${err.code ?? '?'}): ${detail}`,
    );
  }
}

/**
 * Throws on GraphQL-level errors, including HTTP-200 `RATE_LIMITED`.
 *
 * @param {Record<string, any>} data
 */
function assertGraphqlOk(data) {
  if (!data?.errors?.length) return data;
  const rateLimited = data.errors.some((e) => e?.type === 'RATE_LIMITED');
  const message = data.errors.map((e) => e?.message).join('; ');
  throw new Error(
    rateLimited
      ? `GitHub GraphQL rate limited: ${message}`
      : `GitHub GraphQL error: ${message}`,
  );
}

const COMMENT_FIELDS = 'fullDatabaseId author{login} body createdAt url';

const THREAD_QUERY = `
query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated path line originalLine subjectType
          comments(first:100){
            pageInfo{hasNextPage endCursor}
            nodes{${COMMENT_FIELDS}}
          }
        }
      }
    }
  }
}`;

const COMMENTS_QUERY = `
query($threadId:ID!,$cursor:String){
  node(id:$threadId){
    ... on PullRequestReviewThread{
      comments(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{${COMMENT_FIELDS}}
      }
    }
  }
}`;

const SINGLE_THREAD_QUERY = `
query($threadId:ID!){
  node(id:$threadId){
    ... on PullRequestReviewThread{
      id isResolved isOutdated path line originalLine subjectType
      comments(first:100){
        pageInfo{hasNextPage endCursor}
        nodes{${COMMENT_FIELDS}}
      }
    }
  }
}`;

/**
 * @param {Record<string, any>} node GraphQL comment node
 * @returns {number | null}
 */
function commentId(node) {
  const raw = node?.fullDatabaseId ?? node?.databaseId ?? null;
  if (raw == null || raw === '') return null;
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * @param {Array<Record<string, any>>} nodes
 * @returns {typeof nodes}
 */
function sortComments(nodes) {
  return [...nodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * Run `fn` over `items` with at most `limit` in flight.
 *
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
export async function mapWithConcurrency(items, limit, fn) {
  /** @type {R[]} */
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        results[index] = await fn(items[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * @param {string} threadId
 * @param {Array<Record<string, any>>} seed
 * @param {{hasNextPage:boolean,endCursor:string|null}} pageInfo
 * @param {(args: string[]) => Promise<string>} [runner]
 */
async function fetchAllComments(threadId, seed, pageInfo, runner = ghAsync) {
  const comments = [...seed];
  if (!pageInfo?.hasNextPage) return sortComments(comments);

  let cursor = pageInfo.endCursor;

  for (let page = 0; page < 50; page += 1) {
    const args = [
      'api', 'graphql',
      '-f', `query=${COMMENTS_QUERY}`,
      '-F', `threadId=${threadId}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);

    const data = assertGraphqlOk(JSON.parse(await runner(args)));
    const block = data.data.node?.comments;
    if (!block) break;

    for (const node of block.nodes) {
      if (!comments.some((c) => commentId(c) === commentId(node))) {
        comments.push(node);
      }
    }
    if (!block.pageInfo.hasNextPage) break;
    cursor = block.pageInfo.endCursor;
  }

  return sortComments(comments);
}

/**
 * @param {Record<string, any>} node thread node with full comment list
 * @param {Array<Record<string, any>>} comments sorted comments
 */
export function mapThread(node, comments) {
  const head = comments[0] ?? {};
  return {
    id: node.id,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    path: node.path,
    line: node.line ?? node.originalLine ?? null,
    subjectType: node.subjectType ?? null,
    author: head.author?.login ?? '(unknown)',
    commentId: commentId(head),
    url: head.url ?? null,
    body: head.body ?? '',
    comments: comments.map((c) => ({
      id: commentId(c),
      author: c.author?.login ?? '(unknown)',
      body: c.body ?? '',
      createdAt: c.createdAt,
    })),
  };
}

/**
 * Every review thread on a PR, following pagination to the last page.
 * Per-thread comment pagination (rare: >100 replies) runs in parallel.
 *
 * @param {number} pr
 * @param {{owner:string,name:string}} repo
 * @param {{ runner?: (args: string[]) => Promise<string> }} [deps]
 */
export async function fetchThreads(pr, repo, { runner = ghAsync } = {}) {
  /** @type {Array<Record<string, any>>} */
  const nodes = [];
  let cursor = null;
  let terminated = false;

  for (let page = 0; page < 50; page += 1) {
    const args = [
      'api', 'graphql',
      '-f', `query=${THREAD_QUERY}`,
      '-F', `owner=${repo.owner}`,
      '-F', `name=${repo.name}`,
      '-F', `pr=${pr}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);

    const data = assertGraphqlOk(JSON.parse(await runner(args)));
    const block = data.data.repository.pullRequest.reviewThreads;
    nodes.push(...block.nodes);
    if (!block.pageInfo.hasNextPage) {
      terminated = true;
      break;
    }
    cursor = block.pageInfo.endCursor;
  }
  if (!terminated) {
    throw new Error(`thread pagination did not terminate for PR ${pr}`);
  }

  const commentLists = await mapWithConcurrency(
    nodes,
    COMMENT_FETCH_CONCURRENCY,
    (node) =>
      fetchAllComments(
        node.id,
        node.comments.nodes,
        node.comments.pageInfo,
        runner,
      ),
  );
  return nodes.map((node, i) => mapThread(node, commentLists[i]));
}

/**
 * One thread by node id — what `close` uses before and after mutating,
 * instead of re-reading every thread on the PR.
 *
 * @param {string} threadId
 * @param {{ runner?: (args: string[]) => Promise<string> }} [deps]
 */
export async function fetchThread(threadId, { runner = ghAsync } = {}) {
  const data = assertGraphqlOk(
    JSON.parse(
      await runner([
        'api', 'graphql',
        '-f', `query=${SINGLE_THREAD_QUERY}`,
        '-F', `threadId=${threadId}`,
      ]),
    ),
  );
  const node = data.data.node;
  if (!node?.id) return null;
  const comments = await fetchAllComments(
    node.id,
    node.comments.nodes,
    node.comments.pageInfo,
    runner,
  );
  return mapThread(node, comments);
}

/**
 * Reply inside the thread, not as a new top-level comment.
 *
 * Uses REST `.../comments/{top_level_id}/replies`, which threads a reply
 * to the head comment. A plain POST to the comments endpoint creates a
 * detached comment and the thread still reads as unanswered.
 *
 * @param {number} pr
 * @param {number | null} commentId REST id of the thread's first comment
 * @param {string} body
 * @param {{owner:string,name:string}} repo
 * @param {{ run?: (args: string[]) => string }} [deps]
 */
export function replyToThread(pr, commentId, body, repo, { run = gh } = {}) {
  if (!commentId) {
    throw new Error('thread has no head comment id; cannot reply in-thread');
  }
  const base = `repos/${repo.owner}/${repo.name}/pulls/${pr}/comments`;
  run([
    'api', '--method', 'POST', `${base}/${commentId}/replies`,
    '-f', `body=${body}`,
  ]);
}

/**
 * @param {string} threadId
 * @param {{ run?: (args: string[]) => string }} [deps]
 */
export function resolveThread(threadId, { run = gh } = {}) {
  assertGraphqlOk(
    JSON.parse(
      run([
        'api', 'graphql',
        '-f',
        'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id})' +
          '{thread{isResolved}}}',
        '-F', `id=${threadId}`,
      ]) || '{}',
    ),
  );
}

/**
 * Hide a top-level review body (no inline thread → cannot be resolved)
 * once it has been answered with an issue comment.
 *
 * @param {string} subjectId node id of the review / comment
 * @param {{ run?: (args: string[]) => string }} [deps]
 */
export function minimizeComment(subjectId, { run = gh } = {}) {
  assertGraphqlOk(
    JSON.parse(
      run([
        'api', 'graphql',
        '-f',
        'query=mutation($id:ID!){minimizeComment(input:{subjectId:$id,' +
          'classifier:RESOLVED}){minimizedComment{isMinimized}}}',
        '-F', `id=${subjectId}`,
      ]) || '{}',
    ),
  );
}

/**
 * Issue comment on the PR conversation (for review bodies without a
 * thread). Returns the new comment's REST id.
 *
 * @param {number} pr
 * @param {string} body
 * @param {{owner:string,name:string}} repo
 * @param {{ run?: (args: string[]) => string }} [deps]
 */
export function postIssueComment(pr, body, repo, { run = gh } = {}) {
  const out = run([
    'api', '--method', 'POST',
    `repos/${repo.owner}/${repo.name}/issues/${pr}/comments`,
    '-f', `body=${body}`,
  ]);
  try {
    return JSON.parse(out).id ?? null;
  } catch {
    return null;
  }
}

/**
 * @param {Array<{body:string}>} comments
 * @param {string} body
 */
export function hasMatchingReply(comments, body) {
  const trimmed = body.trim();
  return comments.slice(1).some((c) => c.body?.trim() === trimmed);
}

/**
 * Reply, resolve, then confirm from a fresh single-thread read.
 *
 * Order matters: replying second would risk resolving a thread whose
 * explanation never posted, which reads to a reviewer as a silent
 * dismissal. Retries skip the reply when the same body is already in
 * the chain so a transient resolve failure can be retried safely.
 *
 * @param {number} pr
 * @param {string} threadId
 * @param {string} body must cite a commit (see `ensureReplyCitesSha`)
 * @param {{owner:string,name:string}} repo
 * @param {{
 *   sha?: string,
 *   runner?: (args: string[]) => Promise<string>,
 *   run?: (args: string[]) => string,
 * }} [deps]
 */
export async function closeThread(pr, threadId, body, repo, deps = {}) {
  const { sha, runner = ghAsync, run = gh } = deps;
  const reply = ensureReplyCitesSha(body, sha);

  const before = await fetchThread(threadId, { runner });
  if (!before) throw new Error(`thread ${threadId} not found on PR ${pr}`);
  if (before.isResolved) return { skipped: true, reason: 'already resolved' };

  const alreadyReplied = hasMatchingReply(before.comments, reply);
  if (!alreadyReplied) {
    replyToThread(pr, before.commentId, reply, repo, { run });
  }
  resolveThread(threadId, { run });

  const after = await fetchThread(threadId, { runner });
  if (!after?.isResolved) {
    throw new Error(
      `resolve reported success but thread ${threadId} is still ` +
        'unresolved — do not treat this as done',
    );
  }
  return { skipped: false, replySkipped: alreadyReplied, body: reply };
}

/** Drop pnpm's literal `--` before the subcommand (pnpm 10). */
export function argvWithoutPnpmSeparator(argv) {
  if (argv[0] === '--') {
    return argv.slice(1);
  }
  return argv;
}

function parseArgs(argv) {
  const out = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all' || arg === '--json' || arg === '--bounded') {
      out[arg.slice(2)] = true;
    } else if (arg.startsWith('--')) {
      out[arg.slice(2).replace(/-/g, '_')] = argv[++i];
    }
  }
  return out;
}

function formatCommentChain(comments) {
  return comments
    .map((c) => {
      const excerpt = c.body.split('\n').slice(0, 4).join('\n  ');
      return `  [${c.author}] ${excerpt.slice(0, 400)}`;
    })
    .join('\n');
}

async function main() {
  const args = parseArgs(argvWithoutPnpmSeparator(process.argv.slice(2)));
  const pr = Number(args.pr);

  if (!args.command) {
    process.stderr.write(
      'usage: pr-review-threads.mjs <list|close|comment|verify|format> ...\n',
    );
    process.exit(2);
  }

  if (args.command === 'format') {
    const verdict = args.verdict;
    const summary = args.summary;
    if (!verdict || !summary) {
      process.stderr.write(
        'format needs --verdict valid|reject|stale|defer and --summary\n',
      );
      process.exit(2);
    }
    process.stdout.write(
      `${formatBotReviewReply({
        verdict,
        summary,
        sha: args.sha,
        bounded: Boolean(args.bounded),
      })}\n`,
    );
    return;
  }

  if (!Number.isInteger(pr)) {
    process.stderr.write(
      'usage: pr-review-threads.mjs <list|close|comment|verify> --pr <n> ' +
        '[--repo owner/name] [--thread <id>] [--sha <sha>] ' +
        '[--body <text>|--body-file <path>] [--all] [--json]\n',
    );
    process.exit(2);
  }

  let repo;
  try {
    repo = resolveRepo(args.repo);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }

  if (args.command === 'list') {
    const all = await fetchThreads(pr, repo);
    const shown = args.all ? all : all.filter((t) => !t.isResolved);
    if (args.json) {
      process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
      return;
    }
    process.stdout.write(
      `PR #${pr} (${repo.owner}/${repo.name}): ${all.length} thread(s), ` +
        `${all.filter((t) => !t.isResolved).length} unresolved\n\n`,
    );
    for (const t of shown) {
      const flag = t.isResolved ? 'resolved' : 'UNRESOLVED';
      process.stdout.write(
        `[${flag}] ${t.author} ${t.path}:${t.line ?? 0}` +
          `${t.isOutdated ? ' (outdated)' : ''}\n  id=${t.id}\n` +
          `${formatCommentChain(t.comments)}\n\n`,
      );
    }
    return;
  }

  if (args.command === 'close') {
    const body = args.body_file
      ? fs.readFileSync(args.body_file, 'utf8')
      : args.body;
    if (!args.thread || !body) {
      process.stderr.write(
        'close needs --thread, --body/--body-file, and a cited SHA '
          + '(--sha or in the body)\n',
      );
      process.exit(2);
    }
    const result = await closeThread(pr, args.thread, body, repo, {
      sha: args.sha,
    });
    if (result.skipped) {
      process.stdout.write(`thread ${args.thread}: ${result.reason}\n`);
    } else if (result.replySkipped) {
      process.stdout.write(
        `thread ${args.thread}: reply already present; resolved (verified)\n`,
      );
    } else {
      process.stdout.write(
        `thread ${args.thread}: replied and resolved (verified)\n`,
      );
    }
    return;
  }

  if (args.command === 'comment') {
    const body = args.body_file
      ? fs.readFileSync(args.body_file, 'utf8')
      : args.body;
    if (!body) {
      process.stderr.write('comment needs --body/--body-file\n');
      process.exit(2);
    }
    const reply = ensureReplyCitesSha(body, args.sha);
    const id = postIssueComment(pr, reply, repo);
    process.stdout.write(`PR #${pr}: issue comment posted (id=${id})\n`);
    if (args.minimize) {
      minimizeComment(args.minimize);
      process.stdout.write(`minimized ${args.minimize} as RESOLVED\n`);
    }
    return;
  }

  if (args.command === 'verify') {
    const unresolved = (await fetchThreads(pr, repo)).filter(
      (t) => !t.isResolved,
    );
    if (unresolved.length === 0) {
      process.stdout.write(`PR #${pr}: 0 unresolved threads\n`);
      return;
    }
    process.stderr.write(`PR #${pr}: ${unresolved.length} unresolved\n`);
    for (const t of unresolved) {
      process.stderr.write(`  ${t.author} ${t.path}:${t.line ?? 0} ${t.id}\n`);
    }
    process.exit(1);
  }

  process.stderr.write(`unknown command: ${args.command}\n`);
  process.exit(2);
}

if (process.argv[1]?.endsWith('pr-review-threads.mjs')) {
  main().catch((err) => {
    process.stderr.write(`pr-review-threads: ${err.message}\n`);
    process.exit(1);
  });
}

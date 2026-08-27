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
 * So every mutation here is verified by re-reading the thread, and
 * `close` refuses to resolve a thread it could not reply to. A bot that
 * cannot see the reply will just raise the finding again.
 *
 * Usage:
 *   pr-review-threads.mjs list   --pr <n> --repo owner/name [--all] [--json]
 *   pr-review-threads.mjs close  --pr <n> --repo owner/name --thread <id>
 *     --body <text>
 *   pr-review-threads.mjs close  --pr <n> --repo owner/name --thread <id>
 *     --body-file <path>
 *   pr-review-threads.mjs verify --pr <n> --repo owner/name
 *   pr-review-threads.mjs format --verdict valid|reject|stale|defer
 *     --summary <text> [--sha <short>] [--bounded]
 *
 * `list` shows unresolved threads only unless `--all` is passed.
 * `verify` exits 1 while any thread is unresolved, so it can gate a push.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

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
    header = '**Adversarial vet: REJECT.**';
  }
  const detail = summary.trim();
  return detail ? `${header} ${detail}` : header;
}

/**
 * @param {string | undefined} explicit `--repo owner/name` or GH_REPO
 * @returns {{owner:string,name:string}}
 */
export function resolveRepo(explicit) {
  const slug = explicit ?? process.env.GH_REPO;
  if (!slug) {
    throw new Error(
      'target repository required: pass --repo owner/name or set GH_REPO',
    );
  }
  const slash = slug.indexOf('/');
  if (slash <= 0 || slash === slug.length - 1) {
    throw new Error(
      'target repository must be owner/name (for example hughesyadaddy/sea_trials_universal)',
    );
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
    maxBuffer: 64 * 1024 * 1024,
  });
  if (res.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed (${res.status}): ` +
        `${res.stderr?.trim() || res.stdout?.trim()}`,
    );
  }
  return res.stdout;
}

const THREAD_QUERY = `
query($owner:String!,$name:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$pr){
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{
          id isResolved isOutdated path line
          comments(first:100){
            pageInfo{hasNextPage endCursor}
            nodes{databaseId author{login} body createdAt}
          }
        }
      }
    }
  }
}`;

const COMMENTS_QUERY = `
query($owner:String!,$name:String!,$threadId:ID!,$cursor:String){
  node(id:$threadId){
    ... on PullRequestReviewThread{
      comments(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{databaseId author{login} body createdAt}
      }
    }
  }
}`;

/**
 * @param {Array<{databaseId:number,author?:{login:string},body:string,createdAt:string}>} nodes
 * @returns {typeof nodes}
 */
function sortComments(nodes) {
  return [...nodes].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

/**
 * @param {string} threadId
 * @param {{owner:string,name:string}} repo
 * @param {Array<{databaseId:number,author?:{login:string},body:string,createdAt:string}>} seed
 * @param {{hasNextPage:boolean,endCursor:string|null}} pageInfo
 */
function fetchAllComments(threadId, repo, seed, pageInfo) {
  const comments = [...seed];
  if (!pageInfo.hasNextPage) return sortComments(comments);

  let cursor = pageInfo.endCursor;

  for (let page = 0; page < 50; page += 1) {
    const args = [
      'api', 'graphql',
      '-f', `query=${COMMENTS_QUERY}`,
      '-F', `owner=${repo.owner}`,
      '-F', `name=${repo.name}`,
      '-F', `threadId=${threadId}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);

    const data = JSON.parse(gh(args));
    const block = data.data.node?.comments;
    if (!block) break;

    for (const node of block.nodes) {
      if (!comments.some((c) => c.databaseId === node.databaseId)) {
        comments.push(node);
      }
    }
    if (!block.pageInfo.hasNextPage) break;
    cursor = block.pageInfo.endCursor;
  }

  return sortComments(comments);
}

/**
 * Every review thread on a PR, following pagination to the last page.
 *
 * @param {number} pr
 * @param {{owner:string,name:string}} repo
 */
export function fetchThreads(pr, repo) {
  const threads = [];
  let cursor = null;

  for (let page = 0; page < 50; page += 1) {
    const args = [
      'api', 'graphql',
      '-f', `query=${THREAD_QUERY}`,
      '-F', `owner=${repo.owner}`,
      '-F', `name=${repo.name}`,
      '-F', `pr=${pr}`,
    ];
    if (cursor) args.push('-F', `cursor=${cursor}`);

    const data = JSON.parse(gh(args));
    const block = data.data.repository.pullRequest.reviewThreads;
    for (const node of block.nodes) {
      const comments = fetchAllComments(
        node.id,
        repo,
        node.comments.nodes,
        node.comments.pageInfo,
      );
      const head = comments[0] ?? {};
      threads.push({
        id: node.id,
        isResolved: node.isResolved,
        isOutdated: node.isOutdated,
        path: node.path,
        line: node.line,
        author: head.author?.login ?? '(unknown)',
        commentId: head.databaseId,
        body: head.body ?? '',
        comments: comments.map((c) => ({
          id: c.databaseId,
          author: c.author?.login ?? '(unknown)',
          body: c.body ?? '',
          createdAt: c.createdAt,
        })),
      });
    }
    if (!block.pageInfo.hasNextPage) return threads;
    cursor = block.pageInfo.endCursor;
  }
  throw new Error(`thread pagination did not terminate for PR ${pr}`);
}

/**
 * Reply inside the thread, not as a new top-level comment.
 *
 * Uses REST `in_reply_to`, which is what threads a reply to an existing
 * comment. A plain POST to the comments endpoint without it creates a
 * detached comment and the thread still reads as unanswered.
 */
export function replyToThread(pr, commentId, body, repo) {
  if (!commentId) {
    throw new Error('thread has no head comment id; cannot reply in-thread');
  }
  gh([
    'api', '--method', 'POST',
    `repos/${repo.owner}/${repo.name}/pulls/${pr}/comments/${commentId}/replies`,
    '-f', `body=${body}`,
  ]);
}

export function resolveThread(threadId) {
  gh([
    'api', 'graphql',
    '-f',
    'query=mutation($id:ID!){resolveReviewThread(input:{threadId:$id})' +
      '{thread{isResolved}}}',
    '-F', `id=${threadId}`,
  ]);
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
 * Reply, resolve, then confirm from a fresh read.
 *
 * Order matters: replying second would risk resolving a thread whose
 * explanation never posted, which reads to a reviewer as a silent
 * dismissal. Retries skip the reply when the same body is already in
 * the chain so a transient resolve failure can be retried safely.
 */
export function closeThread(pr, threadId, body, repo) {
  const before = fetchThreads(pr, repo).find((t) => t.id === threadId);
  if (!before) throw new Error(`thread ${threadId} not found on PR ${pr}`);
  if (before.isResolved) return { skipped: true, reason: 'already resolved' };

  const alreadyReplied = hasMatchingReply(before.comments, body);
  if (!alreadyReplied) {
    replyToThread(pr, before.commentId, body, repo);
  }
  resolveThread(threadId);

  const after = fetchThreads(pr, repo).find((t) => t.id === threadId);
  if (!after?.isResolved) {
    throw new Error(
      `resolve reported success but thread ${threadId} is still ` +
        'unresolved — do not treat this as done',
    );
  }
  return { skipped: false, replySkipped: alreadyReplied };
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
    .map(
      (c) =>
        `  [${c.author}] ${c.body.split('\n').slice(0, 4).join('\n  ').slice(0, 400)}`,
    )
    .join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const pr = Number(args.pr);

  if (!args.command) {
    process.stderr.write(
      'usage: pr-review-threads.mjs <list|close|verify|format> ...\n',
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
      'usage: pr-review-threads.mjs <list|close|verify> --pr <n> ' +
        '--repo owner/name [--thread <id>] ' +
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
    const all = fetchThreads(pr, repo);
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
      process.stderr.write('close needs --thread and --body/--body-file\n');
      process.exit(2);
    }
    const result = closeThread(pr, args.thread, body, repo);
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

  if (args.command === 'verify') {
    const unresolved = fetchThreads(pr, repo).filter((t) => !t.isResolved);
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

if (process.argv[1]?.endsWith('pr-review-threads.mjs')) main();

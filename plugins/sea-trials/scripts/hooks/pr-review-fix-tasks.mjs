#!/usr/bin/env node
/**
 * Emit one fix-worker Task per unresolved PR thread (path-scoped edits).
 *
 * Run AFTER adversarial vet when threads need code changes. Parent launches
 * all lines in ONE turn; workers must not push or resolve threads.
 *
 *   pnpm pr-review-fix-tasks -- --pr 1657 --repo owner/name
 */
import { fetchThreads, resolveRepo } from './pr-review-threads.mjs';

function parseArgs(argv) {
  const out = { pr: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pr') out.pr = Number(argv[++i]);
    else if (argv[i] === '--repo') out.repo = argv[++i];
  }
  if (!out.pr || Number.isNaN(out.pr)) {
    throw new Error('usage: pr-review-fix-tasks --pr <n> [--repo owner/name]');
  }
  return out;
}

function main() {
  const { pr, repo: repoSlug } = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(repoSlug);
  const threads = fetchThreads(pr, repo).filter((t) => !t.isResolved);

  for (const thread of threads) {
    const excerpt = (thread.body ?? '').slice(0, 400);
    const task = {
      source: 'review-fix',
      taskId: `${thread.id}:fix`,
      threadId: thread.id,
      path: thread.path,
      line: thread.line,
      subagent_type: 'generalPurpose',
      description: `Fix PR thread ${thread.path}`,
      prompt:
        `Implement the minimal fix for PR #${pr} thread ${thread.id}.\n` +
        `File: ${thread.path}:${thread.line ?? '?'}\n` +
        `Bot: ${thread.author}\n` +
        `Finding:\n${excerpt}\n\n` +
        `Rules: edit ONLY ${thread.path} and tests that cover this hunk; ` +
        `no git push; no thread reply; run pnpm agent-validate on touched ` +
        `files; return summary of changes.`,
    };
    process.stdout.write(`${JSON.stringify(task)}\n`);
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(`pr-review-fix-tasks: ${err.message}\n`);
  process.exit(1);
}

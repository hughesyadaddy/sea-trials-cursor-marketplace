#!/usr/bin/env node
/**
 * Emit one fix-worker Task per unresolved PR thread (path-scoped edits).
 *
 * Run AFTER parent Phase 2 triage for (a) valid-fix threads only.
 *
 *   pnpm pr-review-fix-tasks -- --pr 1657 --threads PRRT_kw...,PRRT_kw...
 */
import { fetchThreads, resolveRepo } from './pr-review-threads.mjs';

function parseArgs(argv) {
  const out = { pr: null, repo: null, threads: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--pr') out.pr = Number(argv[++i]);
    else if (argv[i] === '--repo') out.repo = argv[++i];
    else if (argv[i] === '--threads') {
      out.threads = new Set(
        argv[++i]
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean),
      );
    }
  }
  if (!out.pr || Number.isNaN(out.pr)) {
    throw new Error(
      'usage: pr-review-fix-tasks --pr <n> --threads id1,id2 [--repo owner/name]',
    );
  }
  if (!out.threads || out.threads.size === 0) {
    throw new Error(
      'pr-review-fix-tasks requires --threads with Phase 2 (a) valid-fix ids',
    );
  }
  return out;
}

function main() {
  const { pr, repo: repoSlug, threads: allowed } = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(repoSlug);
  const threads = fetchThreads(pr, repo).filter(
    (t) => !t.isResolved && allowed.has(t.id),
  );

  const byPath = new Map();
  for (const thread of threads) {
    const key = thread.path ?? '(no-path)';
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(thread);
  }

  for (const [filePath, group] of byPath) {
    const findings = group
      .map(
        (thread) =>
          `- ${thread.id} @ line ${thread.line ?? '?'}: ${(thread.body ?? '').slice(0, 280)}`,
      )
      .join('\n');
    const threadIds = group.map((t) => t.id).join(',');
    const task = {
      source: 'review-fix',
      taskId: `${group[0].id}:fix`,
      threadIds: group.map((t) => t.id),
      path: filePath,
      subagent_type: 'generalPurpose',
      description: `Fix PR threads on ${filePath}`,
      prompt:
        `Implement minimal fixes for PR #${pr} on ${filePath}.\n` +
        `Threads: ${threadIds}\n\n` +
        `Findings:\n${findings}\n\n` +
        `Rules: edit ONLY ${filePath} and tests that cover these hunks; ` +
        `one worker owns this file; no git push; no thread reply; run ` +
        `pnpm agent-validate on touched files; return summary of changes.`,
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

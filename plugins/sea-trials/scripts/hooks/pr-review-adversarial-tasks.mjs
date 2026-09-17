#!/usr/bin/env node
/**
 * Emit JSON lines for parallel adversarial subagent fan-out — 3 agents per
 * unresolved PR review thread (Codex, Bugbot, human reviewers).
 *
 * Parent agent: launch one Task per line in a single turn, then synthesize
 * verdicts before `pr-review-threads close`.
 *
 *   pnpm pr-review-adversarial-tasks -- --pr 1657
 *   pnpm pr-review-adversarial-tasks -- --pr 1657 --repo owner/name
 *
 * Each line:
 *   { "taskId", "threadId", "path", "line", "author", "subagent_type", "focus" }
 */
import { fetchThreads, resolveRepo } from './pr-review-threads.mjs';

const AGENTS = [
  {
    subagent_type: 'code-simplicity-review-agent',
    focus: 'Minimal correct fix; reject scope creep and YAGNI violations',
  },
  {
    subagent_type: 'vgv-review-agent',
    focus: 'VGV architecture, layer rules, and repo contracts (AGENTS.md)',
  },
  {
    subagent_type: 'test-quality-review-agent',
    focus: 'Regression risk; tests must fail if the guard is removed',
  },
];

function parseArgs(argv) {
  const out = { pr: null, repo: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--pr') out.pr = Number(argv[++i]);
    else if (arg === '--repo') out.repo = argv[++i];
  }
  if (!out.pr || Number.isNaN(out.pr)) {
    throw new Error('usage: pr-review-adversarial-tasks --pr <n> [--repo owner/name]');
  }
  return out;
}

function main() {
  const { pr, repo: repoSlug } = parseArgs(process.argv.slice(2));
  const repo = resolveRepo(repoSlug);
  const threads = fetchThreads(pr, repo).filter((t) => !t.isResolved);

  for (const thread of threads) {
    const excerpt = (thread.body ?? '').slice(0, 500);
    for (const agent of AGENTS) {
      const task = {
        taskId: `${thread.id}:${agent.subagent_type}`,
        threadId: thread.id,
        path: thread.path,
        line: thread.line,
        author: thread.author,
        subagent_type: agent.subagent_type,
        focus: agent.focus,
        prompt:
          `Adversarial PR review vet for thread ${thread.id} on PR #${pr}.\n` +
          `File: ${thread.path}:${thread.line ?? '?'}\n` +
          `Bot: ${thread.author}\n` +
          `Finding excerpt:\n${excerpt}\n\n` +
          `Return ONLY: verdict (VALID|REJECT|STALE|DEFER), one-paragraph ` +
          `evidence, and suggested reply summary. Do not edit files.`,
      };
      process.stdout.write(`${JSON.stringify(task)}\n`);
    }
  }
}

main();

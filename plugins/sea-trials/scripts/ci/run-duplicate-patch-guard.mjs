/**
 * CI entry point for the duplicate-patch guard.
 *
 * Warn-only by design for the first two weeks. There is no field data on
 * the false-positive rate yet, and a guard that fails wrongly teaches
 * authors to reach for the escape hatch reflexively — after which it is
 * decoration. Findings go to the job summary; the step always exits 0.
 * Flip with DUPLICATE_PATCH_GUARD_ENFORCE=true once the rate is known.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

import {
  PATCH_ID_WINDOW,
  findDuplicatePatches,
  formatFindings,
  shouldRunGuard,
} from './duplicate-patch-guard.mjs';

/* c8 ignore start -- CLI wrapper; the logic it calls is tested directly. */
async function main() {
  const baseRef = process.env.GITHUB_BASE_REF ?? '';
  const actor = process.env.GITHUB_ACTOR ?? '';
  const headRef = process.env.GITHUB_HEAD_REF ?? '';
  const enforce = process.env.DUPLICATE_PATCH_GUARD_ENFORCE === 'true';
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;

  const decision = shouldRunGuard({ baseRef, actor, headRef });
  if (!decision.run) {
    // Say so in the summary too. A green check with an empty summary reads
    // as "no duplicates" when it means "we did not look".
    const msg = `## Duplicate-patch guard\n\nSkipped — ${decision.reason}. No comparison was performed.\n`;
    if (summaryPath) appendFileSync(summaryPath, msg);
    process.stdout.write(`duplicate-patch-guard: skipped — ${decision.reason}\n`);
    return 0;
  }

  const base = `origin/${baseRef}`;
  // Prove the trunk is actually readable before trusting a clean result.
  // checkout on `pull_request` fetches the merge ref, not the base branch,
  // so without an explicit fetch this ref does not exist and every run
  // would report "no duplicates" while reading nothing.
  const probe = spawnSync('git', ['rev-parse', '--verify', `${base}^{commit}`], {
    encoding: 'utf8',
  });
  if (probe.status !== 0) {
    process.stderr.write(
      `duplicate-patch-guard: ${base} is not present — the workflow must ` +
        'fetch the base branch before this step. Refusing to report a ' +
        'clean result from an unread trunk.\n',
    );
    return 1;
  }

  const result = await findDuplicatePatches({
    baseRange: base,
    prRange: `${base}..HEAD`,
    window: PATCH_ID_WINDOW,
  });
  const { findings } = result;

  // Pass the whole result: the report's denominator, its whitespace-drop
  // count and its shallow-clone verdict all come from the same read.
  const body = formatFindings(findings, { ...result, failing: enforce });
  if (summaryPath) appendFileSync(summaryPath, body);
  process.stdout.write(body);

  if (findings.length === 0) return 0;
  if (!enforce) {
    process.stdout.write(
      'duplicate-patch-guard: warn-only, not failing the build.\n',
    );
    return 0;
  }
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    // Fail open on an unexpected crash: the guard is advisory and must not
    // block an unrelated PR. The one case deliberately NOT swallowed is an
    // unreadable trunk, handled above — that would masquerade as a clean
    // result rather than an error, which is worse than a red check.
    // Record the crash in the summary as well — otherwise fail-open is
    // indistinguishable from a clean run in the checks list.
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      appendFileSync(
        summaryPath,
        `## Duplicate-patch guard\n\nErrored, failing open: ${err.message}\nNo comparison was performed.\n`,
      );
    }
    process.stderr.write(`duplicate-patch-guard: ${err.message}\n`);
    process.exit(0);
  });
/* c8 ignore stop */

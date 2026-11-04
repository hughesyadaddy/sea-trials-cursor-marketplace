/**
 * CI entry for the promotion migration gate (dev -> stg -> main).
 *
 * Reads policy JSON from the app repo (default:
 * scripts/ci/promotion/forbidden-promotion-policy.json).
 */

import process from 'node:process';

import {
  checkPromotionDiff,
  loadPolicy,
  runSelfTest,
} from './forbid-promotion-migrations.mjs';

const DEFAULT_POLICY = 'scripts/ci/promotion/forbidden-promotion-policy.json';

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    return runSelfTest();
  }

  const policyPath = process.env.PROMOTION_POLICY_PATH ?? DEFAULT_POLICY;
  const base = process.env.PROMOTION_BASE_REF ?? argv[0];
  const head = process.env.PROMOTION_HEAD_REF ?? argv[1] ?? 'HEAD';

  if (!base) {
    process.stderr.write(
      'usage: run-forbid-promotion-migrations.mjs <base-ref> [head-ref]\n' +
        '       run-forbid-promotion-migrations.mjs --self-test\n',
    );
    return 2;
  }

  const policy = loadPolicy(policyPath);
  const result = checkPromotionDiff(base, head, policy);
  if (result.ok) {
    process.stdout.write(`OK: no forbidden files changed in ${base}...${head}\n`);
    return 0;
  }

  process.stderr.write(
    'Forbidden work-stream files would be promoted:\n',
  );
  for (const [f, why] of result.hits) {
    process.stderr.write(`::error file=${f}::${why}\n`);
  }
  process.stderr.write(
    'These belong to explanations/hints/xmedia/question-tagging/' +
      'rich-content/RAG work and must not reach stg/main.\n',
  );
  return 1;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });

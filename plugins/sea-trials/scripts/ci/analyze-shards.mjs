/**
 * dart-analyze shard aggregator for PR Checks.
 *
 * The planner lives in run-lane.mjs; execution is sharded via
 * guardrails-analyze-packages.mjs. This module only aggregates job
 * results so the required check name stays `dart-analyze`.
 */

import { pathToFileURL } from 'node:url';

import {
  aggregateDartTestResult,
  parseAggregateArgs,
} from './test-shards.mjs';

export { aggregateDartTestResult as aggregateDartAnalyzeResult };

/* c8 ignore start */
function main(argv) {
  if (!argv.includes('--aggregate')) {
    throw new Error('usage: analyze-shards.mjs --aggregate --plan … --shards … --has-work …');
  }
  const parsed = parseAggregateArgs(argv);
  const result = aggregateDartTestResult(parsed);
  process.stdout.write(`${result.reason}\n`);
  process.exitCode = result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`analyze-shards: ${err.message}\n`);
    process.exitCode = 2;
  }
}
/* c8 ignore stop */

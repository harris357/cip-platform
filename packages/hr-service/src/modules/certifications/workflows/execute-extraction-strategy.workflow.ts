// Slice 58C — generic extraction-strategy executor workflow.
//
// Hosted on hr-service's `cip-hr-tasks` queue (registered via workflows
// index). The doc-service `runExtractionStrategyActivity` starts THIS
// workflow on whichever queue the strategy registry row names; this
// workflow then proxies the named activity locally on that queue. Result
// is returned via `handle.result()` to the doc-service-side activity.
//
// Why a workflow at all (not a direct activity dispatch)? Cross-queue
// activity execution from a workflow context requires proxyActivities
// at workflow-module load time, but the doc-service workflow doesn't
// know which queues exist at compile time. By starting THIS workflow
// on the strategy's queue, we delegate the queue-binding to where it
// belongs — the strategy's own service.
//
// The executor is intentionally tiny: one proxyActivities call with a
// generous timeout. Each module's worker registers this same workflow
// (or imports it from a shared path) so the doc-service dispatch is
// uniform.

import { proxyActivities } from '@temporalio/workflow';

// TYPE-ONLY import from @cip/shared. Workflow bundles run in Temporal's
// sandboxed isolate — webpack must NOT pull `@cip/shared`'s value
// exports because they transitively reach `node:tls` (via @temporalio
// /client, pg, etc.) and the bundler can't process the `node:` scheme.
// Type-only imports are erased at compile time so webpack never sees them.
//
// Zod runtime validation moved to the activity layer
// (`extractCertFeaturesActivity` already calls `ExtractionInputSchema.parse`
// + `ExtractionOutputSchema.parse`). Defense-in-depth at the workflow
// layer would be nice but webpack vs node:tls makes it not worth it.
import type { ExtractionInput, ExtractionOutput } from '@cip/shared';

// We type the proxy as a generic Record<string, fn> because the activity
// to call is named at runtime via input.activityName. Each registered
// activity in the worker matches the (input)→Promise<output> shape.
const activities = proxyActivities<Record<string, (input: ExtractionInput) => Promise<ExtractionOutput>>>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
  },
});

export interface ExecuteExtractionStrategyInput {
  activityName: string;        // e.g. 'extractCertFeaturesActivity'
  input:        ExtractionInput;
}

export async function ExecuteExtractionStrategyWorkflow(
  args: ExecuteExtractionStrategyInput,
): Promise<ExtractionOutput> {
  const fn = activities[args.activityName];
  if (typeof fn !== 'function') {
    throw new Error(`ExecuteExtractionStrategyWorkflow: unknown activity '${args.activityName}'`);
  }
  // Activity validates input + output against the Zod schemas; no extra
  // parse here (the schemas would force a value-import of @cip/shared
  // which breaks the workflow webpack bundle).
  return fn(args.input);
}

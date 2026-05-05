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

import {
  ExtractionInputSchema,
  ExtractionOutputSchema,
  type ExtractionInput,
  type ExtractionOutput,
} from '@cip/shared';

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
  // Validate at the workflow boundary too — if the doc-service-side
  // payload was tampered with mid-flight (it shouldn't be, but defense
  // in depth), we throw before touching the LLM.
  const validated = ExtractionInputSchema.parse(args.input);

  const fn = activities[args.activityName];
  if (typeof fn !== 'function') {
    throw new Error(`ExecuteExtractionStrategyWorkflow: unknown activity '${args.activityName}'`);
  }

  const out = await fn(validated);
  return ExtractionOutputSchema.parse(out);
}

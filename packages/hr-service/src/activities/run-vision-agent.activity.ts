import { runVisionAgent as executeVisionAgent } from '../agents/vision-agent/index.js';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';

export interface RunVisionAgentInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
}

/**
 * Temporal Activity wrapper around the Vision Agent LangGraph graph.
 * Temporal handles retries and timeouts. The agent itself handles reasoning.
 */
export async function runVisionAgent(input: RunVisionAgentInput): Promise<ExtractionResult> {
  const { activityInfo } = await import('@temporalio/activity');
  const info = activityInfo();

  const result = await executeVisionAgent({
    ...input,
    activityId: info.activityId,
  });

  // Every Activity output is Zod-validated before return
  return ExtractionResultSchema.parse(result);
}

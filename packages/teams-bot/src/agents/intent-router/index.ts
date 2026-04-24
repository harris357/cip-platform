import { createLiteLLMClient } from '@cip/shared/src/clients/litellm.js';
import { IntentResultSchema, type IntentResult } from '@cip/shared/src/types/agent.js';

/**
 * Tier 2 intent router — single structured LLM call, not a multi-step graph.
 * Uses cip-lightweight alias for low latency.
 * tenantId is passed for Langfuse trace attribution — never used to look up data.
 */
export async function routeIntent(message: string, tenantId: string): Promise<IntentResult> {
  const model = createLiteLLMClient({ tenantId, virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '' });

  void tenantId; // TODO: tag Langfuse trace with tenantId
  void model;    // TODO: invoke with structured output via withStructuredOutput(IntentResultSchema)

  throw new Error('routeIntent: not implemented');
}

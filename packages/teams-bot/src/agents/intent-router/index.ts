import { createLiteLLMClient } from '@cip/shared/src/clients/litellm.js';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';
import { IntentResultSchema, type IntentResult } from './schema.js';

const INTENT_ROUTER_PROMPT = `You are an intent classifier for a workforce compliance management platform.
Classify the user message into exactly one of these intents:
- UPLOAD_CERT: User wants to upload or submit a certification/compliance document
- QUERY_COMPLIANCE: User wants to check compliance status for a worker or site
- RESPOND_HITL: User is approving or rejecting a pending compliance review request
- UNKNOWN: None of the above

Respond with valid JSON only (no markdown):
{
  "intent": "UPLOAD_CERT" | "QUERY_COMPLIANCE" | "RESPOND_HITL" | "UNKNOWN",
  "confidence": <0.0 to 1.0>,
  "entities": {
    // RESPOND_HITL: include "workflowId" and "decision" ("approve" or "reject")
    // QUERY_COMPLIANCE: include "workerId" or "siteId" if mentioned
  }
}`;

export async function routeIntent(
  message: string,
  ctx: TenantContext,
): Promise<IntentResult> {
  const client = createLiteLLMClient({
    tenantId: ctx.tenantId,
    virtualKey: ctx.tenantConfig.litellmVirtualKey,
  });

  const response = await client.chat.completions.create({
    model: 'cip-chat',
    messages: [
      { role: 'system', content: INTENT_ROUTER_PROMPT },
      { role: 'user', content: message },
    ],
    max_tokens: 200,
    response_format: { type: 'json_object' },
  });

  const raw = JSON.parse(response.choices[0]?.message.content ?? '{}') as unknown;
  // tenantId MUST come from TenantContext — never from the LLM response
  return IntentResultSchema.parse({ ...(raw as object), tenantId: ctx.tenantId });
}

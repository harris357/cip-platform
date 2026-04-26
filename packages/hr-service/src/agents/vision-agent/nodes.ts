import { createPool, withTenantRLS } from '@cip/shared/src/clients/postgres.js';
import { createLiteLLMClient } from '@cip/shared/src/clients/litellm.js';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { VisionAgentAnnotation } from './state.js';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from './prompts.js';

type AgentState = typeof VisionAgentAnnotation.State;

const pool = createPool(process.env['DATABASE_URL'] ?? '');

async function getTenantVirtualKey(tenantId: string): Promise<string> {
  const client = await pool.connect();
  try {
    return await withTenantRLS(client, tenantId, async (c) => {
      const res = await c.query<{ litellm_virtual_key: string }>(
        'SELECT litellm_virtual_key FROM tenant_settings WHERE tenant_id = $1',
        [tenantId],
      );
      if (!res.rows[0]) throw new Error(`No tenant_settings for tenant ${tenantId}`);
      return res.rows[0].litellm_virtual_key;
    });
  } finally {
    client.release();
  }
}

function parseExtractionResponse(
  content: string,
  model: string,
  totalTokens: number,
  tenantId: string,
): ExtractionResult {
  const json = JSON.parse(content) as Record<string, unknown>;
  return ExtractionResultSchema.parse({
    tenantId,
    certType: json['certType'],
    extractedFields: json['extractedFields'],
    overallConfidence: json['overallConfidence'] ?? 0,
    requiresHITL: false,
    promptVersion: PROMPT_VERSION,
    modelUsed: model,
    tokensUsed: totalTokens,
    costUsd: 0,
  });
}

export async function extractFields(
  state: AgentState,
): Promise<Partial<AgentState>> {
  const virtualKey = await getTenantVirtualKey(state.tenantId);
  const client = createLiteLLMClient({
    tenantId: state.tenantId,
    virtualKey,
  });

  const response = await client.chat.completions.create({
    model: 'cip-vision',
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url' as const,
            image_url: { url: `data:image/jpeg;base64,${state.documentBase64 ?? ''}` },
          },
          {
            type: 'text' as const,
            text: 'Extract all certification fields from this document. Respond with JSON only.',
          },
        ],
      },
    ],
    max_tokens: 1000,
  });

  const content = response.choices[0]?.message?.content ?? '';
  return {
    extraction: parseExtractionResponse(content, response.model, response.usage?.total_tokens ?? 0, state.tenantId),
  };
}

export async function assessConfidence(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (!state.extraction) throw new Error('assessConfidence: extraction is missing');
  return { requiresHitl: state.extraction.overallConfidence < 0.85 };
}

export async function formatOutput(
  _state: AgentState,
): Promise<Partial<AgentState>> {
  return {};
}

export async function flagForHitl(
  state: AgentState,
): Promise<Partial<AgentState>> {
  if (!state.extraction) throw new Error('flagForHitl: extraction is missing');
  return {
    extraction: { ...state.extraction, requiresHITL: true },
  };
}

import { createLiteLLMClient } from '@cip/shared/src/clients/litellm.js';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { VisionAgentAnnotation } from './state.js';
import { EXTRACTION_PROMPT, PROMPT_VERSION } from './prompts.js';

type AgentState = typeof VisionAgentAnnotation.State;

function parseExtractionResponse(
  content: string,
  model: string,
  totalTokens: number,
): ExtractionResult {
  const json = JSON.parse(content) as Record<string, unknown>;
  return ExtractionResultSchema.parse({
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
  const client = createLiteLLMClient({
    tenantId: state.tenantId,
    virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '',
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
    extraction: parseExtractionResponse(content, response.model, response.usage?.total_tokens ?? 0),
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

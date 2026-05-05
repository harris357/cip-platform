import { callLLM, createLiteLLMClient, ExtractionResultSchema, getPrompt, resolveAlias } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';
import { VisionAgentAnnotation } from './state.js';

const REQUIRED_FIELDS = ['holderName', 'certName', 'issuingBody', 'issueDate', 'expiryDate', 'certNumber'] as const;
// Slice 41: prompt version comes from Langfuse (PromptHandle.version) — kept
// here as a static fallback for the parseExtractionResponse return shape.
const PROMPT_VERSION = 'v1.0.0';

interface CompletionResponse {
  model: string;
  choices: Array<{ message: { content: string | null } }>;
  usage?: { total_tokens: number };
}

function parseExtractionResponse(
  response: CompletionResponse,
  tenantId: string,
  submissionId: string,
  certType: string,
): Record<string, unknown> {
  void submissionId;
  const content = response.choices[0]?.message?.content ?? '';
  let extractedFields: Record<string, unknown> = {};

  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      extractedFields = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    } catch {
      // proceed with empty fields; assessConfidence will flag for HITL
    }
  }

  const presentCount = REQUIRED_FIELDS.filter(f => Boolean(extractedFields[f])).length;
  const overallConfidence = presentCount / REQUIRED_FIELDS.length;

  return {
    tenantId,
    certType,
    extractedFields,
    overallConfidence,
    requiresHITL: false,
    promptVersion: PROMPT_VERSION,
    modelUsed: response.model,
    tokensUsed: response.usage?.total_tokens ?? 0,
    costUsd: 0,
  };
}

export async function extractFields(state: typeof VisionAgentAnnotation.State) {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY'];
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required');
  if (!state.documentBase64) throw new Error('documentBase64 is required');

  const client = createLiteLLMClient({ tenantId: state.tenantId, virtualKey });
  const alias = await resolveAlias({
    service:  'hr-service',
    purpose:  'vision_extract',
    tenantId: state.tenantId,
  });
  const prompt = await getPrompt({
    name:     'hr-service.vision_extract',
    tenantId: state.tenantId,
  });

  const response = await callLLM(client, {
    model: alias,
    purpose:      'hr-service.vision_extract',
    promptHandle: prompt,
    tenantId:     state.tenantId,
    messages: [
      { role: 'system', content: prompt.compile() },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${state.documentBase64}` } },
          { type: 'text', text: 'Extract all certification fields.' },
        ],
      },
    ],
    max_tokens: 1000,
  });

  const raw = parseExtractionResponse(response, state.tenantId, state.submissionId, state.certType);
  const extraction = ExtractionResultSchema.parse(raw);
  return { extraction };
}

export function assessConfidence(state: typeof VisionAgentAnnotation.State) {
  const confidence = state.extraction?.overallConfidence ?? 0;
  return { requiresHitl: confidence < 0.85 };
}

export function formatOutput(_state: typeof VisionAgentAnnotation.State) {
  return {};
}

export function flagForHitl(state: typeof VisionAgentAnnotation.State): { extraction: ExtractionResult } | Record<string, never> {
  if (!state.extraction) return {};
  return {
    extraction: { ...state.extraction, requiresHITL: true },
  };
}

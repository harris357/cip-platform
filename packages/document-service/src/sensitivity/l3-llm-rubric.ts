// Slice 58B — L3 LLM sensitivity rubric.
//
// Pulls the prompt 'bot.documents.sensitivity_rubric' from Langfuse,
// renders it with the supplied evidence, and asks a small Mistral model
// for { tier, reasoning } JSON. Disabled (skipped entirely) when the
// tunable documents.l3_enabled is false.
//
// Falls back gracefully — any LLM/prompt error is logged and we return
// tier='public' with reasoning='l3_skipped:<reason>'. The composer in
// score-sensitivity.activity.ts will still apply the floor and L1+L2,
// so a transient LLM outage downgrades to L1+L2 instead of failing the
// whole workflow.

import { z } from 'zod'
import {
  callLLM,
  createLiteLLMClient,
  getPrompt,
  type SensitivityTier,
} from '@cip/shared'

// Truncate to bound the prompt cost. mistral-embed accepts ~30k chars
// which we use for embedding; the rubric model only needs enough text
// to make a tier decision.
const MAX_OCR_CHARS = 6000

// Primary prompt name in Langfuse. The slice doc requires this prompt
// be hosted with name 'bot.documents.sensitivity_rubric' label
// 'production'. The infra team hosts Langfuse prompts via the dashboard;
// see slices/SLICE_58B_INGEST_SCAN_FEATURES.md "Pre-flight" for the
// canonical prompt text — that text is duplicated below as the runtime
// fallback (fallbackText) so a missing Langfuse prompt does NOT take
// the workflow down.
//
// TODO(slice 58B deploy step): host this prompt in Langfuse manually
// before the first end-to-end test against a real tenant.
export const L3_PROMPT_NAME = 'bot.documents.sensitivity_rubric'

const FALLBACK_PROMPT = `You are a document-sensitivity classifier for an enterprise HR platform.
Read the inputs and output ONE JSON object with exactly two keys:
  tier:       one of "public" | "internal" | "confidential" | "restricted"
  reasoning:  one short sentence explaining the choice

Tiers (least to most sensitive):
- public:        marketing, public policies, non-PII forms
- internal:      employee directory entries, internal memos, generic HR forms
- confidential:  individual compensation, benefits, performance, contracts, NDAs
- restricted:    SSN, government IDs, medical/health records, banking, legal holds

Inputs:
  fileName:    {{fileName}}
  mimeType:    {{mimeType}}
  hintText:    {{hintText}}
  l1Hits:      {{l1Hits}}
  l2Matches:   {{l2Matches}}
  ocrText:
"""
{{ocrText}}
"""

Return ONLY the JSON object, no preamble, no code fence.`

const RubricResponseSchema = z.object({
  tier:      z.enum(['public', 'internal', 'confidential', 'restricted']),
  reasoning: z.string().max(500),
})

export interface L3Input {
  tenantId:   string
  ocrText:    string
  fileName:   string
  mimeType:   string
  hintText:   string | undefined
  l1Hits:     unknown
  l2Matches:  unknown
  /** Optional override; default 'cip-classifier' (cheap structured output). */
  modelAlias?: string
}

export interface L3Output {
  tier:      SensitivityTier
  reasoning: string
  /** 'langfuse' | 'fallback' | 'skipped' — surfaces in evidence + traces. */
  promptSource: string
}

export async function l3Score(input: L3Input): Promise<L3Output> {
  const ocrTrimmed = (input.ocrText ?? '').slice(0, MAX_OCR_CHARS)
  const apiKey = process.env['LITELLM_VIRTUAL_KEY'] ?? process.env['LITELLM_MASTER_KEY']

  if (!apiKey) {
    return { tier: 'public', reasoning: 'l3_skipped:no_litellm_key', promptSource: 'skipped' }
  }

  // Pull prompt from Langfuse (5-min cache). Falls back internally if
  // Langfuse is down — but we ALSO have FALLBACK_PROMPT here so a missing
  // prompt never takes the workflow down. The shared getPrompt() looks
  // up by code-side fallback name; ours isn't registered there yet, so
  // we handle the fallback locally too.
  let promptText: string
  let promptSource = 'fallback'
  try {
    const handle = await getPrompt({ name: L3_PROMPT_NAME, tenantId: input.tenantId })
    promptText = handle.compile({
      fileName:  input.fileName,
      mimeType:  input.mimeType,
      hintText:  input.hintText ?? '',
      l1Hits:    JSON.stringify(input.l1Hits ?? []),
      l2Matches: JSON.stringify(input.l2Matches ?? []),
      ocrText:   ocrTrimmed,
    })
    promptSource = handle.source
  } catch (err) {
    console.warn(`[l3] getPrompt failed: ${err instanceof Error ? err.message : String(err)} — using FALLBACK_PROMPT`)
    promptText = FALLBACK_PROMPT
      .replace('{{fileName}}',  input.fileName)
      .replace('{{mimeType}}',  input.mimeType)
      .replace('{{hintText}}',  input.hintText ?? '')
      .replace('{{l1Hits}}',    JSON.stringify(input.l1Hits ?? []))
      .replace('{{l2Matches}}', JSON.stringify(input.l2Matches ?? []))
      .replace('{{ocrText}}',   ocrTrimmed)
    promptSource = 'fallback'
  }

  const client = createLiteLLMClient({
    tenantId:   input.tenantId,
    virtualKey: apiKey,
  })

  let resp
  try {
    resp = await callLLM(client, {
      model: input.modelAlias ?? 'cip-classifier',
      messages: [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' },
      max_tokens: 200,
      temperature: 0,
      purpose:  'document-service.l3_sensitivity',
      tenantId: input.tenantId,
    })
  } catch (err) {
    console.warn(`[l3] LLM call failed: ${err instanceof Error ? err.message : String(err)} — defaulting tier=public`)
    return { tier: 'public', reasoning: 'l3_skipped:llm_error', promptSource }
  }

  const content = resp.choices[0]?.message?.content ?? ''
  let parsed: z.infer<typeof RubricResponseSchema>
  try {
    parsed = RubricResponseSchema.parse(JSON.parse(content))
  } catch (err) {
    console.warn(`[l3] response parse failed: ${err instanceof Error ? err.message : String(err)} — defaulting tier=public`)
    return { tier: 'public', reasoning: 'l3_skipped:parse_error', promptSource }
  }
  return { tier: parsed.tier, reasoning: parsed.reasoning, promptSource }
}

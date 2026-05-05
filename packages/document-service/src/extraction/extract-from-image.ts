// Slice 58C-FIX — image OCR via cip-vision.
//
// Single-page images go straight to LiteLLM's cip-vision alias for
// transcription. We don't run a langchain/langgraph pipeline here —
// langgraph drags in node:tls which the workflow bundle can't reach.
// Plain OpenAI client + chat.completions is enough.
//
// The model alias is read from a tunable (lg.extract_image_ocr_model);
// the activity-layer caller passes it in so this module stays pure
// (no DB dependency, no env reads).
//
// Lazy import 'openai' so the workflow bundle stays clean. The
// extract-generic-features activity is the only direct caller.

import type { ExtractionResult } from './extract-from-text.js'

export interface ImageExtractionInput {
  buffer:      Buffer
  mimeType:    string                    // 'image/png' | 'image/jpeg' | ...
  tenantId:    string                    // for x-tenant-id header
  modelAlias:  string                    // 'cip-vision' (tunable)
  virtualKey:  string                    // LITELLM_VIRTUAL_KEY
  baseURL?:    string                    // LITELLM_BASE_URL override
}

const OCR_PROMPT = [
  'You are an OCR engine. Transcribe ALL visible text from this image, ',
  'preserving line breaks where they appear in the source. Do not summarise, ',
  'translate, or interpret. If the image contains no readable text, output an empty response.',
].join('')

export async function extractFromImage(input: ImageExtractionInput): Promise<ExtractionResult> {
  const { default: OpenAI } = await import('openai')

  const client = new OpenAI({
    apiKey:  input.virtualKey,
    baseURL: input.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: { 'x-tenant-id': input.tenantId },
  })

  const dataUrl = `data:${input.mimeType};base64,${input.buffer.toString('base64')}`

  // chat.completions with vision content. Mistral-vision via LiteLLM
  // accepts the OpenAI-shaped multimodal content.
  const resp = await client.chat.completions.create({
    model: input.modelAlias,
    messages: [
      { role: 'system', content: OCR_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text',      text:      'Transcribe this image.' },
        ],
      },
    ],
    max_tokens: 2000,
  })

  const ocrText = resp.choices[0]?.message?.content ?? ''
  const tokensUsed = resp.usage?.total_tokens ?? 0

  return {
    ocrText: typeof ocrText === 'string' ? ocrText : '',
    evidence: {
      source:     'cip-vision',
      modelAlias: input.modelAlias,
      tokensUsed,
      bytes:      input.buffer.length,
      mimeType:   input.mimeType,
    },
  }
}

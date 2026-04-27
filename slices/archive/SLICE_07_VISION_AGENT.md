# Slice 07 — Vision Agent (LangGraph)

> **Prerequisite:** Slices 02, 05B, 06 complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/modules/certifications/agents/vision-agent/
  index.ts      ← exports runVisionAgent()
  state.ts      ← VisionAgentAnnotation (LangGraph channel definition)
  nodes.ts      ← extractFields, assessConfidence, formatOutput, flagForHitl
  prompts.ts    ← EXTRACTION_PROMPT constant
```

---

## Graph Shape

```
START → extractFields → assessConfidence
                              ├── confidence >= 0.85 → formatOutput → END
                              └── confidence < 0.85  → flagForHitl  → END
```

---

## State Definition

```typescript
// state.ts
import { Annotation } from '@langchain/langgraph'
import type { ExtractionResult } from '@cip/shared'

export const VisionAgentAnnotation = Annotation.Root({
  tenantId:       Annotation<string>(),
  submissionId:   Annotation<string>(),
  employeeId:     Annotation<string>(),
  objectStoreKey: Annotation<string>(),
  documentBase64: Annotation<string | undefined>(),
  extraction:     Annotation<ExtractionResult | undefined>(),
  requiresHitl:   Annotation<boolean>({ default: () => false }),
  userId:         Annotation<string>(),
  workflowId:     Annotation<string | undefined>(),
  model:          Annotation<string | undefined>(),
})
```

---

## `extractFields` Node — LiteLLM Pattern

```typescript
// nodes.ts
import { createLiteLLMClient } from '@cip/shared'
import { ExtractionResultSchema } from '@cip/shared'

export async function extractFields(state: typeof VisionAgentAnnotation.State) {
  const virtualKey = process.env['LITELLM_VIRTUAL_KEY']
  if (!virtualKey) throw new Error('LITELLM_VIRTUAL_KEY env var is required')
  const client = createLiteLLMClient({
    tenantId:   state.tenantId,
    virtualKey,
  })

  const response = await client.chat.completions.create({
    model: 'cip-vision',   // LiteLLM alias — never a raw model string
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${state.documentBase64}` } },
          { type: 'text', text: 'Extract all certification fields.' },
        ],
      },
    ],
    max_tokens: 1000,
  })

  const raw = parseExtractionResponse(response, state.tenantId, state.submissionId)
  const extraction = ExtractionResultSchema.parse(raw)
  return { extraction }
}
```

---

## `prompts.ts`

```typescript
// TODO: Load from Langfuse prompt management in production
export const EXTRACTION_PROMPT = `
You are a construction certification document parser.
Extract the following fields from the provided document image.
Return JSON with keys: holderName, holderEmail, certName, issuingBody,
issueDate (YYYY-MM-DD), expiryDate (YYYY-MM-DD), certNumber.
If a field is not present, omit it. Do not guess.
`
```

---

## Required Environment Variables

| Variable | Purpose |
|---|---|
| `LITELLM_VIRTUAL_KEY` | Virtual key for LiteLLM proxy — required, no fallback |
| `LITELLM_BASE_URL` | LiteLLM proxy base URL |

> Note: `LITELLM_VIRTUAL_KEY` is a service-level key used by all tenants in this deployment.
> Per-tenant key isolation is tracked in `CROSS_SLICE_NOTES.md` as a future improvement
> (requires adding `litellm_virtual_key` to `tenant_settings`).

---

## Acceptance Criteria

- [ ] `runVisionAgent()` is the single export from `index.ts`
- [ ] State has `tenantId: string` and `submissionId: string` (not optional)
- [ ] LiteLLM model name is the alias `cip-vision` — not a raw Anthropic model string
- [ ] `ExtractionResultSchema.parse()` is called on the LLM response before returning
- [ ] Graph has exactly 4 nodes: extractFields, assessConfidence, formatOutput, flagForHitl
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

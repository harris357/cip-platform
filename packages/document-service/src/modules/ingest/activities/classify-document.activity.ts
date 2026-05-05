// Slice 58C — document classifier activity.
//
// Decides (module, doc_type) for a doc whose generic features +
// sensitivity tier are already populated. Inputs:
//   - Langfuse-hosted prompt 'bot.documents.classify' (FALLBACK_PROMPT
//     baked in below for resilience),
//   - the per-tenant catalog of enabled (module, doc_type) rows from
//     cip_documents.extraction_strategies,
//   - generic features + sensitivity + uploader hint.
//
// Output is Zod-validated, persisted on the documents row, and audited.
// The workflow consumes the confidence to decide whether to proceed to
// extract or shunt to hitl_admin_queue.

import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import {
  callLLM,
  createLiteLLMClient,
  getPrompt,
  type SensitivityTier,
} from '@cip/shared'

import { getDb, getPool } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'

// Bound the classifier prompt cost. Mistral small handles ~30k chars
// but we don't need that much OCR text to make a (module, doc_type)
// decision.
const MAX_OCR_CHARS = 6000
const GLOBAL_SENTINEL = '00000000-0000-0000-0000-000000000000'

export const CLASSIFY_PROMPT_NAME = 'bot.documents.classify'

const FALLBACK_PROMPT = `You are a document classifier for an enterprise HR platform.
Choose the (module, doc_type) that best matches the inputs and output ONE JSON object with exactly these keys:
  module:       short module name from the catalog below (e.g. "certificate")
  doc_type:     specific type within that module (e.g. "cpr"), or "*" if not yet specialized
  confidence:   number in [0,1] — your confidence that the (module, doc_type) is correct
  alternatives: array of up to 2 runner-ups, each shaped {"module":"...","doc_type":"...","confidence":0.NN}
  reasoning:    one short sentence explaining the choice (visible in audit logs)

Available (module, doc_type) catalog for this tenant (each row may include hints):
{{catalog}}

Rules:
- If none of the catalog rows fits, set module="unknown" and doc_type="unknown" with low confidence.
- If a catalog row has doc_type="*", treat it as a wildcard accept for that module — pick the module and use a specific doc_type when you can infer it from the content; otherwise return doc_type="*".
- Confidence below 0.6 is fine — the platform has a HITL review path.

Inputs:
  fileName:        {{fileName}}
  mimeType:        {{mimeType}}
  hintText:        {{hintText}}
  sensitivityTier: {{sensitivityTier}}
  genericFeatures: {{genericFeatures}}
  ocrText:
"""
{{ocrText}}
"""

Return ONLY the JSON object, no preamble, no code fence.`

// Tolerate both snake_case and camelCase from the model — LLMs frequently
// drift to whichever convention is dominant in the prompt/output. We
// normalize to camelCase before persisting.
const AlternativeSchema = z.preprocess(
  (raw) => {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const r = raw as Record<string, unknown>
      if (r['doc_type'] !== undefined && r['docType'] === undefined) {
        return { ...r, docType: r['doc_type'] }
      }
    }
    return raw
  },
  z.object({
    module:     z.string(),
    docType:    z.string(),
    confidence: z.number().min(0).max(1),
  }),
)

const ClassifyResponseSchema = z.object({
  module:     z.string().min(1).max(64),
  doc_type:   z.string().min(1).max(64),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(AlternativeSchema).max(5).optional().default([]),
  reasoning:  z.string().max(500).optional().default(''),
})

export interface ClassifyDocumentInput {
  tenantId:          string
  documentId:        string
  ocrText:           string
  fileName:          string
  mimeType:          string
  uploaderHintText?: string
  sensitivityTier:   SensitivityTier
  genericFeatures:   Record<string, unknown>
  /** Optional override; defaults to 'cip-classifier' (cheap structured output). */
  modelAlias?:       string
}

export const ClassifyDocumentOutputSchema = z.object({
  module:     z.string(),
  docType:    z.string(),
  confidence: z.number().min(0).max(1),
  alternatives: z.array(z.object({
    module:     z.string(),
    docType:    z.string(),
    confidence: z.number().min(0).max(1),
  })),
  evidence:   z.record(z.unknown()),
})
export type ClassifyDocumentOutput = z.infer<typeof ClassifyDocumentOutputSchema>

interface CatalogRow {
  module:    string
  doc_type:  string
  notes:     string | null
}

/** Pull the union of enabled (module, doc_type) rows for the tenant + zero-UUID. */
async function loadCatalog(tenantId: string): Promise<CatalogRow[]> {
  const pool = getPool()
  const result = await pool.query<CatalogRow>(
    `SELECT DISTINCT module, doc_type, notes
       FROM cip_documents.extraction_strategies
      WHERE enabled = true
        AND (tenant_id = $1 OR tenant_id = $2::uuid)
      ORDER BY module, doc_type`,
    [tenantId, GLOBAL_SENTINEL],
  )
  return result.rows
}

function renderCatalog(rows: CatalogRow[]): string {
  if (rows.length === 0) {
    return '(empty — only "unknown"/"unknown" is acceptable)'
  }
  return rows
    .map(r => `- module=${r.module} doc_type=${r.doc_type}${r.notes ? ` (${r.notes})` : ''}`)
    .join('\n')
}

export async function classifyDocumentActivity(
  input: ClassifyDocumentInput,
): Promise<ClassifyDocumentOutput> {
  const ocrTrimmed = (input.ocrText ?? '').slice(0, MAX_OCR_CHARS)
  const apiKey = process.env['LITELLM_VIRTUAL_KEY'] ?? process.env['LITELLM_MASTER_KEY']

  if (!apiKey) {
    // No LLM — degrade to "unknown/unknown" at zero confidence so the
    // workflow falls into the HITL queue. Surfaces as an explicit reason.
    const evidence = { promptSource: 'skipped', reasoning: 'classify_skipped:no_litellm_key' }
    await persistClassification(input, 'unknown', 'unknown', 0, [], evidence)
    return ClassifyDocumentOutputSchema.parse({
      module: 'unknown', docType: 'unknown', confidence: 0, alternatives: [], evidence,
    })
  }

  const catalogRows = await loadCatalog(input.tenantId)
  const catalogText = renderCatalog(catalogRows)
  const genericFeaturesJson = JSON.stringify(input.genericFeatures)

  let promptText: string
  let promptSource: string
  let promptVersion: string | number | undefined
  try {
    const handle = await getPrompt({ name: CLASSIFY_PROMPT_NAME, tenantId: input.tenantId })
    promptText = handle.compile({
      catalog:         catalogText,
      fileName:        input.fileName,
      mimeType:        input.mimeType,
      hintText:        input.uploaderHintText ?? '',
      sensitivityTier: input.sensitivityTier,
      genericFeatures: genericFeaturesJson,
      ocrText:         ocrTrimmed,
    })
    promptSource  = handle.source
    promptVersion = handle.version ?? undefined
  } catch (err) {
    console.warn(`[classify] getPrompt failed: ${err instanceof Error ? err.message : String(err)} — using FALLBACK_PROMPT`)
    promptText = FALLBACK_PROMPT
      .replace('{{catalog}}',         catalogText)
      .replace('{{fileName}}',        input.fileName)
      .replace('{{mimeType}}',        input.mimeType)
      .replace('{{hintText}}',        input.uploaderHintText ?? '')
      .replace('{{sensitivityTier}}', input.sensitivityTier)
      .replace('{{genericFeatures}}', genericFeaturesJson)
      .replace('{{ocrText}}',         ocrTrimmed)
    promptSource = 'fallback'
  }

  const client = createLiteLLMClient({
    tenantId:   input.tenantId,
    virtualKey: apiKey,
  })

  let resp
  try {
    resp = await callLLM(client, {
      model:           input.modelAlias ?? 'cip-classifier',
      messages:        [{ role: 'user', content: promptText }],
      response_format: { type: 'json_object' },
      max_tokens:      400,
      temperature:     0,
      purpose:         'document-service.classify',
      tenantId:        input.tenantId,
    })
  } catch (err) {
    console.warn(`[classify] LLM call failed: ${err instanceof Error ? err.message : String(err)} — defaulting to unknown`)
    const evidence = { promptSource, promptVersion, reasoning: 'classify_skipped:llm_error' }
    await persistClassification(input, 'unknown', 'unknown', 0, [], evidence)
    return ClassifyDocumentOutputSchema.parse({
      module: 'unknown', docType: 'unknown', confidence: 0, alternatives: [], evidence,
    })
  }

  const content = resp.choices[0]?.message?.content ?? ''
  let parsed: z.infer<typeof ClassifyResponseSchema>
  try {
    parsed = ClassifyResponseSchema.parse(JSON.parse(content))
  } catch (err) {
    console.warn(`[classify] response parse failed: ${err instanceof Error ? err.message : String(err)} — defaulting to unknown`)
    const evidence = { promptSource, promptVersion, reasoning: 'classify_skipped:parse_error', raw: content.slice(0, 500) }
    await persistClassification(input, 'unknown', 'unknown', 0, [], evidence)
    return ClassifyDocumentOutputSchema.parse({
      module: 'unknown', docType: 'unknown', confidence: 0, alternatives: [], evidence,
    })
  }

  const evidence: Record<string, unknown> = {
    promptSource,
    promptVersion,
    reasoning:    parsed.reasoning,
    modelUsed:    resp.model,
    tokensUsed:   resp.usage?.total_tokens ?? 0,
  }

  await persistClassification(
    input,
    parsed.module,
    parsed.doc_type,
    parsed.confidence,
    parsed.alternatives,
    evidence,
  )

  return ClassifyDocumentOutputSchema.parse({
    module:       parsed.module,
    docType:      parsed.doc_type,
    confidence:   parsed.confidence,
    alternatives: parsed.alternatives,
    evidence,
  })
}

async function persistClassification(
  input:        ClassifyDocumentInput,
  module:       string,
  docType:      string,
  confidence:   number,
  alternatives: Array<{ module: string; docType: string; confidence: number }>,
  evidence:     Record<string, unknown>,
): Promise<void> {
  const db = getDb()
  await withActorContext(db, systemActorContext(input.tenantId), async (tx) => {
    await tx.update(documents).set({
      module,
      docType,
      classificationConfidence: confidence,
      classificationEvidence: { ...evidence, alternatives },
      classifiedAt: sql`NOW()`,
      updatedAt:    sql`NOW()`,
    }).where(eq(documents.id, input.documentId))

    await tx.insert(auditEvents).values({
      tenantId:   input.tenantId,
      documentId: input.documentId,
      actorRole:  'system',
      eventType:  'classified',
      payload: {
        module,
        docType,
        confidence,
        alternatives,
        evidence,
      },
    })
  })
}

// Slice 58B — embedding computation + pgvector persistence.
//
// Calls LiteLLM's /embeddings endpoint via the cip-embed gateway alias
// (resolves to mistral/mistral-embed in litellm-config.yaml). Stores
// the resulting 1024-dim vector on cip_documents.document_embeddings
// using a vector literal cast (matches the slice 44 pattern in
// admin-tool-retrieval.ts; no need for the pgvector npm helpers since
// drizzle doesn't have first-class vector support yet anyway).

import { sql } from 'drizzle-orm'
import { z } from 'zod'

import { callEmbed, createLiteLLMClient } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { auditEvents } from '../../../db/schema.js'

export interface ComputeEmbeddingInput {
  tenantId:   string
  documentId: string
  ocrText:    string
}

export const ComputeEmbeddingOutputSchema = z.object({
  documentId:     z.string().uuid(),
  dim:            z.number().int().positive(),
  embeddingModel: z.string(),
})
export type ComputeEmbeddingOutput = z.infer<typeof ComputeEmbeddingOutputSchema>

const EMBED_MODEL = 'cip-embed'      // gateway alias — see infra/k8s/litellm-config.yaml
const MAX_INPUT_CHARS = 30_000        // mistral-embed input cap headroom

export async function computeEmbeddingActivity(
  input: ComputeEmbeddingInput,
): Promise<ComputeEmbeddingOutput> {
  const { tenantId, documentId, ocrText } = input
  const db = getDb()

  const apiKey = process.env['LITELLM_VIRTUAL_KEY'] ?? process.env['LITELLM_MASTER_KEY']
  if (!apiKey) throw new Error('compute-embedding: missing LITELLM_VIRTUAL_KEY/LITELLM_MASTER_KEY')

  // Empty OCR text is fine for image-only docs at 58B — embed a single
  // space so we still produce a vector (placeholder; 58C may re-embed
  // after vision OCR fills the text). Saves a branch in querying.
  const text = (ocrText && ocrText.trim().length > 0)
    ? ocrText.slice(0, MAX_INPUT_CHARS)
    : ' '

  const client = createLiteLLMClient({ tenantId, virtualKey: apiKey })
  const [vec] = await callEmbed(client, {
    model:    EMBED_MODEL,
    input:    text,
    purpose:  'document-service.embed',
    tenantId,
  })
  if (!vec || vec.length === 0) {
    throw new Error('compute-embedding: empty vector from LiteLLM')
  }

  const vecLiteral = `[${vec.join(',')}]`

  // UPSERT — the workflow may retry an activity attempt; re-embedding the
  // same doc is allowed and reflects the current OCR text snapshot.
  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.execute(sql`
      INSERT INTO document_embeddings (document_id, tenant_id, embedding, embedding_model, computed_at)
      VALUES (${documentId}::uuid, ${tenantId}::uuid, ${vecLiteral}::vector, ${EMBED_MODEL}, NOW())
      ON CONFLICT (document_id) DO UPDATE
        SET embedding       = EXCLUDED.embedding,
            embedding_model = EXCLUDED.embedding_model,
            computed_at     = NOW()
    `)

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole:  'system',
      eventType:  'embedding_computed',
      payload: { dim: vec.length, embeddingModel: EMBED_MODEL, ocrTextLength: text.length },
    })
  })

  return ComputeEmbeddingOutputSchema.parse({
    documentId,
    dim:            vec.length,
    embeddingModel: EMBED_MODEL,
  })
}

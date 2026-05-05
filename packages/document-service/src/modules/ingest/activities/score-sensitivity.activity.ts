// Slice 58B — sensitivity scoring activity (L1 + L2 + L3 → max).
//
// Composes the three layered scorers under sensitivity/ and writes the
// final tier + evidence blob to documents.sensitivity_tier /
// sensitivity_evidence. Hard rule #4: NULL sensitivity is invalid post-
// scoring; the activity asserts a non-null tier before returning.

import { eq, sql } from 'drizzle-orm'
import { z } from 'zod'

import { SensitivityTierSchema, type SensitivityTier } from '@cip/shared'
import { getDb } from '../../../db/index.js'
import { systemActorContext, withActorContext } from '../../../db/rls.js'
import { documents, auditEvents } from '../../../db/schema.js'

import { l1Score } from '../../../sensitivity/l1-deterministic.js'
import { l2Score } from '../../../sensitivity/l2-regex.js'
import { l3Score } from '../../../sensitivity/l3-llm-rubric.js'
import { maxTier } from '../../../sensitivity/tier-compose.js'
import { loadDocumentsTunables } from '../../../sensitivity/tunables.js'

export interface ScoreSensitivityInput {
  tenantId:           string
  documentId:         string
  ocrText:            string
  fileName:           string
  mimeType:           string
  uploaderHintText?:  string | undefined
}

export const ScoreSensitivityOutputSchema = z.object({
  tier:     SensitivityTierSchema,
  evidence: z.object({
    l1: z.unknown(),
    l2: z.unknown(),
    l3: z.unknown(),
    floor: SensitivityTierSchema,
  }),
})
export type ScoreSensitivityOutput = z.infer<typeof ScoreSensitivityOutputSchema>

export async function scoreSensitivityActivity(
  input: ScoreSensitivityInput,
): Promise<ScoreSensitivityOutput> {
  const { tenantId, documentId, ocrText, fileName, mimeType, uploaderHintText } = input
  const db = getDb()

  const tunables = await loadDocumentsTunables(tenantId)

  // L1: synchronous, no I/O.
  const l1 = l1Score({
    fileName,
    mimeType,
    sizeBytes: 0,                 // not currently used by L1; placeholder
    ...(uploaderHintText !== undefined ? { hintText: uploaderHintText } : {}),
    l1Keywords: tunables.l1Keywords,
  })

  // L2: synchronous regex bank.
  const l2 = l2Score({ ocrText })

  // L3: LLM call — gated on tunable. On disable, returns 'public' with
  // promptSource='skipped' and reasoning='l3_skipped:tunable'.
  let l3: { tier: SensitivityTier; reasoning: string; promptSource: string }
  if (tunables.l3Enabled) {
    l3 = await l3Score({
      tenantId,
      ocrText,
      fileName,
      mimeType,
      hintText:  uploaderHintText ?? undefined,
      l1Hits:    l1.hits,
      l2Matches: l2.matches,
    })
  } else {
    l3 = { tier: 'public', reasoning: 'l3_skipped:tunable', promptSource: 'skipped' }
  }

  // Final tier = max(L1, L2, L3, tenant_floor).
  const finalTier: SensitivityTier = maxTier(l1.tier, l2.tier, l3.tier, tunables.tierOverrideFloor)

  if (!finalTier) {
    // Should never happen — maxTier always returns at least 'public'. Guard
    // explicitly per Hard Rule #4 ("NULL sensitivity is invalid").
    throw new Error('score-sensitivity: composer returned null tier — bug')
  }

  const evidence = {
    l1: { tier: l1.tier, hits: l1.hits },
    l2: { tier: l2.tier, matches: l2.matches },
    l3: { tier: l3.tier, reasoning: l3.reasoning, promptSource: l3.promptSource },
    floor: tunables.tierOverrideFloor,
  }

  await withActorContext(db, systemActorContext(tenantId), async (tx) => {
    await tx.update(documents).set({
      sensitivityTier:     finalTier,
      sensitivityEvidence: evidence,
      updatedAt:           sql`NOW()`,
    }).where(eq(documents.id, documentId))

    await tx.insert(auditEvents).values({
      tenantId,
      documentId,
      actorRole: 'system',
      eventType: 'sensitivity_assigned',
      payload:   { tier: finalTier, evidence },
    })
  })

  return ScoreSensitivityOutputSchema.parse({ tier: finalTier, evidence })
}

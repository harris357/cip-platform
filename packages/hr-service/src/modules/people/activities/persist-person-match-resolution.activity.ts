// Slice 58D-A — insert/update the person_match_resolutions table.
//
// Phases:
//   - 'init'   : insert the initial row at workflow entry; returns
//                the new resolutionId.
//   - 'update' : write canonicalization / shortlist / scored mid-flight,
//                or mark a HITL pickcard as offered.
//   - 'final'  : write the terminal outcome row (resolved / no_resolution).
//
// Idempotent on retry — drizzle UPDATEs are SET-by-id and the activity
// never throws on a no-op.

import { z } from 'zod';

import {
  MatchPersonInputSchema,
  PersonScoredCandidateSchema,
  PersonShortlistCandidateSchema,
  type MatchPersonOutcome,
  type MatchPersonSource,
} from '@cip/shared';

import {
  insertResolutionInit,
  updateResolutionFinal,
  updateResolutionHitlOffered,
  updateResolutionProcess,
} from '../db/queries/person-match-resolutions.js';
import { CanonicalizationSchema } from './canonicalize-person-hint.activity.js';

export const PersistPersonMatchResolutionInitSchema = z.object({
  phase:      z.literal('init'),
  workflowId: z.string(),
  input:      MatchPersonInputSchema,
});
export type PersistPersonMatchResolutionInit = z.infer<typeof PersistPersonMatchResolutionInitSchema>;

export const PersistPersonMatchResolutionProcessSchema = z.object({
  phase:        z.literal('process'),
  tenantId:     z.string().uuid(),
  resolutionId: z.string().uuid(),
  canonicalization: CanonicalizationSchema.optional(),
  shortlist:        z.array(PersonShortlistCandidateSchema).optional(),
  scoredCandidates: z.array(PersonScoredCandidateSchema).optional(),
});
export type PersistPersonMatchResolutionProcess = z.infer<typeof PersistPersonMatchResolutionProcessSchema>;

export const PersistPersonMatchResolutionHitlOfferedSchema = z.object({
  phase:        z.literal('hitl_offered'),
  tenantId:     z.string().uuid(),
  resolutionId: z.string().uuid(),
  audience:     z.enum(['uploader', 'admin']),
});
export type PersistPersonMatchResolutionHitlOffered = z.infer<typeof PersistPersonMatchResolutionHitlOfferedSchema>;

export const PersistPersonMatchResolutionFinalSchema = z.object({
  phase:        z.literal('final'),
  tenantId:     z.string().uuid(),
  resolutionId: z.string().uuid(),
  outcome:      z.enum(['resolved', 'no_resolution', 'cancelled']),
  resolvedEmployeeId:  z.string().uuid().optional(),
  resolutionSource:    z.enum(['auto_self', 'auto_unique', 'hitl_uploader', 'hitl_admin']).optional(),
  confidence:          z.number().min(0).max(1).optional(),
  hitlActorEmployeeId: z.string().uuid().optional(),
  hitlActorRole:       z.enum(['uploader', 'admin']).optional(),
  evidence:            z.record(z.unknown()),
});
export type PersistPersonMatchResolutionFinal = z.infer<typeof PersistPersonMatchResolutionFinalSchema>;

export const PersistPersonMatchResolutionInputSchema = z.discriminatedUnion('phase', [
  PersistPersonMatchResolutionInitSchema,
  PersistPersonMatchResolutionProcessSchema,
  PersistPersonMatchResolutionHitlOfferedSchema,
  PersistPersonMatchResolutionFinalSchema,
]);
export type PersistPersonMatchResolutionInput = z.infer<typeof PersistPersonMatchResolutionInputSchema>;

export const PersistPersonMatchResolutionOutputSchema = z.object({
  resolutionId: z.string().uuid(),
});
export type PersistPersonMatchResolutionOutput = z.infer<typeof PersistPersonMatchResolutionOutputSchema>;

export async function persistPersonMatchResolutionActivity(
  input: PersistPersonMatchResolutionInput,
): Promise<PersistPersonMatchResolutionOutput> {
  const validated = PersistPersonMatchResolutionInputSchema.parse(input);

  switch (validated.phase) {
    case 'init': {
      const { resolutionId } = await insertResolutionInit({
        tenantId:           validated.input.tenantId,
        workflowId:         validated.workflowId,
        callerSubmissionId: validated.input.context.callerSubmissionId,
        source:             validated.input.context.source,
        candidateText:      validated.input.candidateText,
        structuredHints:    validated.input.structuredHints ?? null,
        contextMeta:        validated.input.context as unknown as Record<string, unknown>,
        policy:             validated.input.policy as unknown as Record<string, unknown>,
      });
      return PersistPersonMatchResolutionOutputSchema.parse({ resolutionId });
    }
    case 'process': {
      await updateResolutionProcess({
        tenantId:         validated.tenantId,
        resolutionId:     validated.resolutionId,
        ...(validated.canonicalization !== undefined && { canonicalization: validated.canonicalization }),
        ...(validated.shortlist        !== undefined && { shortlist:        validated.shortlist }),
        ...(validated.scoredCandidates !== undefined && { scoredCandidates: validated.scoredCandidates }),
      });
      return PersistPersonMatchResolutionOutputSchema.parse({ resolutionId: validated.resolutionId });
    }
    case 'hitl_offered': {
      await updateResolutionHitlOffered({
        tenantId:     validated.tenantId,
        resolutionId: validated.resolutionId,
        audience:     validated.audience,
      });
      return PersistPersonMatchResolutionOutputSchema.parse({ resolutionId: validated.resolutionId });
    }
    case 'final': {
      // Cast to make eslint happy on the optional spread without
      // suppressions — discriminated-union narrows but the spread sets
      // are still typed by the parent schema.
      const args: Parameters<typeof updateResolutionFinal>[0] = {
        tenantId:     validated.tenantId,
        resolutionId: validated.resolutionId,
        outcome:      validated.outcome as Exclude<MatchPersonOutcome, 'resolved'> | 'resolved' | 'cancelled',
        evidence:     validated.evidence,
        ...(validated.resolvedEmployeeId  !== undefined && { resolvedEmployeeId:  validated.resolvedEmployeeId }),
        ...(validated.resolutionSource    !== undefined && { resolutionSource:    validated.resolutionSource as MatchPersonSource }),
        ...(validated.confidence          !== undefined && { confidence:          validated.confidence }),
        ...(validated.hitlActorEmployeeId !== undefined && { hitlActorEmployeeId: validated.hitlActorEmployeeId }),
        ...(validated.hitlActorRole       !== undefined && { hitlActorRole:       validated.hitlActorRole }),
      };
      await updateResolutionFinal(args);
      return PersistPersonMatchResolutionOutputSchema.parse({ resolutionId: validated.resolutionId });
    }
  }
}

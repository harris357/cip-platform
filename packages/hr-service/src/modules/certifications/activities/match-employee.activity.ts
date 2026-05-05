// Slice 58D-B — thin shim. The historical inline matching logic
// (exact-email → fuzzy-name with static nickname map → LLM tiebreaker)
// is replaced by the generic MatchPersonWorkflow on hr-service's
// `cip-hr-tasks` queue (see slice 58D-A).
//
// This file is preserved (rather than deleted) so that:
//   - Existing Temporal worker activity registration is unchanged.
//   - In-flight workflow histories that referenced `matchEmployee` can
//     replay deterministically: they will hit the shim, which starts
//     MatchPersonWorkflow as a *peer* workflow via the Temporal client
//     and awaits its result. Cert workflows started post-58D-B use
//     `startChild('MatchPersonWorkflow', ...)` directly inside the
//     workflow body (see certification-processing.workflow.ts) — this
//     activity is only invoked by non-workflow callers (MCP tools,
//     scripts) or replaying old histories.
//
// Slice 58E may remove this activity entirely as part of the Route-A
// cert rewrite.

import { z } from 'zod';
import { createTemporalClient } from '@cip/shared';
import type { ExtractionResult, MatchPersonInput, MatchPersonOutput } from '@cip/shared';

// ─── Adapter result shape (preserved for backwards compatibility) ───────────
//
// `method` is the legacy enum from the pre-58D-B activity. The new
// 'hitl' value covers both uploader-pickcard and admin-queue resolutions
// (the matcher distinguishes them via its `source` field, but cert
// callers historically only branched on confidence + method).
//
// 'no_match' covers MatchPersonOutput.outcome='no_resolution'.

export const EmployeeMatchResultSchema = z.object({
  matched:    z.boolean(),
  employeeId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1),
  method:     z.enum(['exact_email', 'fuzzy_name', 'llm_tiebreaker', 'hitl', 'no_match']),
});
export type EmployeeMatchResult = z.infer<typeof EmployeeMatchResultSchema>;

export interface MatchEmployeeInput {
  tenantId:     string;
  submissionId: string;
  extraction:   ExtractionResult;
}
export type MatchEmployeeOutput = EmployeeMatchResult;

/** Map MatchPersonOutput.source → legacy `method`. The closest analogs:
 *  - auto_self    → exact_email   (deterministic AAD match; treated as the
 *                                  strongest signal, same as exact email was)
 *  - auto_unique  → fuzzy_name    (single shortlist hit ≥ autoThreshold)
 *  - hitl_*       → hitl          (covers both uploader and admin tiers)
 *  - undefined (no_resolution) → no_match
 */
function adaptMethod(source: MatchPersonOutput['source']): EmployeeMatchResult['method'] {
  switch (source) {
    case 'auto_self':     return 'exact_email';
    case 'auto_unique':   return 'fuzzy_name';
    case 'hitl_uploader':
    case 'hitl_admin':    return 'hitl';
    default:              return 'no_match';
  }
}

export async function matchEmployee(
  input: MatchEmployeeInput,
): Promise<MatchEmployeeOutput> {
  const { tenantId, submissionId, extraction } = input;

  const holderName  = extraction.extractedFields['holderName']  as string | undefined;
  const holderEmail = extraction.extractedFields['holderEmail'] as string | undefined;

  const matchInput: MatchPersonInput = {
    tenantId,
    candidateText: holderName ?? holderEmail ?? '',
    ...(holderEmail !== undefined && { structuredHints: { email: holderEmail } }),
    context: {
      source:             'cert_holder',
      callerSubmissionId: submissionId,
    },
    policy: {
      onNoMatch:       'admin_queue',
      onAmbiguous:     'uploader_pickcard',
      includeInactive: false,
    },
  };

  const client = await createTemporalClient();
  const handle = await client.workflow.start('MatchPersonWorkflow', {
    args:       [matchInput],
    workflowId: `MatchPerson-${tenantId}-${submissionId}`,
    taskQueue:  process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
  });
  const result = (await handle.result()) as MatchPersonOutput;

  return EmployeeMatchResultSchema.parse({
    matched:    result.outcome === 'resolved',
    employeeId: result.employeeId,
    confidence: result.confidence ?? 0,
    method:     adaptMethod(result.source),
  });
}

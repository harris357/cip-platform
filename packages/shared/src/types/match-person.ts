// Slice 58D-A — generic person-matcher cross-service contract.
//
// MatchPersonWorkflow lives on hr-service (cip-hr-tasks queue). This file
// is the only @cip/shared surface for the matcher: input/output Zod
// schemas + inferred types. Module-workflow callers (cert today; future
// incident, training-enrollment, reminders) reference these types when
// starting the matcher as a child workflow.
//
// IMPORTANT: workflows referencing MatchPersonInput/Output MUST use
// `import type` from @cip/shared — value imports of zod schemas pull
// node-only modules into the webpack-bundled workflow context. Activity
// files that .parse() inputs may use value imports freely.
//
// The signal payload type is here too so the bot's invoke-handler and
// hr-service mcp-tools can compose the same shape; the actual signal
// definition (defineSignal('personPicked')) lives in the workflow file.

import { z } from 'zod';

// ─── Input ───────────────────────────────────────────────────────────────────

export const MatchPersonInputSchema = z.object({
  tenantId:      z.string().uuid(),
  candidateText: z.string().min(0).max(500),

  /** Optional structured hints. The canonicalizer uses these to short-
   *  circuit the LLM canonicalization step when present and trustworthy. */
  structuredHints: z.object({
    fullName:       z.string().optional(),
    firstName:      z.string().optional(),
    lastName:       z.string().optional(),
    email:          z.string().email().optional(),
    department:     z.string().optional(),
    /** AAD object id when the caller already knows it (e.g. `for me`). */
    externalUserId: z.string().optional(),
  }).optional(),

  context: z.object({
    /** Logical caller domain — 'cert_holder' | 'incident_subject' | etc. */
    source:             z.string(),
    /** Caller's entity ID. Embedded in the workflow ID per
     *  `MatchPerson-${tenantId}-${callerSubmissionId}`. */
    callerSubmissionId: z.string(),
    /** For HITL pickcard delivery (uploader 1:1 channel). */
    conversationId:     z.string().optional(),
    /** AAD object id of the uploading user. Powers the AAD pre-check
     *  (self-pick fast path) and the uploader-pickcard wrong-user gate. */
    uploaderEmployeeId: z.string().optional(),
  }),

  policy: z.object({
    /** What to do when zero candidates remain after scoring.
     *  - 'fail'         : return outcome='no_resolution'
     *  - 'admin_queue'  : pickcard goes straight to admin audience
     *  - 'create_stub'  : reserved; throws not-implemented in 58D-A
     */
    onNoMatch:       z.enum(['fail', 'admin_queue', 'create_stub']).default('fail'),
    /** What to do when multiple candidates tie or no candidate clears
     *  autoThreshold.
     *  - 'uploader_pickcard' : 1:1 pickcard to uploader (cascades to admin on TTL)
     *  - 'admin_queue'       : skip uploader; go straight to admin queue
     *  - 'fail'              : return outcome='no_resolution'
     */
    onAmbiguous:     z.enum(['uploader_pickcard', 'admin_queue', 'fail']).default('uploader_pickcard'),
    /** Override the per-tenant `hr.person_match_auto_threshold` tunable
     *  for this workflow run. */
    autoThreshold:   z.number().min(0).max(1).optional(),
    /** Default false — terminated/disabled employees are excluded from
     *  the shortlist. Callers explicitly set `true` for historical lookups
     *  (e.g. reviewing a cert issued before someone left). */
    includeInactive: z.boolean().default(false),
  }),
});
export type MatchPersonInput = z.infer<typeof MatchPersonInputSchema>;

// ─── Output ──────────────────────────────────────────────────────────────────

export const MatchPersonOutcomeSchema = z.enum(['resolved', 'no_resolution']);
export type MatchPersonOutcome = z.infer<typeof MatchPersonOutcomeSchema>;

export const MatchPersonSourceSchema = z.enum([
  'auto_self',     // AAD pre-check fast path
  'auto_unique',   // single candidate ≥ autoThreshold
  'hitl_uploader', // uploader pickcard click
  'hitl_admin',    // admin queue resolve
]);
export type MatchPersonSource = z.infer<typeof MatchPersonSourceSchema>;

export const MatchPersonOutputSchema = z.object({
  outcome:    MatchPersonOutcomeSchema,
  employeeId: z.string().uuid().optional(),
  confidence: z.number().min(0).max(1).optional(),
  source:     MatchPersonSourceSchema.optional(),
  /** Free-form bag of evidence: canonicalization, shortlist, scoring,
   *  HITL trail, no-match reason, etc. Consumers introspect ad-hoc. */
  evidence:   z.record(z.unknown()),
});
export type MatchPersonOutput = z.infer<typeof MatchPersonOutputSchema>;

// ─── Shortlist + scored candidate shapes (shared between activities) ─────────

export const PersonShortlistCandidateSchema = z.object({
  employeeId: z.string().uuid(),
  fullName:   z.string(),
  /** pg_trgm `similarity()` score against the canonicalized name. */
  score:      z.number().min(0).max(1),
  active:     z.boolean(),
});
export type PersonShortlistCandidate = z.infer<typeof PersonShortlistCandidateSchema>;

export const PersonScoredCandidateSchema = z.object({
  employeeId: z.string().uuid(),
  fullName:   z.string(),
  score:      z.number().min(0).max(1),
  /** Per-component breakdown (trgm, dept-match-bonus, etc.) for audit. */
  breakdown:  z.record(z.number()),
});
export type PersonScoredCandidate = z.infer<typeof PersonScoredCandidateSchema>;

// ─── HITL signal payload (workflow file owns the defineSignal) ───────────────

export const PersonPickedSignalSchema = z.object({
  employeeId: z.string().uuid(),
  /** Distinguishes uploader pickcard click from admin queue resolve. */
  actorRole:  z.enum(['uploader', 'admin']),
  /** AAD object id of the resolver (admin tier). */
  actorAad:   z.string().optional(),
});
export type PersonPickedSignal = z.infer<typeof PersonPickedSignalSchema>;

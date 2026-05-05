// Slice 58D-A — generic person-matching workflow.
//
// Phases:
//   1. init             - insert pending row in person_match_resolutions
//   2. AAD pre-check    - self-referential text + uploader maps to active
//                         employee → fast-path return source='auto_self'
//   3. canonicalize     - LLM normalisation of free-form hint
//   4. shortlist        - pg_trgm similarity over employees.full_name
//   5. score            - combine trgm + (future) structured-hint bonuses
//   6. decide           - 1 hit ≥ autoThreshold → auto_unique
//                         0 hits → policy.onNoMatch
//                         else  → HITL pickcard
//   7. HITL             - uploader pickcard (TTL) → admin queue (TTL) → fail
//   8. persist + return - update row to 'resolved' / 'no_resolution'
//
// IMPORTANT: this file is webpack-bundled by Temporal. EVERY import
// from @cip/shared MUST be `import type` — value imports of zod schemas
// or LiteLLM clients pull in node-only modules (tls, fs, http) that
// break the bundle. Activities (which run in Node) may use value
// imports freely.

import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  workflowInfo,
  ApplicationFailure,
} from '@temporalio/workflow';

import type {
  MatchPersonInput,
  MatchPersonOutput,
  PersonPickedSignal,
  PersonScoredCandidate,
} from '@cip/shared';

import type * as activities from '../activities/index.js';

const {
  loadPeopleTunablesActivity,
  aadPrecheckActivity,
  canonicalizePersonHintActivity,
  loadEmployeeShortlistActivity,
  scoreCandidatesActivity,
  notifyPersonPickcardActivity,
  persistPersonMatchResolutionActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

// HITL pickcard click signal. The bot's invoke handler (uploader tier)
// and the match_person_resolve MCP tool (admin tier) both send this.
export const personPickedSignal = defineSignal<[PersonPickedSignal]>('personPicked');

/** Audience selector based on policy + scored count. */
function decideAudience(
  onAmbiguous: 'uploader_pickcard' | 'admin_queue' | 'fail',
  _scoredCount: number,
): 'uploader' | 'admin' {
  if (onAmbiguous === 'admin_queue') return 'admin';
  // 'fail' is handled by the caller before this is reached;
  // 'uploader_pickcard' goes to uploader first (cascades to admin
  // on TTL expiry).
  return 'uploader';
}

export async function MatchPersonWorkflow(
  input: MatchPersonInput,
): Promise<MatchPersonOutput> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `MatchPerson-${input.tenantId}-${input.context.callerSubmissionId}`
  const tunables = await loadPeopleTunablesActivity({ tenantId: input.tenantId });

  // Step 1: insert pending resolution row.
  const wfId = workflowInfo().workflowId;
  const { resolutionId } = await persistPersonMatchResolutionActivity({
    phase:      'init',
    workflowId: wfId,
    input,
  });

  let pickedSignal: PersonPickedSignal | undefined;
  setHandler(personPickedSignal, (s: PersonPickedSignal) => {
    // First click wins; subsequent clicks see workflow already advanced.
    if (pickedSignal === undefined) pickedSignal = s;
  });

  // Phase 2: AAD pre-check. Self-referential text + active employee?
  const selfMatch = await aadPrecheckActivity({
    tenantId:           input.tenantId,
    candidateText:      input.candidateText,
    ...(input.context.uploaderEmployeeId !== undefined && {
      uploaderEmployeeId: input.context.uploaderEmployeeId,
    }),
  });
  if (selfMatch) {
    const evidence = { aadPrecheck: selfMatch };
    await persistPersonMatchResolutionActivity({
      phase:        'final',
      tenantId:     input.tenantId,
      resolutionId,
      outcome:      'resolved',
      resolvedEmployeeId: selfMatch.employeeId,
      resolutionSource:   'auto_self',
      confidence:         1.0,
      evidence,
    });
    return {
      outcome:    'resolved',
      employeeId: selfMatch.employeeId,
      confidence: 1.0,
      source:     'auto_self',
      evidence,
    };
  }

  // Phase 3-5: canonicalize → shortlist → score.
  const canonicalization = await canonicalizePersonHintActivity({
    tenantId:        input.tenantId,
    candidateText:   input.candidateText,
    ...(input.structuredHints !== undefined && { structuredHints: input.structuredHints }),
    modelAlias:      tunables.canonicalizeModel,
  });

  const shortlist = await loadEmployeeShortlistActivity({
    tenantId:        input.tenantId,
    candidateText:   input.candidateText,
    canonicalized:   canonicalization,
    includeInactive: input.policy.includeInactive,
    max:             tunables.shortlistMax,
  });

  const scored = await scoreCandidatesActivity({
    canonicalization,
    shortlist,
  });

  // Persist the process trail so the resolution row is queryable even
  // before HITL completes.
  await persistPersonMatchResolutionActivity({
    phase:            'process',
    tenantId:         input.tenantId,
    resolutionId,
    canonicalization,
    shortlist,
    scoredCandidates: scored,
  });

  // Phase 6: decide.
  const autoThreshold = input.policy.autoThreshold ?? tunables.autoThreshold;

  // Single hit ≥ threshold: auto-resolve.
  const top = scored[0];
  if (scored.length === 1 && top !== undefined && top.score >= autoThreshold) {
    const evidence = { canonicalization, shortlist, scored, autoThreshold };
    await persistPersonMatchResolutionActivity({
      phase:    'final',
      tenantId: input.tenantId,
      resolutionId,
      outcome:  'resolved',
      resolvedEmployeeId: top.employeeId,
      resolutionSource:   'auto_unique',
      confidence:         top.score,
      evidence,
    });
    return {
      outcome:    'resolved',
      employeeId: top.employeeId,
      confidence: top.score,
      source:     'auto_unique',
      evidence,
    };
  }

  // Zero hits: run policy.onNoMatch.
  if (scored.length === 0) {
    if (input.policy.onNoMatch === 'fail') {
      const evidence = { canonicalization, shortlist: [] as PersonScoredCandidate[], reason: 'no_matches' };
      await persistPersonMatchResolutionActivity({
        phase:    'final',
        tenantId: input.tenantId,
        resolutionId,
        outcome:  'no_resolution',
        evidence,
      });
      return {
        outcome:  'no_resolution',
        evidence,
      };
    }
    if (input.policy.onNoMatch === 'create_stub') {
      // Reserved for a future slice; throw so the caller sees a clear
      // structured failure rather than a silent fallthrough.
      throw ApplicationFailure.create({
        type:        'NotImplemented',
        message:     "policy.onNoMatch='create_stub' is reserved for a future slice",
        nonRetryable: true,
      });
    }
    // 'admin_queue' falls through to the HITL phase with audience='admin'.
  }

  // Phase 7: HITL pickcard.
  const audience = scored.length === 0
    // Zero candidates with onNoMatch='admin_queue' → admin tier.
    ? 'admin' as const
    : decideAudience(input.policy.onAmbiguous, scored.length);

  await notifyPersonPickcardActivity({
    tenantId:     input.tenantId,
    resolutionId,
    audience,
    candidates:   scored,
    ...(input.context.conversationId !== undefined && { conversationId: input.context.conversationId }),
  });
  await persistPersonMatchResolutionActivity({
    phase:        'hitl_offered',
    tenantId:     input.tenantId,
    resolutionId,
    audience,
  });

  // Uploader tier: wait up to uploaderTtlHours then cascade to admin.
  if (audience === 'uploader') {
    const got = await condition(
      () => pickedSignal !== undefined,
      `${tunables.uploaderTtlHours} hours`,
    );
    if (!got) {
      // Cascade to admin tier.
      await notifyPersonPickcardActivity({
        tenantId:     input.tenantId,
        resolutionId,
        audience:     'admin',
        candidates:   scored,
        ...(input.context.conversationId !== undefined && { conversationId: input.context.conversationId }),
      });
      await persistPersonMatchResolutionActivity({
        phase:        'hitl_offered',
        tenantId:     input.tenantId,
        resolutionId,
        audience:     'admin',
      });
    }
  }

  // Admin tier (or cascade): wait up to adminTtlHours; on expiry fail.
  if (pickedSignal === undefined) {
    const got = await condition(
      () => pickedSignal !== undefined,
      `${tunables.adminTtlHours} hours`,
    );
    if (!got) {
      const evidence = { canonicalization, shortlist, scored, reason: 'hitl_ttl_exhausted' };
      await persistPersonMatchResolutionActivity({
        phase:    'final',
        tenantId: input.tenantId,
        resolutionId,
        outcome:  'no_resolution',
        evidence,
      });
      return {
        outcome:  'no_resolution',
        evidence,
      };
    }
  }

  // Resolved via HITL.
  const picked = pickedSignal!;
  const matchingScored = scored.find(c => c.employeeId === picked.employeeId);
  const confidence = matchingScored?.score ?? 0;
  const source = picked.actorRole === 'uploader' ? 'hitl_uploader' : 'hitl_admin';
  const evidence = { canonicalization, shortlist, scored, hitl: picked };

  await persistPersonMatchResolutionActivity({
    phase:    'final',
    tenantId: input.tenantId,
    resolutionId,
    outcome:  'resolved',
    resolvedEmployeeId: picked.employeeId,
    resolutionSource:   source,
    confidence,
    hitlActorRole:      picked.actorRole,
    evidence,
  });

  return {
    outcome:    'resolved',
    employeeId: picked.employeeId,
    confidence,
    source,
    evidence,
  };
}

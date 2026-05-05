import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  startChild,
  ApplicationFailure,
} from '@temporalio/workflow';
import type { HITLDecisionSignal } from '@cip/shared';
// Slice 58D-B — webpack-bundled workflow context. Type-only import of
// the matcher contract: value imports of zod schemas pull node-only
// modules (tls/fs/http) into the bundle.
import type {
  MatchPersonInput,
  MatchPersonOutput,
} from '@cip/shared';
import type * as activities from '../activities/index.js';
// `MatchPersonWorkflow` is referenced as a type-only generic argument
// to `startChild` for parent/child type inference; the actual workflow
// runs on its own queue and is registered on the people-module worker
// path (same `cip-hr-tasks` queue as cert).
import type { MatchPersonWorkflow } from '../../people/workflows/match-person.workflow.js';

const {
  fetchDocumentActivity,
  preClassifyCertActivity,
  runVisionAgentActivity,
  validateExtractionActivity,
  persistCertActivity,
  matchCertDefinition,
  publishCertProcessedActivity,
  rejectCertSubmissionActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
});

const { notifyHitlActivity } = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 5 },
});

export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision');

export interface CertificationProcessingWorkflowInput {
  tenantId:       string;
  submissionId:   string;
  employeeId:     string;
  objectStoreKey: string;
}

export async function CertificationProcessingWorkflow(
  input: CertificationProcessingWorkflowInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `CertProcess-${input.tenantId}-${input.submissionId}`
  const { tenantId, submissionId, employeeId, objectStoreKey } = input;

  let hitlDecision: HITLDecisionSignal | undefined;
  setHandler(hitlDecisionSignal, (decision) => { hitlDecision = decision; });

  const { documentBase64 } = await fetchDocumentActivity({ tenantId, objectStoreKey });
  const { certTypeHint }   = await preClassifyCertActivity({ tenantId, documentBase64 });

  const extraction = await runVisionAgentActivity({
    tenantId, submissionId, employeeId, documentBase64, certTypeHint,
  });

  await validateExtractionActivity({ tenantId, submissionId, extraction });

  // Slice 58D-B — subject resolution is now delegated to the generic
  // person-matcher (slice 58D-A). The matcher owns canonicalization,
  // pg_trgm shortlist, scoring, and ambiguity-HITL (uploader pickcard
  // → admin queue cascade). Cert keeps its own DATA-HITL gate below
  // for low-extraction-confidence + ambiguous-cert-type only.
  //
  // The matcher input fields `conversationId` and `uploaderHintText`
  // are intentionally not threaded here: the current cert workflow
  // input shape doesn't carry them. 58E (Route-A rewrite) extends the
  // workflow input to include those, at which point this call site
  // forwards them. Until then the matcher's pickcard activity treats
  // missing conversationId as a non-fatal degradation (channels are
  // resolved by channelType server-side) and the AAD pre-check still
  // works for self-uploads via `uploaderEmployeeId`.

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const matchPersonHandle = await startChild<typeof MatchPersonWorkflow>('MatchPersonWorkflow', {
    args: [{
      tenantId,
      candidateText: (extraction.extractedFields['holderName']  as string | undefined)
                  ?? (extraction.extractedFields['holderEmail'] as string | undefined)
                  ?? '',
      ...(extraction.extractedFields['holderEmail'] !== undefined && {
        structuredHints: { email: extraction.extractedFields['holderEmail'] as string },
      }),
      context: {
        source:             'cert_holder',
        callerSubmissionId: submissionId,
        // `employeeId` here is the uploader's id (set by the bot's
        // process_document MCP tool from authInfo). Powers the
        // matcher's AAD pre-check self-pick fast path.
        uploaderEmployeeId: employeeId,
      },
      policy: {
        onNoMatch:       'admin_queue',
        onAmbiguous:     'uploader_pickcard',
        includeInactive: false,
      },
    } satisfies MatchPersonInput],
    workflowId: `MatchPerson-${tenantId}-${submissionId}`,
    taskQueue:  'cip-hr-tasks',
  });

  const [personResult, certMatch] = await Promise.all([
    matchPersonHandle.result() as Promise<MatchPersonOutput>,
    matchCertDefinition({ tenantId, submissionId, extraction }),
  ]);

  if (personResult.outcome === 'no_resolution') {
    const reasonRaw = personResult.evidence['reason'];
    const reason = typeof reasonRaw === 'string' ? reasonRaw : 'subject_unresolved';
    await rejectCertSubmissionActivity({ tenantId, submissionId, reason });
    throw ApplicationFailure.create({
      type:         'SubjectUnresolved',
      message:      `cert submission ${submissionId} subject unresolved: ${reason}`,
      nonRetryable: true,
    });
  }

  const subjectEmployeeId = personResult.employeeId!;
  const personConfidence  = personResult.confidence ?? 0;

  const needsHitl =
    extraction.overallConfidence < 0.85 ||
    personConfidence < 0.7 ||
    certMatch.confidence < 0.7;

  if (needsHitl) {
    const hitlReasonCode =
      extraction.overallConfidence < 0.85 ? 'low_confidence' as const :
      personConfidence < 0.7              ? 'ambiguous_person' as const :
                                            'ambiguous_cert_type' as const;

    await notifyHitlActivity({ tenantId, submissionId, hitlReasonCode });
    await condition(() => hitlDecision !== undefined, '7 days');
  }

  const { certificationId } = await persistCertActivity({
    tenantId,
    submissionId,
    extraction,
    matchedEmployeeId: subjectEmployeeId,
    certDefId:         certMatch.certDefId,
  });

  await publishCertProcessedActivity({ tenantId, certificationId, employeeId, submissionId });
}

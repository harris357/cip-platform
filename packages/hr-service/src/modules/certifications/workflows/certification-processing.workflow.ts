import {
  proxyActivities,
  defineSignal,
  setHandler,
  condition,
  startChild,
  ApplicationFailure,
} from '@temporalio/workflow';
// Slice 58E — webpack-bundled workflow context. Type-only @cip/shared
// imports so zod schemas don't pull node-only modules into the bundle
// (slice 58C learned this; do not regress).
import type {
  HITLDecisionSignal,
  ProcessDocumentInput,
  ExtractionResult,
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
  // Slice 58E — Route-A activities.
  createCertSubmissionRowActivity,
  signalDocumentServiceCallbackActivity,
  // Existing activities (kept; cert still owns these).
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

/**
 * Build a synthetic `ExtractionResult` from `ProcessDocumentInput`.
 *
 * The legacy cert activities (validateExtraction, persistCert,
 * matchCertDefinition) consume `ExtractionResult` shape (certType,
 * extractedFields, overallConfidence, promptVersion, modelUsed). 58E's
 * Route-A receives `ProcessDocumentInput` from doc-service which
 * carries `extractedFeatures` + top-level `extractionConfidence` and
 * does NOT carry promptVersion/modelUsed (those live in the strategy's
 * evidence, not propagated). We bridge via this shim — adapters keep
 * the activities working without rewriting their input schemas.
 */
function inputToExtractionResult(input: ProcessDocumentInput): ExtractionResult {
  return {
    tenantId:          input.tenantId,
    certType:          input.docType,
    extractedFields:   input.extractedFeatures as Record<string, unknown>,
    overallConfidence: input.extractionConfidence,
    requiresHITL:      false,
    promptVersion:     'doc-service',
    modelUsed:         'doc-service',
    tokensUsed:        0,
    costUsd:           0,
  };
}

export async function CertificationProcessingWorkflow(
  input: ProcessDocumentInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `CertProcess-${input.tenantId}-${input.documentId}` at dispatch
  // (the cross-queue dispatcher in doc-service uses documentId as the entity
  // id; the cert workflow internally also tracks certSubmissionId, see below).
  const {
    tenantId,
    documentId,
    extractedFeatures,
    uploaderEmployeeId,
    uploaderHintText,
    conversationId,
    extractionConfidence,
    s3Key,
  } = input;

  // Route-A entry: create the cert_submissions row (was previously
  // created externally by the bot's process_document MCP tool).
  const { certSubmissionId } = await createCertSubmissionRowActivity({
    tenantId,
    documentId,
    uploaderEmployeeId,
    s3Key,
  });

  let hitlDecision: HITLDecisionSignal | undefined;
  setHandler(hitlDecisionSignal, (decision) => { hitlDecision = decision; });

  // Build the legacy ExtractionResult shape once for the activities
  // that haven't been migrated to ProcessDocumentInput yet.
  const extraction: ExtractionResult = inputToExtractionResult(input);

  await validateExtractionActivity({ tenantId, submissionId: certSubmissionId, extraction });

  // Slice 58D-B preserved verbatim — subject resolution via
  // MatchPersonWorkflow as a child workflow. Field references updated
  // for the 58E ProcessDocumentInput shape: `extractedFeatures` is the
  // generic per-doc-type field bag (cert: holderName, holderEmail, etc.).
  const holderName  = extractedFeatures['holderName']  as string | undefined;
  const holderEmail = extractedFeatures['holderEmail'] as string | undefined;

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const matchPersonHandle = await startChild<typeof MatchPersonWorkflow>('MatchPersonWorkflow', {
    args: [{
      tenantId,
      candidateText: holderName ?? holderEmail ?? uploaderHintText ?? '',
      ...(holderEmail !== undefined && {
        structuredHints: { email: holderEmail },
      }),
      context: {
        source:             'cert_holder',
        callerSubmissionId: certSubmissionId,
        // `uploaderEmployeeId` from ProcessDocumentInput is the AAD oid
        // of the human who uploaded the file (powers MatchPerson's AAD
        // self-pick fast path). Forward conversationId so the matcher's
        // pickcard activity can deliver to the right Teams thread.
        ...(conversationId     !== undefined && { conversationId }),
        uploaderEmployeeId,
      },
      // Post-Q4 default policy: onNoMatch='admin_queue', onAmbiguous=
      // 'uploader_pickcard'. Schema defaults match; we still pass the
      // object explicitly because the inferred TS type marks `policy`
      // as required (Zod `.default()` doesn't propagate into the
      // inferred input type).
      policy: {
        onNoMatch:       'admin_queue',
        onAmbiguous:     'uploader_pickcard',
        includeInactive: false,
      },
    } satisfies MatchPersonInput],
    workflowId: `MatchPerson-${tenantId}-${certSubmissionId}`,
    taskQueue:  'cip-hr-tasks',
  });

  const [personResult, certMatch] = await Promise.all([
    matchPersonHandle.result() as Promise<MatchPersonOutput>,
    matchCertDefinition({ tenantId, submissionId: certSubmissionId, extraction }),
  ]);

  if (personResult.outcome === 'no_resolution') {
    const reasonRaw = personResult.evidence['reason'];
    const reason = typeof reasonRaw === 'string' ? reasonRaw : 'subject_unresolved';
    await rejectCertSubmissionActivity({ tenantId, submissionId: certSubmissionId, reason });
    // Inform doc-service the cert was rejected so the doc transitions
    // to 'failed' (best-effort signal — see activity).
    await signalDocumentServiceCallbackActivity({
      tenantId,
      documentId,
      moduleRecordId: certSubmissionId,
      status:         'rejected',
      reason,
    });
    throw ApplicationFailure.create({
      type:         'SubjectUnresolved',
      message:      `cert submission ${certSubmissionId} subject unresolved: ${reason}`,
      nonRetryable: true,
    });
  }

  const subjectEmployeeId = personResult.employeeId!;
  const personConfidence  = personResult.confidence ?? 0;

  // Cert-DATA HITL gate: low extraction confidence OR low person-match
  // OR low cert-definition match. Subject ambiguity HITL is owned by
  // MatchPersonWorkflow and never reaches this branch.
  const needsHitl =
    extractionConfidence < 0.85 ||
    personConfidence     < 0.7  ||
    certMatch.confidence < 0.7;

  if (needsHitl) {
    const hitlReasonCode =
      extractionConfidence < 0.85 ? 'low_confidence' as const :
      personConfidence     < 0.7  ? 'ambiguous_person' as const :
                                    'ambiguous_cert_type' as const;

    await notifyHitlActivity({ tenantId, submissionId: certSubmissionId, hitlReasonCode });
    await condition(() => hitlDecision !== undefined, '7 days');
  }

  const { certificationId } = await persistCertActivity({
    tenantId,
    submissionId:      certSubmissionId,
    extraction,
    matchedEmployeeId: subjectEmployeeId,
    certDefId:         certMatch.certDefId,
  });

  await publishCertProcessedActivity({
    tenantId,
    certificationId,
    employeeId:   subjectEmployeeId,
    submissionId: certSubmissionId,
  });

  // Tell doc-service we're done so the doc transitions to 'archived'.
  await signalDocumentServiceCallbackActivity({
    tenantId,
    documentId,
    moduleRecordId: certificationId,
    status:         'accepted',
  });
}

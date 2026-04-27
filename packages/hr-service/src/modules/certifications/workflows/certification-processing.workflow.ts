import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type { HITLDecisionSignal } from '@cip/shared';
import type * as activities from '../activities/index.js';

const {
  fetchDocumentActivity,
  preClassifyCertActivity,
  runVisionAgentActivity,
  validateExtractionActivity,
  persistCertActivity,
  matchEmployee,
  matchCertDefinition,
  publishCertProcessedActivity,
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

  const [employeeMatch, certMatch] = await Promise.all([
    matchEmployee({ tenantId, submissionId, extraction }),
    matchCertDefinition({ tenantId, submissionId, extraction }),
  ]);

  const needsHitl =
    extraction.overallConfidence < 0.85 ||
    employeeMatch.confidence < 0.7 ||
    certMatch.confidence < 0.7;

  if (needsHitl) {
    const hitlReasonCode =
      extraction.overallConfidence < 0.85 ? 'low_confidence' as const :
      employeeMatch.confidence < 0.7      ? 'ambiguous_person' as const :
                                            'ambiguous_cert_type' as const;

    await notifyHitlActivity({ tenantId, submissionId, hitlReasonCode });
    await condition(() => hitlDecision !== undefined, '7 days');
  }

  const { certificationId } = await persistCertActivity({
    tenantId,
    submissionId,
    extraction,
    matchedEmployeeId: employeeMatch.employeeId,
    certDefId:         certMatch.certDefId,
  });

  await publishCertProcessedActivity({ tenantId, certificationId, employeeId, submissionId });
}

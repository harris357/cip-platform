import { proxyActivities, defineSignal, setHandler, condition } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { CertProcessingInput, HITLDecisionSignal } from '@cip/shared/src/types/workflow.js';

const {
  fetchDocument,
  preClassifyCert,
  runVisionAgent,
  validateExtraction,
  persistCert,
  notifyHITL,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, backoffCoefficient: 2 },
});

// HITL signal — the admin sends this from the Teams Bot to resume the workflow
export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision');

export async function CertificationProcessingWorkflow(
  input: CertProcessingInput,
): Promise<void> {
  // Workflow ID convention: cert-processing-{tenantId}-{certificationId}
  // This is enforced when starting the workflow via the Temporal client

  let hitlDecision: HITLDecisionSignal | null = null;

  // Register signal handler before any await points
  setHandler(hitlDecisionSignal, (signal) => { hitlDecision = signal; });

  // ── Act 1: Fetch document from OVH Object Store ──
  const document = await fetchDocument({
    tenantId: input.tenantId,
    objectStoreKey: input.objectStoreKey,
  });

  // ── Act 2: Tier 1 pre-classification (no AI, fast, cheap) ──
  const preClassification = await preClassifyCert({
    tenantId: input.tenantId,
    documentMetadata: document.metadata,
  });

  // ── Act 3: Vision Agent (Tier 3 — full LangGraph graph via LiteLLM) ──
  const extraction = await runVisionAgent({
    tenantId: input.tenantId,
    workerId: input.workerId,
    certificationId: input.certificationId,
    documentBase64: document.base64,
    certType: preClassification.certType,
    workflowId: `cert-processing-${input.tenantId}-${input.certificationId}`,
  });

  // ── Act 4: Validate extraction against cert type schema ──
  await validateExtraction({
    tenantId: input.tenantId,
    extraction,
    certType: preClassification.certType,
  });

  // ── Act 5: HITL gate — pause if confidence is low ──
  if (extraction.requiresHITL) {
    await notifyHITL({
      tenantId: input.tenantId,
      workerId: input.workerId,
      certificationId: input.certificationId,
      extraction,
      workflowId: `cert-processing-${input.tenantId}-${input.certificationId}`,
    });

    // Wait up to 5 days for admin decision via Teams Bot signal
    const signalReceived = await condition(
      () => hitlDecision !== null,
      '5 days',
    );

    // Snapshot the mutable variable — TypeScript's closure narrowing can't track
    // mutations made via setHandler callbacks, so we capture it here explicitly.
    const decision = hitlDecision as HITLDecisionSignal | null;
    if (!signalReceived || decision === null || decision.approved === false) {
      // TODO: mark cert as rejected, notify worker
      return;
    }

    // TODO: merge decision.correctedFields into extraction before persisting
  }

  // ── Act 6: Persist validated cert to PostgreSQL ──
  await persistCert({
    tenantId: input.tenantId,
    workerId: input.workerId,
    certificationId: input.certificationId,
    extraction,
    // exactOptionalPropertyTypes: omit the key entirely when null rather than passing undefined
    ...(hitlDecision !== null ? { hitlDecision } : {}),
  });
}

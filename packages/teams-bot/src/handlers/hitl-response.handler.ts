import type { TurnContext } from 'botbuilder';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { HITLDecisionSignal } from '@cip/shared/src/types/workflow.js';

export async function handleHITLResponse(
  context: TurnContext,
  tenantContext: TenantContext,
  workflowId: string,
  decision: HITLDecisionSignal,
): Promise<void> {
  void context;

  const client = await createTemporalClient(`${tenantContext.tenantId}.cip`);
  const handle = client.workflow.getHandle(workflowId);

  // Send hitlDecisionSignal to resume the paused CertificationProcessingWorkflow
  await handle.signal('hitlDecision', decision);
}

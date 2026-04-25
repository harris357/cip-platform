import type { TurnContext } from 'botbuilder';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';
import type { IntentResult } from '@cip/shared/src/types/agent.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { HITLDecisionSignal } from '@cip/shared/src/types/workflow.js';

export async function hitlResponseHandler(
  context: TurnContext,
  tenantCtx: TenantContext,
  intent: IntentResult,
): Promise<void> {
  void context;

  const workflowId = intent.entities['workflowId'];
  if (!workflowId) {
    throw new Error('RESPOND_HITL intent missing workflowId entity');
  }

  const approved = intent.entities['decision'] === 'approve';

  const signal: HITLDecisionSignal = {
    reviewedBy: tenantCtx.userId,
    reviewedAt: new Date().toISOString(),
    approved,
  };

  const client = await createTemporalClient();
  const handle = client.workflow.getHandle(workflowId);
  // Signal the paused CertificationProcessingWorkflow — never trigger a new workflow
  await handle.signal('hitlDecision', signal);
}

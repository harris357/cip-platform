import type { ExtractionResult } from '@cip/shared/src/types/agent.js';

export interface NotifyHITLInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  extraction: ExtractionResult;
  workflowId: string;
}

export async function notifyHITL(input: NotifyHITLInput): Promise<void> {
  void input;
  // TODO: send Teams Bot message to admin group with HITL review card
  // Include workflowId so admin can send hitlDecisionSignal back
  throw new Error('notifyHITL: not implemented');
}

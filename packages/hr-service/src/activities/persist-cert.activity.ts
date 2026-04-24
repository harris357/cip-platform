import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import type { HITLDecisionSignal } from '@cip/shared/src/types/workflow.js';

export interface PersistCertInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  extraction: ExtractionResult;
  hitlDecision?: HITLDecisionSignal;
}

export async function persistCert(input: PersistCertInput): Promise<void> {
  void input;
  // TODO: upsert into certifications table with RLS context set to input.tenantId
  throw new Error('persistCert: not implemented');
}

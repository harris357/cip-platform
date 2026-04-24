// CertificationProcessingWorkflow input
export interface CertProcessingInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  objectStoreKey: string;
  uploadedBy: string;
}

// HITL signal payload — sent to resume a paused workflow
export interface HITLDecisionSignal {
  approved: boolean;
  reviewedBy: string;
  correctedFields?: Record<string, string>;
  rejectionReason?: string;
  reviewedAt: string; // ISO datetime
}

// TenantProvisioningWorkflow input
export interface TenantProvisioningInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}

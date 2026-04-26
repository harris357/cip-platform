export interface TenantProvisioningInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}

export interface CertProcessingInput {
  tenantId:        string;
  certificationId: string;
  workerId:        string;
  objectStoreKey:  string;
}

// HITLDecisionSignal is a cross-service contract: teams-bot sends it, hr-service Temporal workflow receives it.
export interface HITLDecisionSignal {
  approved: boolean;
  correctedFields?: Record<string, string>;
  reviewedBy: string;
  reviewedAt: string;
}

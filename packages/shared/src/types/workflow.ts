import type { CertStatus, PersistedExtractionResult } from './certification.js';

export interface HITLDecisionSignal {
  approved: boolean;
  correctedFields?: Record<string, string>;
  reviewedBy: string;
  reviewedAt: string;   // ISO 8601
}

export interface CertProcessingInput {
  tenantId: string;
  certId: string;
  certificationId: string;
  objectStoreKey: string;
  workerId: string;
  documentUrl: string;
  uploadedBy: string;
}

export interface CertProcessingOutput {
  tenantId: string;
  certId: string;
  status: CertStatus;
  extractionResult?: PersistedExtractionResult;
  hitlRequired: boolean;
}

export interface TenantProvisioningInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}

export interface TenantProvisioningOutput {
  tenantId: string;
  success: boolean;
  provisionedAt: string;      // ISO 8601
  litellmVirtualKey: string;
}

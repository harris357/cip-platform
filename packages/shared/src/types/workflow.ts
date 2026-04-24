import type { CertStatus, ExtractionResult } from './certification.js';

export interface CertProcessingInput {
  tenantId: string;
  certId: string;
  workerId: string;
  documentUrl: string;
  uploadedBy: string;
}

export interface CertProcessingOutput {
  tenantId: string;
  certId: string;
  status: CertStatus;
  extractionResult?: ExtractionResult;
  hitlRequired: boolean;
}

export interface TenantProvisioningInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
}

export interface TenantProvisioningOutput {
  tenantId: string;
  success: boolean;
  provisionedAt: string;      // ISO 8601
  litellmVirtualKey: string;
}

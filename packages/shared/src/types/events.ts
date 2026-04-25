// Subject pattern: cip.{tenantId}.{domain}.{event}.v{N}
// Always built via buildSubject() — never as raw strings

import type { CertStatus } from './certification.js';

export interface CertUploadedEvent {
  tenantId: string;
  certId: string;
  workerId: string;
  documentUrl: string;
  uploadedBy: string;
  uploadedAt: string;     // ISO 8601
}

export interface CertProcessedEvent {
  tenantId: string;
  certId: string;
  status: CertStatus;
  processedAt: string;    // ISO 8601
}

export interface CertExpiredEvent {
  tenantId: string;
  certId: string;
  workerId: string;
  expiredAt: string;      // ISO 8601
}

export interface ComplianceDriftedEvent {
  tenantId: string;
  workerId: string;
  driftType: 'missing_cert' | 'expired_cert' | 'allocation_mismatch';
  detectedAt: string;     // ISO 8601
}

export interface TenantProvisionedEvent {
  tenantId: string;
  tenantName: string;
  provisionedAt: string;  // ISO 8601
}

export interface CertificationUploadedEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  objectStoreKey: string;
  uploadedBy: string;
  uploadedAt: string;     // ISO 8601
}

export interface WorkerAllocatedToSiteEvent {
  tenantId: string;
  workerId: string;
  siteId: string;
  allocatedAt: string;    // ISO 8601
}

export interface WorkerOnboardedEvent {
  tenantId: string;
  workerId: string;
  onboardedAt: string;    // ISO 8601
}

// All NATS event payloads — tenantId always present
export interface CertificationUploadedEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  objectStoreKey: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface CertificationValidatedEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  certType: string;
  expiresAt: string;
  validatedAt: string;
}

export interface CertificationExpiredEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  certType: string;
  expiredAt: string;
}

export interface WorkerAllocatedToSiteEvent {
  tenantId: string;
  workerId: string;
  siteId: string;
  allocationId: string;
  allocatedAt: string;
}

export interface TenantProvisionedEvent {
  tenantId: string;
  tenantName: string;
  provisionedAt: string;
}

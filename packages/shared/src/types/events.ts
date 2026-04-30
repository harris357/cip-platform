// TenantProvisionedEvent is platform-level — no single service owns tenant lifecycle.
export interface TenantProvisionedEvent {
  tenantId: string;
  tenantName: string;
  provisionedAt: string;
}

// CertUploadedEvent is published by teams-bot and consumed by hr-service.
export interface CertUploadedEvent {
  tenantId:    string;
  certId:      string;
  workerId:    string;
  documentUrl: string;
  uploadedBy:  string;
  uploadedAt:  string;
}

// CertProcessedEvent is published by hr-service after vision-agent completes.
export interface CertProcessedEvent {
  tenantId:    string;
  certId:      string;
  workerId:    string;
  status:      string;
  processedAt: string;
}

// CertExpiredEvent is published by hr-service nats watcher on expiry detection.
export interface CertExpiredEvent {
  tenantId:   string;
  certId:     string;
  workerId:   string;
  expiredAt:  string;
}

// EmployeeOnboardedEvent is published by hr-service after employee provisioning completes.
export interface EmployeeOnboardedEvent {
  tenantId:     string;
  employeeId:   string;
  identityType: string;
  onboardedAt:  string;
}

// Slice 33: published when an employee's identity_type changes (AAD↔field).
export interface EmployeeIdentityChangedEvent {
  tenantId:   string;
  employeeId: string;
  fromType:   string;   // 'aad_federated' | 'field_employee'
  toType:     string;
  changedAt:  string;
}

// Slice 33: published when an employee is disabled (terminated, deactivated).
export interface EmployeeDisabledEvent {
  tenantId:   string;
  employeeId: string;
  reason:     string | null;
  disabledAt: string;
}

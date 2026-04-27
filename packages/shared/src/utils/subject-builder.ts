// ALL NATS subjects must be constructed here. Never construct raw subject strings elsewhere.

export type NatsDomain = 'cert' | 'worker' | 'compliance' | 'tenant' | 'employee';
export type NatsVersion = 'v1';

export interface SubjectParts {
  tenantId: string;
  domain: NatsDomain;
  event: string;
  version?: NatsVersion;
}

export function buildSubject(parts: SubjectParts): string {
  const v = parts.version ?? 'v1';
  return `cip.${parts.tenantId}.${parts.domain}.${parts.event}.${v}`;
}

export const Subjects = {
  certUploaded: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'uploaded' }),
  certProcessed: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'processed' }),
  certExpired: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'expired' }),
  complianceDrifted: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'compliance', event: 'drifted' }),
  tenantProvisioned: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'tenant', event: 'provisioned' }),
  workerOnboarded: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'worker', event: 'onboarded' }),
  employeeOnboarded: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'employee', event: 'onboarded' }),
} as const;

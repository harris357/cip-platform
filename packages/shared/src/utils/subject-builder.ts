// ALL NATS subjects must be constructed here. Never construct raw subject strings elsewhere.

export type NatsDomain = 'cert' | 'worker' | 'compliance' | 'tenant';
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
} as const;

/**
 * Canonical NATS subject builder.
 * ALL subject construction must go through this function.
 * Never build subject strings ad-hoc in individual services.
 *
 * Schema: cip.{tenantId}.{domain}.{eventName}
 */
export function buildSubject(
  tenantId: string,
  domain: 'hr' | 'ops' | 'platform' | 'agents',
  eventName: string,
): string {
  if (!tenantId || !domain || !eventName) {
    throw new Error('buildSubject: all parameters required');
  }
  return `cip.${tenantId}.${domain}.${eventName}`;
}

// Typed subject constants — use these, not raw strings
export const Subjects = {
  certificationUploaded: (t: string) => buildSubject(t, 'hr', 'certificationUploaded'),
  certificationValidated: (t: string) => buildSubject(t, 'hr', 'certificationValidated'),
  certificationExpired: (t: string) => buildSubject(t, 'hr', 'certificationExpired'),
  workerOnboarded: (t: string) => buildSubject(t, 'hr', 'workerOnboarded'),
  workerAllocatedToSite: (t: string) => buildSubject(t, 'ops', 'workerAllocatedToSite'),
  incidentOccurred: (t: string) => buildSubject(t, 'ops', 'incidentOccurred'),
  tenantProvisioned: (t: string) => buildSubject(t, 'platform', 'tenantProvisioned'),
} as const;

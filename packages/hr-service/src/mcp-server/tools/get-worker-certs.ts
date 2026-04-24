import type { Certification } from '@cip/shared/src/types/certification.js';

export async function getWorkerCertificationsHandler(
  workerId: string,
  tenantId: string,
): Promise<Certification[]> {
  void workerId;
  void tenantId;
  // TODO: query certifications from PostgreSQL with RLS context set to tenantId
  throw new Error('getWorkerCertificationsHandler: not implemented');
}

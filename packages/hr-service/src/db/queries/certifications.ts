import type { Pool } from 'pg';
import { setTenantContext } from '@cip/shared/src/clients/postgres.js';
import type { Certification, CertStatus } from '@cip/shared/src/types/certification.js';

export async function getCertificationsByWorker(
  pool: Pool,
  tenantId: string,
  workerId: string,
): Promise<Certification[]> {
  const client = await pool.connect();
  try {
    await setTenantContext(client, tenantId);
    // TODO: implement query
    void workerId;
    throw new Error('getCertificationsByWorker: not implemented');
  } finally {
    client.release();
  }
}

export async function updateCertificationStatus(
  pool: Pool,
  tenantId: string,
  certificationId: string,
  status: CertStatus,
): Promise<void> {
  const client = await pool.connect();
  try {
    await setTenantContext(client, tenantId);
    void certificationId;
    void status;
    throw new Error('updateCertificationStatus: not implemented');
  } finally {
    client.release();
  }
}

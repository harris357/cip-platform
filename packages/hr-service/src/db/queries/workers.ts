import type { Pool } from 'pg';
import { setTenantContext } from '@cip/shared/src/clients/postgres.js';

export interface Worker {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  keycloakId: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function getWorkerById(
  pool: Pool,
  tenantId: string,
  workerId: string,
): Promise<Worker | null> {
  const client = await pool.connect();
  try {
    await setTenantContext(client, tenantId);
    void workerId;
    // TODO: implement query
    throw new Error('getWorkerById: not implemented');
  } finally {
    client.release();
  }
}

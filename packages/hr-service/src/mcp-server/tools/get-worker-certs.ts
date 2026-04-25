import { withTenantRLS, createPool } from '@cip/shared/src/clients/postgres.js';
import type { Certification } from '@cip/shared/src/types/certification.js';
import type { PoolClient } from 'pg';

const pool = createPool(process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/cip_hr');

export async function getWorkerCertsHandler(
  workerId: string,
  tenantId: string,
): Promise<Certification[]> {
  const client = await pool.connect();
  try {
    return await withTenantRLS(client, tenantId, async (c: PoolClient) => {
      const result = await c.query(
        'SELECT * FROM certifications WHERE worker_id = $1',
        [workerId],
      );
      return result.rows as Certification[];
    });
  } finally {
    client.release();
  }
}

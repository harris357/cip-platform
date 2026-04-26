import { withTenantRLS, createPool } from '@cip/shared/src/clients/postgres.js';
import type { Certification } from '@cip/shared/src/types/certification.js';
import type { PoolClient } from 'pg';

export interface ComplianceStatus {
  compliant: boolean;
  missing: string[];
  expired: string[];
}

const pool = createPool(process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/cip_hr');

export async function getComplianceStatusHandler(
  workerId: string,
  tenantId: string,
): Promise<ComplianceStatus> {
  const client = await pool.connect();
  try {
    const certs = await withTenantRLS(client, tenantId, async (c: PoolClient) => {
      const result = await c.query(
        'SELECT * FROM certifications WHERE worker_id = $1',
        [workerId],
      );
      return result.rows as Certification[];
    });

    const now = new Date().toISOString().slice(0, 10);
    const expired = certs
      .filter((c) => c.status === 'expired' || (c.expiryDate !== null && c.expiryDate < now))
      .map((c) => c.certType);

    return {
      compliant: expired.length === 0,
      missing: [],
      expired,
    };
  } finally {
    client.release();
  }
}

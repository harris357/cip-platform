import type { PoolClient } from 'pg';
import type { Certification } from '@cip/shared/src/types/certification.js';

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS wrapper

export async function findCertificationById(
  client: PoolClient,
  id: string,
): Promise<Certification | null> {
  const result = await client.query(
    'SELECT * FROM certifications WHERE id = $1',
    [id],
  );
  return (result.rows[0] as Certification) ?? null;
}

export async function upsertCertification(
  client: PoolClient,
  cert: Omit<Certification, 'createdAt' | 'updatedAt'>,
): Promise<Certification> {
  void cert;
  throw new Error('not implemented');
}

export async function findExpiredCertifications(
  client: PoolClient,
  beforeDate: string,
): Promise<Certification[]> {
  void beforeDate;
  throw new Error('not implemented');
}

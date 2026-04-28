import type { PoolClient } from 'pg';
import type { Worker } from '@cip/shared/src/types/worker.js';

export type { Worker };

const WORKER_COLUMNS = `
  id,
  tenant_id   AS "tenantId",
  email,
  full_name   AS "fullName",
  keycloak_id AS "keycloakId",
  created_at  AS "createdAt",
  updated_at  AS "updatedAt"
`;

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS wrapper

export async function findWorkerById(
  client: PoolClient,
  id: string,
): Promise<Worker | null> {
  const result = await client.query<Worker>(
    `SELECT ${WORKER_COLUMNS} FROM workers WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function upsertWorker(
  client: PoolClient,
  worker: Omit<Worker, 'createdAt' | 'updatedAt'>,
): Promise<Worker> {
  const result = await client.query<Worker>(
    `INSERT INTO workers (id, tenant_id, email, full_name, keycloak_id)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       email       = EXCLUDED.email,
       full_name   = EXCLUDED.full_name,
       keycloak_id = EXCLUDED.keycloak_id,
       updated_at  = NOW()
     RETURNING ${WORKER_COLUMNS}`,
    [worker.id, worker.tenantId, worker.email, worker.fullName, worker.keycloakId],
  );
  // INSERT ... RETURNING always yields the upserted row
  return result.rows[0]!;
}

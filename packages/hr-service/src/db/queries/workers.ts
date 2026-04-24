import type { PoolClient } from 'pg';
import type { Worker } from '@cip/shared/src/types/worker.js';

export type { Worker };

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS wrapper

export async function findWorkerById(
  client: PoolClient,
  id: string,
): Promise<Worker | null> {
  const result = await client.query(
    'SELECT * FROM workers WHERE id = $1',
    [id],
  );
  return (result.rows[0] as Worker) ?? null;
}

export async function upsertWorker(
  client: PoolClient,
  worker: Omit<Worker, 'createdAt' | 'updatedAt'>,
): Promise<Worker> {
  void worker;
  throw new Error('not implemented');
}

import type { PoolClient } from 'pg';
import type { Certification } from '@cip/shared/src/types/certification.js';

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS wrapper

const CERT_COLUMNS = `
  id,
  tenant_id        AS "tenantId",
  worker_id        AS "workerId",
  cert_type        AS "certType",
  status,
  expires_at       AS "expiryDate",
  extracted_fields AS "extractedFields",
  confidence,
  object_store_key AS "objectStoreKey",
  prompt_version   AS "promptVersion",
  model_used       AS "modelUsed",
  created_at       AS "createdAt",
  updated_at       AS "updatedAt"
`;

export async function findCertificationById(
  client: PoolClient,
  id: string,
): Promise<Certification | null> {
  const result = await client.query<Certification>(
    `SELECT ${CERT_COLUMNS} FROM certifications WHERE id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function upsertCertification(
  client: PoolClient,
  cert: Omit<Certification, 'createdAt' | 'updatedAt'>,
): Promise<Certification> {
  const result = await client.query<Certification>(
    `INSERT INTO certifications (
       id, tenant_id, worker_id, cert_type, status,
       expires_at, extracted_fields, confidence,
       object_store_key, prompt_version, model_used
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       status           = EXCLUDED.status,
       expires_at       = EXCLUDED.expires_at,
       extracted_fields = EXCLUDED.extracted_fields,
       confidence       = EXCLUDED.confidence,
       prompt_version   = EXCLUDED.prompt_version,
       model_used       = EXCLUDED.model_used,
       updated_at       = NOW()
     RETURNING ${CERT_COLUMNS}`,
    [
      cert.id,
      cert.tenantId,
      cert.workerId,
      cert.certType,
      cert.status,
      cert.expiryDate ?? null,
      cert.extractedFields ? JSON.stringify(cert.extractedFields) : null,
      cert.confidence ?? null,
      cert.objectStoreKey,
      cert.promptVersion ?? null,
      cert.modelUsed ?? null,
    ],
  );
  // INSERT ... RETURNING always yields the upserted row
  return result.rows[0]!;
}

export async function findExpiredCertifications(
  client: PoolClient,
  beforeDate: string,
): Promise<Certification[]> {
  const result = await client.query<Certification>(
    `SELECT ${CERT_COLUMNS}
     FROM certifications
     WHERE status = 'validated' AND expires_at < $1::TIMESTAMPTZ
     ORDER BY expires_at ASC`,
    [beforeDate],
  );
  return result.rows;
}

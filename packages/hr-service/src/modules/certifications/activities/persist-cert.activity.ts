import { z } from 'zod';
import { createPool, withTenantRLS } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';
import { upsertCertification } from '../../../db/queries/certifications.js';
import { randomUUID } from 'node:crypto';

export interface PersistCertInput {
  tenantId:          string;
  submissionId:      string;
  extraction:        ExtractionResult;
  matchedEmployeeId: string | undefined;
  certDefId:         string | undefined;
}

export interface PersistCertOutput {
  certificationId: string;
}

const PersistCertOutputSchema = z.object({
  certificationId: z.string().uuid(),
});

let _pool: ReturnType<typeof createPool> | undefined;

function getPool() {
  if (!_pool) _pool = createPool(process.env['DATABASE_URL_HR']!);
  return _pool;
}

export async function persistCertActivity(
  input: PersistCertInput,
): Promise<PersistCertOutput> {
  const { tenantId, submissionId, extraction, matchedEmployeeId } = input;
  const pool = getPool();
  const client = await pool.connect();

  try {
    const cert = await withTenantRLS(client, tenantId, async (c) =>
      upsertCertification(c, {
        id:              randomUUID(),
        tenantId,
        workerId:        matchedEmployeeId ?? '',
        certType:        extraction.certType,
        status:          'validated',
        expiryDate:      (extraction.extractedFields['expiryDate'] as string | undefined) ?? null,
        extractedFields: extraction.extractedFields,
        confidence:      extraction.overallConfidence,
        objectStoreKey:  submissionId,
        promptVersion:   extraction.promptVersion,
        modelUsed:       extraction.modelUsed,
      }),
    );

    return PersistCertOutputSchema.parse({ certificationId: cert.id });
  } finally {
    client.release();
  }
}

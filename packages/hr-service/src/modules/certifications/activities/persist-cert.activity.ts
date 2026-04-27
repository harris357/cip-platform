import type { ExtractionResult } from '@cip/shared';

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

export async function persistCertActivity(
  input: PersistCertInput,
): Promise<PersistCertOutput> {
  void input;
  throw new Error('not implemented');
}

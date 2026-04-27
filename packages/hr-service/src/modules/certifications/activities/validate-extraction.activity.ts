import { ExtractionResultSchema } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';

export interface ValidateExtractionInput {
  tenantId: string;
  submissionId: string;
  extraction: ExtractionResult;
}

export async function validateExtractionActivity(
  input: ValidateExtractionInput,
): Promise<ExtractionResult> {
  void input.tenantId;
  void input.submissionId;
  return ExtractionResultSchema.parse(input.extraction);
}

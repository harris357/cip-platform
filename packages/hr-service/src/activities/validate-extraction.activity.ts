import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';

export interface ValidateExtractionInput {
  tenantId: string;
  extraction: ExtractionResult;
  certType: string;
}

export async function validateExtraction(input: ValidateExtractionInput): Promise<ExtractionResult> {
  // Zod validation — every Activity output must be validated before return
  const validated = ExtractionResultSchema.parse(input.extraction);
  void input.certType; // TODO: validate against cert type field schema
  void input.tenantId;
  return validated;
}

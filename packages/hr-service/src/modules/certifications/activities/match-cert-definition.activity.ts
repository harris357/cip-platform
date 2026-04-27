import type { ExtractionResult } from '@cip/shared';

export interface MatchCertDefinitionInput {
  tenantId:     string;
  submissionId: string;
  extraction:   ExtractionResult;
}

export interface MatchCertDefinitionOutput {
  certDefId:  string;
  confidence: number;
  method:     string;
}

export async function matchCertDefinition(
  input: MatchCertDefinitionInput,
): Promise<MatchCertDefinitionOutput> {
  void input;
  throw new Error('not implemented');
}

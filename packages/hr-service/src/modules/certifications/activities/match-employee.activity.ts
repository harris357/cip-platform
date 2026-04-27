import type { ExtractionResult } from '@cip/shared';

export interface MatchEmployeeInput {
  tenantId:     string;
  submissionId: string;
  extraction:   ExtractionResult;
}

export interface MatchEmployeeOutput {
  employeeId: string;
  confidence: number;
  method:     string;
}

export async function matchEmployee(
  input: MatchEmployeeInput,
): Promise<MatchEmployeeOutput> {
  void input;
  throw new Error('not implemented');
}

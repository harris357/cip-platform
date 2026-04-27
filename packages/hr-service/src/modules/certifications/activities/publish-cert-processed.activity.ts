export interface PublishCertProcessedInput {
  tenantId:        string;
  certificationId: string;
  employeeId:      string;
  submissionId:    string;
}

export async function publishCertProcessedActivity(
  input: PublishCertProcessedInput,
): Promise<void> {
  void input;
  throw new Error('not implemented');
}

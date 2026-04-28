import { z } from 'zod';
import { getNatsConnection, sc, Subjects } from '@cip/shared';

export interface PublishCertProcessedInput {
  tenantId:        string;
  certificationId: string;
  employeeId:      string;
  submissionId:    string;
}

const CertProcessedEventSchema = z.object({
  tenantId:    z.string(),
  certId:      z.string(),
  workerId:    z.string(),
  status:      z.string(),
  processedAt: z.string(),
});

export async function publishCertProcessedActivity(
  input: PublishCertProcessedInput,
): Promise<void> {
  const payload = CertProcessedEventSchema.parse({
    tenantId:    input.tenantId,
    certId:      input.certificationId,
    workerId:    input.employeeId,
    status:      'validated',
    processedAt: new Date().toISOString(),
  });

  const nc = await getNatsConnection();
  const subject = Subjects.certProcessed(input.tenantId);
  nc.publish(subject, sc.encode(JSON.stringify(payload)));
}

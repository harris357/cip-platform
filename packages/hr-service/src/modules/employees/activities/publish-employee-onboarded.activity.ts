import { z } from 'zod';
import { getNatsConnection, sc, Subjects } from '@cip/shared';

export interface PublishEmployeeOnboardedInput {
  tenantId:     string;
  employeeId:   string;
  identityType: string;
}

const EmployeeOnboardedEventSchema = z.object({
  tenantId:     z.string(),
  employeeId:   z.string(),
  identityType: z.string(),
  onboardedAt:  z.string(),
});

export async function publishEmployeeOnboardedActivity(
  input: PublishEmployeeOnboardedInput,
): Promise<void> {
  const payload = EmployeeOnboardedEventSchema.parse({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
    onboardedAt:  new Date().toISOString(),
  });

  const nc = await getNatsConnection();
  const js = nc.jetstream();
  await js.publish(
    Subjects.employeeOnboarded(input.tenantId),
    sc.encode(JSON.stringify(payload)),
  );
}

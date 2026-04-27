import { getNatsConnection, sc, Subjects } from '@cip/shared';
import type { EmployeeOnboardedEvent } from '@cip/shared';

export interface PublishEmployeeOnboardedInput {
  tenantId:     string;
  employeeId:   string;
  identityType: string;
}

export async function publishEmployeeOnboardedActivity(
  input: PublishEmployeeOnboardedInput,
): Promise<void> {
  const nc = await getNatsConnection();
  const js = nc.jetstream();
  const event: EmployeeOnboardedEvent = {
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
    onboardedAt:  new Date().toISOString(),
  };
  await js.publish(
    Subjects.employeeOnboarded(input.tenantId),
    sc.encode(JSON.stringify(event)),
  );
}

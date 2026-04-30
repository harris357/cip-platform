import { z } from 'zod';
import {
  getNatsConnection,
  getJetStream,
  sc,
  Subjects,
} from '@cip/shared';
import type { EmployeeIdentityChangedEvent } from '@cip/shared/src/types/events.js';

export interface SendIdentityChangedNotificationInput {
  tenantId:   string;
  employeeId: string;
  fromType:   'aad_federated' | 'field_employee';
  toType:     'aad_federated' | 'field_employee';
}

const EventSchema = z.object({
  tenantId:   z.string(),
  employeeId: z.string(),
  fromType:   z.string(),
  toType:     z.string(),
  changedAt:  z.string(),
});

export async function sendIdentityChangedNotificationActivity(
  input: SendIdentityChangedNotificationInput,
): Promise<void> {
  const event: EmployeeIdentityChangedEvent = EventSchema.parse({
    tenantId:   input.tenantId,
    employeeId: input.employeeId,
    fromType:   input.fromType,
    toType:     input.toType,
    changedAt:  new Date().toISOString(),
  });
  const nc = await getNatsConnection();
  const js = getJetStream(nc);
  await js.publish(
    Subjects.employeeIdentityChanged(input.tenantId),
    sc.encode(JSON.stringify(event)),
  );
}

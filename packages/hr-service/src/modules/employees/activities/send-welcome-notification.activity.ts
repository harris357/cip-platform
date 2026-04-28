import { z } from 'zod';
import { getNatsConnection, sc, Subjects } from '@cip/shared';

type IdentityType = 'aad_federated' | 'field_employee';

export interface SendWelcomeNotificationInput {
  tenantId:     string;
  employeeId:   string;
  identityType: IdentityType;
}

// Publish a NATS event on Subjects.workerOnboarded so any subscriber (e.g. teams-bot)
// can send a welcome message to the appropriate channel.
// Using NATS rather than a direct teams-bot POST so the notification survives a
// channel-registry miss and can be retried by any subscriber.
const WelcomeEventSchema = z.object({
  tenantId:    z.string(),
  employeeId:  z.string(),
  identityType: z.string(),
  sentAt:      z.string(),
});

export async function sendWelcomeNotificationActivity(
  input: SendWelcomeNotificationInput,
): Promise<void> {
  const payload = WelcomeEventSchema.parse({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.identityType,
    sentAt:       new Date().toISOString(),
  });

  const nc = await getNatsConnection();
  nc.publish(
    Subjects.workerOnboarded(input.tenantId),
    sc.encode(JSON.stringify(payload)),
  );
}

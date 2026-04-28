import { z } from 'zod';
import { getNatsConnection, sc, Subjects } from '@cip/shared';

const TenantProvisionedPayloadSchema = z.object({
  tenantId:       z.string().min(1),
  tenantName:     z.string().min(1),
  provisionedAt:  z.string().min(1),
});

export async function provisionCompleteNotify(input: {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  litellmVirtualKey: string;
}): Promise<void> {
  const payload = TenantProvisionedPayloadSchema.parse({
    tenantId:      input.tenantId,
    tenantName:    input.tenantName,
    provisionedAt: new Date().toISOString(),
  });

  const subject = Subjects.tenantProvisioned(input.tenantId);
  const nc = await getNatsConnection();
  nc.publish(subject, sc.encode(JSON.stringify(payload)));
}

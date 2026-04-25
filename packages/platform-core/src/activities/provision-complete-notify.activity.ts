import { getNatsConnection, sc } from '@cip/shared/src/clients/nats.js';
import { Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type { TenantProvisionedEvent } from '@cip/shared/src/types/events.js';

export async function provisionCompleteNotify(input: {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  litellmVirtualKey: string;
}): Promise<void> {
  const nc = await getNatsConnection();

  const event: TenantProvisionedEvent = {
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    provisionedAt: new Date().toISOString(),
  };

  // Publish via canonical subject builder — never raw strings
  nc.publish(Subjects.tenantProvisioned(input.tenantId), sc.encode(JSON.stringify(event)));

  // TODO: notify admin via email or Teams message — use input.adminEmail and input.litellmVirtualKey
}

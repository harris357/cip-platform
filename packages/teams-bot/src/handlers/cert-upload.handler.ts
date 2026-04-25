import { randomUUID } from 'node:crypto';
import type { TurnContext } from 'botbuilder';
import { getNatsConnection, sc } from '@cip/shared/src/clients/nats.js';
import { Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';
import type { CertUploadedEvent } from '@cip/shared/src/types/events.js';
import type { IntentResult } from '@cip/shared/src/types/agent.js';

export async function certUploadHandler(
  context: TurnContext,
  tenantCtx: TenantContext,
  intent: IntentResult,
): Promise<void> {
  const event: CertUploadedEvent = {
    tenantId: tenantCtx.tenantId,
    certId: randomUUID(),
    workerId: intent.entities['workerId'] ?? tenantCtx.userId,
    documentUrl: intent.entities['documentUrl'] ?? '',
    uploadedBy: tenantCtx.userId,
    uploadedAt: new Date().toISOString(),
  };

  const nc = await getNatsConnection();
  nc.publish(
    Subjects.certUploaded(tenantCtx.tenantId),
    sc.encode(JSON.stringify(event)),
  );

  await context.sendActivity(
    'Your certification document has been received and is being processed.',
  );
}

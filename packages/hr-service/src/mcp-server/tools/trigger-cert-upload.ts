import { getNatsConnection, sc } from '@cip/shared/src/clients/nats.js';
import { Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type { CertUploadedEvent } from '@cip/shared/src/types/events.js';
import { randomUUID } from 'crypto';

export interface TriggerCertUploadResult {
  certId: string;
  workflowId: string;
}

export async function triggerCertUploadHandler(
  workerId: string,
  documentUrl: string,
  certType: string,
  tenantId: string,
): Promise<TriggerCertUploadResult> {
  void certType;

  const certId = randomUUID();

  const event: CertUploadedEvent = {
    tenantId,
    certId,
    workerId,
    documentUrl,
    uploadedBy: tenantId,
    uploadedAt: new Date().toISOString(),
  };

  const nc = await getNatsConnection();
  nc.publish(Subjects.certUploaded(tenantId), sc.encode(JSON.stringify(event)));

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `CertProcess-${tenantId}-${certId}`;

  return { certId, workflowId };
}

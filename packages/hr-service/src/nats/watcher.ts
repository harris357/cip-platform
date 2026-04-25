import { createNatsClient, sc } from '@cip/shared/src/clients/nats.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { buildSubject, Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type { CertProcessedEvent, CertExpiredEvent } from '@cip/shared/src/types/events.js';

// WorkerOnboardedEvent not yet in @cip/shared — see CROSS-SLICE NOTE below
interface WorkerOnboardedEvent {
  tenantId: string;
  workerId: string;
  onboardedAt: string;
}

// Wildcard subjects — one watcher instance handles all tenants
// tenantId is read from the event payload, not the subject
const CERT_PROCESSED_SUBJECT = Subjects.certProcessed('*');
const CERT_EXPIRED_SUBJECT = Subjects.certExpired('*');
const WORKER_ONBOARDED_SUBJECT = buildSubject({ tenantId: '*', domain: 'worker', event: 'onboarded' });

export async function startAmbientWatcher(): Promise<void> {
  const nc = await createNatsClient();
  const js = nc.jetstream();

  async function watchCertProcessed(): Promise<void> {
    const sub = await js.subscribe(CERT_PROCESSED_SUBJECT, {});
    for await (const msg of sub) {
      const event = JSON.parse(sc.decode(msg.data)) as CertProcessedEvent;
      await handleCertProcessed(event);
      msg.ack();
    }
  }

  async function watchCertExpired(): Promise<void> {
    const sub = await js.subscribe(CERT_EXPIRED_SUBJECT, {});
    for await (const msg of sub) {
      const event = JSON.parse(sc.decode(msg.data)) as CertExpiredEvent;
      await handleCertExpired(event);
      msg.ack();
    }
  }

  async function watchWorkerOnboarded(): Promise<void> {
    const sub = await js.subscribe(WORKER_ONBOARDED_SUBJECT, {});
    for await (const msg of sub) {
      const event = JSON.parse(sc.decode(msg.data)) as WorkerOnboardedEvent;
      await handleWorkerOnboarded(event);
      msg.ack();
    }
  }

  await Promise.all([watchCertProcessed(), watchCertExpired(), watchWorkerOnboarded()]);
}

async function handleCertProcessed(event: CertProcessedEvent): Promise<void> {
  // TODO: query cert expiry date from DB; if within threshold, schedule reminder workflow
  console.log(`[watcher] cert.processed tenantId=${event.tenantId} certId=${event.certId} status=${event.status}`);
}

async function handleCertExpired(event: CertExpiredEvent): Promise<void> {
  const client = await createTemporalClient(`${event.tenantId}.cip`);
  // Workflow ID pattern: compliance-drift-{tenantId}-{certId}
  await client.workflow.start('ComplianceDriftCheckWorkflow', {
    taskQueue: 'cip-hr-tasks',
    workflowId: `compliance-drift-${event.tenantId}-${event.certId}`,
    args: [{ tenantId: event.tenantId, certId: event.certId, workerId: event.workerId }],
  });
}

async function handleWorkerOnboarded(event: WorkerOnboardedEvent): Promise<void> {
  // TODO: query required cert types for tenant + worker role; flag gaps
  console.log(`[watcher] worker.onboarded tenantId=${event.tenantId} workerId=${event.workerId}`);
}

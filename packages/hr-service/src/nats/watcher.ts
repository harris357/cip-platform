import { createNatsClient, sc } from '@cip/shared/src/clients/nats.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type { CertProcessedEvent, CertExpiredEvent, EmployeeOnboardedEvent } from '@cip/shared/src/types/events.js';

// Wildcard subjects — one watcher handles all tenants; tenantId is filtered per event payload.
const CERT_PROCESSED_SUBJECT = Subjects.certProcessed('*');
const CERT_EXPIRED_SUBJECT = Subjects.certExpired('*');
const EMPLOYEE_ONBOARDED_SUBJECT = Subjects.employeeOnboarded('*');

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

  async function watchEmployeeOnboarded(): Promise<void> {
    const sub = await js.subscribe(EMPLOYEE_ONBOARDED_SUBJECT, {});
    for await (const msg of sub) {
      const event = JSON.parse(sc.decode(msg.data)) as EmployeeOnboardedEvent;
      await handleEmployeeOnboarded(event);
      msg.ack();
    }
  }

  await Promise.all([watchCertProcessed(), watchCertExpired(), watchEmployeeOnboarded()]);
}

async function handleCertProcessed(event: CertProcessedEvent): Promise<void> {
  // TODO: query cert expiry date from DB; if < 90 days out, schedule reminder workflow
  console.log(`[watcher] cert.processed tenantId=${event.tenantId} certId=${event.certId} status=${event.status}`);
}

async function handleCertExpired(event: CertExpiredEvent): Promise<void> {
  const client = await createTemporalClient(`${event.tenantId}.cip`);
  // Workflow ID pattern: ComplianceDriftCheck-{tenantId}-{certId}
  await client.workflow.start('ComplianceDriftCheckWorkflow', {
    taskQueue: 'cip-hr-tasks',
    workflowId: `ComplianceDriftCheck-${event.tenantId}-${event.certId}`,
    args: [{ tenantId: event.tenantId, certId: event.certId, workerId: event.workerId }],
  });
}

async function handleEmployeeOnboarded(event: EmployeeOnboardedEvent): Promise<void> {
  // TODO: query required cert types for tenant + employee role; flag gaps
  console.log(`[watcher] employee.onboarded tenantId=${event.tenantId} employeeId=${event.employeeId}`);
}


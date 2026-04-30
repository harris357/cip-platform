import {
  createNatsClient,
  getJetStream,
  createJetStreamManager,
  AckPolicy,
  DeliverPolicy,
  type JetStreamManager,
} from '@cip/shared/src/clients/nats.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import { Subjects } from '@cip/shared/src/utils/subject-builder.js';
import type {
  CertProcessedEvent,
  CertExpiredEvent,
  EmployeeOnboardedEvent,
} from '@cip/shared/src/types/events.js';

// Wildcard subjects — one watcher handles all tenants; tenantId comes from each event payload.
const CERT_PROCESSED_SUBJECT = Subjects.certProcessed('*');
const CERT_EXPIRED_SUBJECT = Subjects.certExpired('*');
const EMPLOYEE_ONBOARDED_SUBJECT = Subjects.employeeOnboarded('*');

// (stream, consumer name, filter subject) — durable consumers, idempotent on creation.
// Consumer names are stable so messages aren't redelivered after pod restart.
const CONSUMERS = [
  { stream: 'CERTS',     name: 'hr-watcher-cert-processed',     filter: CERT_PROCESSED_SUBJECT,     label: 'cert.processed' },
  { stream: 'CERTS',     name: 'hr-watcher-cert-expired',       filter: CERT_EXPIRED_SUBJECT,       label: 'cert.expired' },
  { stream: 'HR_EVENTS', name: 'hr-watcher-employee-onboarded', filter: EMPLOYEE_ONBOARDED_SUBJECT, label: 'employee.onboarded' },
] as const;

async function ensureConsumer(
  jsm: JetStreamManager,
  stream: string,
  name: string,
  filterSubject: string,
): Promise<void> {
  const maxAttempts = 20;
  const delayMs = 5_000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await jsm.consumers.add(stream, {
        durable_name:    name,
        filter_subject:  filterSubject,
        ack_policy:      AckPolicy.Explicit,
        deliver_policy:  DeliverPolicy.New,
      });
      return;
    } catch (err) {
      const errMsg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      // Already exists (409 / "already in use") — idempotent success.
      if (errMsg.includes('already in use') || errMsg.includes('already exists')) {
        return;
      }
      // Stream missing — likely bootstrap hasn't run yet; retry.
      if (attempt < maxAttempts) {
        console.warn(`[watcher] consumer ${name} on ${stream}: attempt ${attempt}/${maxAttempts} failed: ${errMsg} — retrying in ${delayMs / 1000}s`);
        await new Promise((r) => setTimeout(r, delayMs));
      } else {
        throw new Error(`[watcher] consumer ${name} on ${stream}: failed after ${maxAttempts} attempts. Last error: ${errMsg}. Streams may not exist — run 'make bootstrap'.`);
      }
    }
  }
}

export async function startAmbientWatcher(): Promise<void> {
  const nc = await createNatsClient();
  const js = getJetStream(nc);
  const jsm = await createJetStreamManager(nc);

  // 1. Idempotently create durable consumers on each stream.
  for (const c of CONSUMERS) {
    await ensureConsumer(jsm, c.stream, c.name, c.filter);
  }

  // 2. Bind to each consumer and consume in parallel.
  async function watchCertProcessed(): Promise<void> {
    const consumer = await js.consumers.get('CERTS', 'hr-watcher-cert-processed');
    const messages = await consumer.consume();
    for await (const m of messages) {
      try {
        const event = m.json<CertProcessedEvent>();
        await handleCertProcessed(event);
        m.ack();
      } catch (err) {
        console.error('[watcher] cert.processed handler error:', err);
        m.nak();
      }
    }
  }

  async function watchCertExpired(): Promise<void> {
    const consumer = await js.consumers.get('CERTS', 'hr-watcher-cert-expired');
    const messages = await consumer.consume();
    for await (const m of messages) {
      try {
        const event = m.json<CertExpiredEvent>();
        await handleCertExpired(event);
        m.ack();
      } catch (err) {
        console.error('[watcher] cert.expired handler error:', err);
        m.nak();
      }
    }
  }

  async function watchEmployeeOnboarded(): Promise<void> {
    const consumer = await js.consumers.get('HR_EVENTS', 'hr-watcher-employee-onboarded');
    const messages = await consumer.consume();
    for await (const m of messages) {
      try {
        const event = m.json<EmployeeOnboardedEvent>();
        await handleEmployeeOnboarded(event);
        m.ack();
      } catch (err) {
        console.error('[watcher] employee.onboarded handler error:', err);
        m.nak();
      }
    }
  }

  console.log('[watcher] all consumers ready, starting message loops');
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

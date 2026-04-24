import { getNatsConnection, sc } from '@cip/shared/src/clients/nats.js';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { CertificationUploadedEvent, WorkerAllocatedToSiteEvent } from '@cip/shared/src/types/events.js';

/**
 * Ambient Watcher — two-speed design:
 *   Fast pass: Tier 1 deterministic check (threshold, expiry calc) — runs on every event
 *   Slow pass: Tier 3 agent (Compliance Assessment) — triggered only when fast pass flags
 *
 * Runs in the same process as the HR service in dev.
 * Extracted to its own container at production scale.
 */
export async function startAmbientWatcher(tenantId: string): Promise<void> {
  const nc = await getNatsConnection();

  // Subscribe to all events for this tenant
  const sub = nc.subscribe(`cip.${tenantId}.>`);

  console.log(`Ambient Watcher started for tenant: ${tenantId}`);

  for await (const msg of sub) {
    const subject = msg.subject;
    const data = JSON.parse(sc.decode(msg.data)) as unknown;

    if (subject.endsWith('.certificationUploaded')) {
      await handleCertUploaded(data as CertificationUploadedEvent);
    } else if (subject.endsWith('.workerAllocatedToSite')) {
      await handleWorkerAllocated(data as WorkerAllocatedToSiteEvent);
    } else if (subject.endsWith('.certificationExpired')) {
      // TODO: trigger renewal reminder workflow
    }
  }
}

async function handleCertUploaded(event: CertificationUploadedEvent): Promise<void> {
  // Fast pass: should we process this?
  const shouldProcess = true; // TODO: Tier 1 check against cert type registry

  if (shouldProcess) {
    const client = await createTemporalClient(
      `${event.tenantId}.cip`, // per-tenant Temporal namespace convention
    );

    // Workflow ID convention: cert-processing-{tenantId}-{certificationId}
    await client.workflow.start('CertificationProcessingWorkflow', {
      taskQueue: 'cip-hr-tasks',
      workflowId: `cert-processing-${event.tenantId}-${event.certificationId}`,
      args: [{
        tenantId: event.tenantId,
        workerId: event.workerId,
        certificationId: event.certificationId,
        objectStoreKey: event.objectStoreKey,
        uploadedBy: event.uploadedBy,
      }],
    });
  }
}

async function handleWorkerAllocated(event: WorkerAllocatedToSiteEvent): Promise<void> {
  void event;
  // TODO: Tier 1 fast compliance check
  // If gaps detected → trigger ComplianceAssessmentWorkflow
}

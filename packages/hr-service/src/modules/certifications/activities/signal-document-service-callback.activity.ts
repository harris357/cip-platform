// Slice 58E — cert → doc-service callback signal.
//
// When the cert workflow finishes (accepted or rejected), it tells
// doc-service so the doc transitions out of `routed` into `archived`
// (or `failed` on reject). Doc-service's workflow id is
// `DocumentProcess-${tenantId}-${documentId}`; we signal `moduleCallback`
// with `{moduleRecordId, status, reason?}`.
//
// Best-effort: a signal failure (doc-service down, signal bus glitch)
// is logged, NOT thrown. The cert flow has already persisted; we
// don't want to fail the cert workflow because of a notification
// glitch on the doc side. Future hardening: a NATS-backed retry queue.
//
// Output is Zod-parsed before return (Non-Negotiable #5).

import { z } from 'zod';

import { createTemporalClient } from '@cip/shared';

export const SignalDocumentServiceCallbackInputSchema = z.object({
  tenantId:       z.string().uuid(),
  documentId:     z.string().uuid(),
  moduleRecordId: z.string(),
  status:         z.enum(['accepted', 'rejected']),
  reason:         z.string().optional(),
});
export type SignalDocumentServiceCallbackInput = z.infer<typeof SignalDocumentServiceCallbackInputSchema>;

export const SignalDocumentServiceCallbackOutputSchema = z.object({
  signaled: z.boolean(),
});
export type SignalDocumentServiceCallbackOutput = z.infer<typeof SignalDocumentServiceCallbackOutputSchema>;

export async function signalDocumentServiceCallbackActivity(
  input: SignalDocumentServiceCallbackInput,
): Promise<SignalDocumentServiceCallbackOutput> {
  const validated = SignalDocumentServiceCallbackInputSchema.parse(input);

  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const docWorkflowId = `DocumentProcess-${validated.tenantId}-${validated.documentId}`;

  try {
    const client = await createTemporalClient();
    const handle = client.workflow.getHandle(docWorkflowId);
    await handle.signal('moduleCallback', {
      moduleRecordId: validated.moduleRecordId,
      status:         validated.status,
      ...(validated.reason !== undefined ? { reason: validated.reason } : {}),
    });
    return SignalDocumentServiceCallbackOutputSchema.parse({ signaled: true });
  } catch (err) {
    console.warn(
      `[signal-doc-callback] failed to signal ${docWorkflowId}: ` +
      `${err instanceof Error ? err.message : String(err)} — cert workflow continues`,
    );
    return SignalDocumentServiceCallbackOutputSchema.parse({ signaled: false });
  }
}

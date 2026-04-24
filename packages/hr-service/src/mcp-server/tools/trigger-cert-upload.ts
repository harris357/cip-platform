export async function triggerCertUploadHandler(
  workerId: string,
  objectStoreKey: string,
  tenantId: string,
): Promise<{ workflowId: string }> {
  void workerId;
  void objectStoreKey;
  void tenantId;
  // TODO: start CertificationProcessingWorkflow via Temporal client
  // Workflow ID: cert-processing-{tenantId}-{certificationId}
  throw new Error('triggerCertUploadHandler: not implemented');
}

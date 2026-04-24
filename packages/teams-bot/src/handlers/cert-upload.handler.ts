import type { TurnContext } from 'botbuilder';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';

export async function handleCertUpload(
  context: TurnContext,
  tenantContext: TenantContext,
): Promise<void> {
  void context;
  void tenantContext;
  // TODO: extract attachment, upload to OVH Object Store, publish CertificationUploadedEvent
  throw new Error('handleCertUpload: not implemented');
}

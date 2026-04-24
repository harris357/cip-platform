import type { TurnContext } from 'botbuilder';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';

export async function handleComplianceQuery(
  context: TurnContext,
  tenantContext: TenantContext,
): Promise<void> {
  void context;
  void tenantContext;
  // TODO: call get_compliance_status MCP tool and format response card
  throw new Error('handleComplianceQuery: not implemented');
}

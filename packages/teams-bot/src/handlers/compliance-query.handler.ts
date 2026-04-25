import type { TurnContext } from 'botbuilder';
import type { TenantContext } from '@cip/shared/src/types/tenant.js';
import type { IntentResult } from '@cip/shared/src/types/agent.js';

export async function complianceQueryHandler(
  context: TurnContext,
  tenantCtx: TenantContext,
  intent: IntentResult,
): Promise<void> {
  void context;
  void tenantCtx;
  void intent;
  throw new Error('not implemented');
}

import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';

const {
  createKeycloakRealm,
  createTemporalNamespace,
  createNatsStreams,
  createObjectStoreBuckets,
  initTenantDatabase,
  issueLiteLLMVirtualKey,
  provisionCompleteNotify,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

export async function TenantProvisioningWorkflow(
  input: TenantProvisioningInput,
): Promise<void> {
  await createKeycloakRealm({ tenantId: input.tenantId, tenantName: input.tenantName });
  await createTemporalNamespace({ tenantId: input.tenantId });
  await createNatsStreams({ tenantId: input.tenantId });
  await createObjectStoreBuckets({ tenantId: input.tenantId });
  await initTenantDatabase({ tenantId: input.tenantId });

  const litellmVirtualKey = await issueLiteLLMVirtualKey({
    tenantId: input.tenantId,
    tier: input.tier,
    budgetLimitUsd: input.budgetLimitUsd,
  });

  await provisionCompleteNotify({
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    adminEmail: input.adminEmail,
    litellmVirtualKey,
  });
}

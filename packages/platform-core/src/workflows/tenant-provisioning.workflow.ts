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
  persistLiteLLMVirtualKey,
  elevateAdminUser,
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

  // Slice 70: persist the vkey into tenant_settings so services that read
  // it at request time see it without a manual operator step.
  await persistLiteLLMVirtualKey({
    tenantId: input.tenantId,
    litellmVirtualKey,
  });

  // Slice 70: admin user DB-side elevation. Non-fatal — first-sync auto
  // -elevation (sync_employee, slice 66) covers the failure mode if the
  // admin signs in before operators retry. KC realm role grant (the other
  // half of bash 7a) lands in slice 71.
  try {
    await elevateAdminUser({
      tenantId:   input.tenantId,
      adminEmail: input.adminEmail,
    });
  } catch (err) {
    console.warn(
      `[TenantProvisioningWorkflow] elevateAdminUser failed; bot first-sync will retry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  await provisionCompleteNotify({
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    adminEmail: input.adminEmail,
    litellmVirtualKey,
  });
}

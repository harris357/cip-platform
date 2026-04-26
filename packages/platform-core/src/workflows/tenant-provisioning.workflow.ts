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

/**
 * TenantProvisioningWorkflow
 *
 * This is the ONLY way to onboard a new tenant. Never provision tenants manually.
 * Each activity is idempotent — safe to retry from any step.
 *
 * Workflow ID convention: tenant-provisioning-{tenantId}
 */
export async function TenantProvisioningWorkflow(
  input: TenantProvisioningInput,
): Promise<void> {
  // Step 1: Create Keycloak realm for tenant
  await createKeycloakRealm({ tenantId: input.tenantId, tenantName: input.tenantName });

  // Step 2: Create Temporal namespace for tenant
  await createTemporalNamespace({ tenantId: input.tenantId });

  // Step 3: Create NATS JetStream streams scoped to cip.{tenantId}.*
  await createNatsStreams({ tenantId: input.tenantId });

  // Step 4: Create OVH Object Store buckets for tenant
  await createObjectStoreBuckets({ tenantId: input.tenantId });

  // Step 5: Issue LiteLLM virtual key with tier-appropriate budget
  const litellmVirtualKey = await issueLiteLLMVirtualKey({
    tenantId: input.tenantId,
    tier: input.tier,
    budgetLimitUsd: input.budgetLimitUsd,
  });

  // Step 6: Initialise tenant schema in PostgreSQL (run migrations) and store virtual key
  await initTenantDatabase({ tenantId: input.tenantId, litellmVirtualKey });

  // Step 7: Publish tenantProvisioned NATS event + notify admin
  await provisionCompleteNotify({
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    adminEmail: input.adminEmail,
    litellmVirtualKey,
  });
}

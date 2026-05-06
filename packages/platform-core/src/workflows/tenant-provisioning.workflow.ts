import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';

const {
  createKeycloakRealm,
  createTemporalNamespace,
  createNatsStreams,
  createObjectStoreBuckets,
  initTenantDatabase,
  createKeycloakClients,
  createK8sSecret,
  updateTenantIdpSecretRef,
  createAadIdpFederation,
  issueLiteLLMVirtualKey,
  persistLiteLLMVirtualKey,
  elevateAdminUser,
  grantKcAdminRealmRole,
  provisionCompleteNotify,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

export async function TenantProvisioningWorkflow(
  input: TenantProvisioningInput,
): Promise<void> {
  // ── Foundation ──────────────────────────────────────────────────────
  await createKeycloakRealm({ tenantId: input.tenantId, tenantName: input.tenantName });
  await createTemporalNamespace({ tenantId: input.tenantId });
  await createNatsStreams({ tenantId: input.tenantId });
  await createObjectStoreBuckets({ tenantId: input.tenantId });
  await initTenantDatabase({ tenantId: input.tenantId });

  // ── KC clients + per-tenant K8s secret ──────────────────────────────
  const clients = await createKeycloakClients({ tenantId: input.tenantId });
  const k8sSecret = await createK8sSecret({
    tenantId: input.tenantId,
    data: { KEYCLOAK_CLIENT_SECRET: clients.teamsBotSecret },
  });
  await updateTenantIdpSecretRef({
    tenantId:  input.tenantId,
    alias:     'aad',
    secretRef: k8sSecret.name,
  });

  // ── AAD federation (conditional) ────────────────────────────────────
  if (input.aadTenantId) {
    const aadResult = await createAadIdpFederation({
      tenantId:    input.tenantId,
      aadTenantId: input.aadTenantId,
      alias:       'aad',
    });
    if (!aadResult.configured) {
      console.warn(`[TenantProvisioningWorkflow] AAD federation not configured: ${aadResult.reason}`);
    }
  }

  // ── LiteLLM ─────────────────────────────────────────────────────────
  const litellmVirtualKey = await issueLiteLLMVirtualKey({
    tenantId: input.tenantId,
    tier: input.tier,
    budgetLimitUsd: input.budgetLimitUsd,
  });
  await persistLiteLLMVirtualKey({
    tenantId: input.tenantId,
    litellmVirtualKey,
  });

  // ── Admin elevation (DB + KC) ──────────────────────────────────────
  // DB-side: non-fatal, bot first-sync auto-elevation covers failure.
  try {
    await elevateAdminUser({ tenantId: input.tenantId, adminEmail: input.adminEmail });
  } catch (err) {
    console.warn(
      `[TenantProvisioningWorkflow] elevateAdminUser failed; bot first-sync will retry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // KC-side: non-fatal — admin's first sign-in creates their KC user; this
  // grants the realm role if they already exist, no-ops cleanly otherwise.
  const kcGrant = await grantKcAdminRealmRole({
    tenantId:   input.tenantId,
    adminEmail: input.adminEmail,
  });
  if (!kcGrant.granted) {
    console.warn(`[TenantProvisioningWorkflow] grantKcAdminRealmRole skipped: ${kcGrant.reason}`);
  }

  // ── Notify ──────────────────────────────────────────────────────────
  await provisionCompleteNotify({
    tenantId: input.tenantId,
    tenantName: input.tenantName,
    adminEmail: input.adminEmail,
    litellmVirtualKey,
  });
}

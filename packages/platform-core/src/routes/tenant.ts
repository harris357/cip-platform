import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import {
  TenantTierSchema,
  IdentityProviderTypeSchema,
} from '@cip/shared/src/types/tenant.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';
import { createTenantWithProviders } from '../services/tenant-provisioning.js';

export const tenantRouter: IRouter = Router();

// Slice 63: rewritten.
//   - Field renamed: tenantName → displayName (consistency with admin route +
//     shared zod schemas).
//   - hr-service HTTP detour removed; uses createTenantWithProviders directly.
//   - Output contract preserved: { tenantId, workflowId } with 202.
//   - Backwards-compatibility for the simplest caller: a top-level aadTenantId
//     synthesizes the AAD IDP, same as before.
const CreateTenantBodySchema = z.object({
  displayName:        z.string().min(1),
  adminEmail:         z.string().email(),
  tier:               TenantTierSchema.optional(),
  budgetLimitUsd:     z.number().optional(),
  aadTenantId:        z.string().optional(),
  identityProviders:  z.array(z.object({
    providerType: IdentityProviderTypeSchema,
    alias:        z.string().min(1),
    config:       z.record(z.unknown()).default({}),
    secretRef:    z.string().optional(),
    enabled:      z.boolean().optional(),
  })).optional(),
});

tenantRouter.post('/tenants', async (req, res) => {
  const parse = CreateTenantBodySchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'validation', issues: parse.error.issues });
    return;
  }
  const body = parse.data;

  // Synthesize AAD IDP from the shorthand if explicit identityProviders
  // wasn't provided. Either form works; pick whichever is more convenient
  // for the caller. Drop undefined fields so they satisfy
  // exactOptionalPropertyTypes when handed to the service.
  const identityProviders =
    body.identityProviders && body.identityProviders.length > 0
      ? body.identityProviders.map(idp => ({
          providerType: idp.providerType,
          alias:        idp.alias,
          config:       idp.config,
          ...(idp.secretRef !== undefined ? { secretRef: idp.secretRef } : {}),
          ...(idp.enabled   !== undefined ? { enabled:   idp.enabled }   : {}),
        }))
      : (body.aadTenantId
          ? [{
              providerType: 'aad_oidc' as const,
              alias:        'aad',
              config:       { aad_tenant_id: body.aadTenantId },
            }]
          : []);

  let tenantId: string;
  try {
    const result = await createTenantWithProviders({
      displayName:       body.displayName,
      adminEmail:        body.adminEmail,
      ...(body.tier !== undefined ? { tier: body.tier } : {}),
      identityProviders,
    });
    tenantId = result.tenant.id;
  } catch (err) {
    console.error('[platform-core] tenant insert failed:', err);
    res.status(500).json({ error: 'tenant_create_failed' });
    return;
  }

  // Start the provisioning workflow with the persisted UUID. Note: the
  // workflow input's tier enum predates TenantTierSchema and uses
  // 'standard' | 'enterprise' | 'premium' (legacy); the zod schema uses
  // 'standard' | 'enterprise' | 'trial'. Cast at the boundary; aligning
  // the two enums is a separate cleanup.
  const args: TenantProvisioningInput = {
    tenantId,
    tenantName:     body.displayName,
    adminEmail:     body.adminEmail,
    tier:           (body.tier ?? 'standard') as TenantProvisioningInput['tier'],
    budgetLimitUsd: body.budgetLimitUsd ?? 100,
    ...(body.aadTenantId ? { aadTenantId: body.aadTenantId } : {}),
  };

  try {
    const client = await createTemporalClient();
    const handle = await client.workflow.start('TenantProvisioningWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] ?? 'cip-platform-tasks',
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      workflowId: `TenantProvision-${tenantId}-${tenantId}`,
      args: [args],
    });
    res.status(202).json({ tenantId, workflowId: handle.workflowId });
  } catch (err) {
    console.error('[platform-core] failed to start workflow after tenant insert:', err);
    res.status(500).json({ error: 'workflow_start_failed', tenantId });
  }
});

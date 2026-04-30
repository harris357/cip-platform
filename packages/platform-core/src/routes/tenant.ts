import { Router, type IRouter } from 'express';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';

export const tenantRouter: IRouter = Router();

interface CreateTenantBody {
  tenantName:      string;
  adminEmail:      string;
  tier?:           TenantProvisioningInput['tier'];
  budgetLimitUsd?: number;
  aadTenantId?:    string;
}

interface HrServiceTenantCreateResp {
  tenant: { id: string };
}

tenantRouter.post('/tenants', async (req, res) => {
  const body = req.body as CreateTenantBody;

  // 1. Insert canonical tenant row + IDP rows via hr-service. The returned
  //    UUID is the source of truth for the rest of provisioning.
  const hrUrl        = process.env['HR_SERVICE_URL']        ?? 'http://hr-service.cip-app.svc.cluster.local:3000';
  const hrAdminToken = process.env['PLATFORM_ADMIN_TOKEN']  ?? '';
  if (!hrAdminToken) {
    res.status(500).json({ error: 'platform_admin_token_unset' });
    return;
  }

  const createBody = {
    displayName: body.tenantName,
    adminEmail:  body.adminEmail,
    tier:        body.tier ?? 'standard',
    identityProviders: body.aadTenantId
      ? [{
          providerType: 'aad_oidc' as const,
          alias:        'aad',
          config:       { aad_tenant_id: body.aadTenantId },
        }]
      : [],
  };

  const createResp = await fetch(`${hrUrl}/admin/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type':            'application/json',
      'X-Platform-Admin-Token':  hrAdminToken,
    },
    body: JSON.stringify(createBody),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    res.status(createResp.status).json({ error: 'tenant_create_failed', detail: text });
    return;
  }
  const { tenant } = (await createResp.json()) as HrServiceTenantCreateResp;

  // 2. Start the provisioning workflow with the persisted UUID.
  const args: TenantProvisioningInput = {
    tenantId:       tenant.id,
    tenantName:     body.tenantName,
    adminEmail:     body.adminEmail,
    tier:           body.tier ?? 'standard',
    budgetLimitUsd: body.budgetLimitUsd ?? 100,
  };

  try {
    const client = await createTemporalClient();
    const handle = await client.workflow.start('TenantProvisioningWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] ?? 'cip-platform-tasks',
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      workflowId: `TenantProvision-${tenant.id}-${tenant.id}`,
      args: [args],
    });
    res.status(202).json({ tenantId: tenant.id, workflowId: handle.workflowId });
  } catch (err) {
    console.error('[platform-core] failed to start workflow after tenant insert:', err);
    res.status(500).json({ error: 'Failed to start provisioning workflow', tenantId: tenant.id });
  }
});

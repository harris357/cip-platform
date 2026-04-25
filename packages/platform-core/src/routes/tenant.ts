import { randomUUID } from 'crypto';
import { Router, type IRouter } from 'express';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';

export const tenantRouter: IRouter = Router();

tenantRouter.post('/tenants', async (req, res) => {
  const tenantId = randomUUID();
  const body = req.body as { tenantName: string; adminEmail: string; tier?: TenantProvisioningInput['tier']; budgetLimitUsd?: number };

  const args: TenantProvisioningInput = {
    tenantId,
    tenantName: body.tenantName,
    adminEmail: body.adminEmail,
    tier: body.tier ?? 'standard',
    budgetLimitUsd: body.budgetLimitUsd ?? 100,
  };

  try {
    const client = await createTemporalClient();
    const handle = await client.workflow.start('TenantProvisioningWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE'] ?? 'cip-platform-tasks',
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      workflowId: `TenantProvision-${tenantId}-${tenantId}`,
      args: [args],
    });
    res.status(202).json({ tenantId, workflowId: handle.workflowId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start provisioning workflow' });
  }
});

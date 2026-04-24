import { Router, type IRouter } from 'express';
import { createTemporalClient } from '@cip/shared/src/clients/temporal.js';
import type { TenantProvisioningInput } from '@cip/shared/src/types/workflow.js';

export const tenantRouter: IRouter = Router();

tenantRouter.post('/tenants', async (req, res) => {
  const input = req.body as TenantProvisioningInput;

  // Workflow ID convention: tenant-provisioning-{tenantId}
  const workflowId = `tenant-provisioning-${input.tenantId}`;

  try {
    const client = await createTemporalClient();
    await client.workflow.start('TenantProvisioningWorkflow', {
      taskQueue: 'cip-platform-tasks',
      workflowId,
      args: [input],
    });
    res.status(202).json({ workflowId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start provisioning workflow' });
  }
});

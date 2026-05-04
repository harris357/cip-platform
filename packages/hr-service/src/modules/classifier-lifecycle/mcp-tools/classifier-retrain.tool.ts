// Slice 56N: MCP tools to drive the RetrainModelWorkflow.
//
// Two tools:
//   - bot_classifier_retrain   — start a new RetrainModelWorkflow run
//   - bot_classifier_approve   — send the adminApprovalSignal to a
//                                  running workflow waiting for review
//
// Both gated on bot.metrics.read (same admin gate as /turn / /teach).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createTemporalClient } from '@cip/shared';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';
import {
  RetrainModelWorkflow,
  adminApprovalSignal,
  type RetrainModelWorkflowOutput,
} from '../workflows/retrain-model.workflow.js';

const REQUIRED = 'bot.metrics.read';

async function gate(
  authInfo: unknown,
): Promise<{ tenantId: string; employeeId: string } | { refusal: ReturnType<typeof refused> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = extractAuthContext(authInfo as any);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assertPermission(authInfo as any, REQUIRED);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return { refusal: refused('permission_denied', err.message) };
    }
    throw err;
  }
  return { tenantId: ctx.tenantId, employeeId: ctx.employeeId };
}

// ── bot_classifier_retrain ───────────────────────────────────────────

export function registerBotClassifierRetrain(server: McpServer): void {
  server.tool(
    'bot_classifier_retrain',
    'Start a RetrainModelWorkflow (slice 56N). The workflow imports new ' +
    'traces, waits for admin approval, runs the trainer + eval gate, and ' +
    'promotes a new artifact to S3 if the gate passes. ' +
    'Scope: caller\'s own tenant (per_tenant=true) OR platform-wide. ' +
    'Audience: HR admins (gated on bot.metrics.read). ' +
    'Returns the workflow id; use it to track progress in the Temporal Web UI ' +
    'or to send the approval signal via bot_classifier_approve.',
    {
      scope: z.enum(['platform', 'tenant']).default('tenant').describe(
        'platform = train the platform-wide model (tenant_id=NULL on the run); ' +
        'tenant = train a per-tenant model (requires CLASSIFIER_PER_TENANT_ENABLED).',
      ),
      skip_import_and_review: z.boolean().default(false).describe(
        'When true, skip the import-traces + admin-review steps. Useful for ' +
        '"just retrain on whatever\'s already approved" runs.',
      ),
      admin_review_timeout_hours: z.number().int().min(1).max(720).default(24 * 30).describe(
        'Hard deadline on the admin-review step before the workflow fails closed.',
      ),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'write',
      whenToUse: [
        'Operator wants to trigger an out-of-cycle retrain (replaces ' +
        '`make classifier-retrain-now`)',
        'After bulk-curating training rows, kick off the next train without ' +
        'waiting for the cron.',
      ],
      whenNotToUse: ['Cron-driven retrain — that runs automatically'],
      commonNextTools: ['bot_classifier_approve', 'bot_metrics_get_turn'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async (args, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;

      const tenantId = args.scope === 'tenant' ? g.tenantId : null;
      const triggerId = `manual-${Date.now().toString(36)}`;
      const workflowId = `RetrainModel-${tenantId ?? 'platform'}-${triggerId}`;

      const client = await createTemporalClient();
      const handle = await client.workflow.start(RetrainModelWorkflow, {
        workflowId,
        taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
        args: [{
          tenantId,
          triggerId,
          skipImportAndReview:    args.skip_import_and_review,
          adminReviewTimeoutHours: args.admin_review_timeout_hours,
        }],
      });

      return ok({
        workflowId: handle.workflowId,
        scope:      tenantId ?? 'platform',
        triggerId,
      }, `Workflow started: \`${handle.workflowId}\`. Send approval with bot_classifier_approve when ready.`);
    },
  );
}

// ── bot_classifier_approve ───────────────────────────────────────────

export function registerBotClassifierApprove(server: McpServer): void {
  server.tool(
    'bot_classifier_approve',
    'Send the adminApprovalSignal to a RetrainModelWorkflow that\'s waiting ' +
    'for review. The workflow resumes from its admin-review step, exports ' +
    'the (now-curated) corpus, and runs train + eval. ' +
    'Scope: caller\'s own tenant (signaling a workflow they triggered). ' +
    'Audience: HR admins (gated on bot.metrics.read). ' +
    'No-op if the workflow id doesn\'t exist or is no longer waiting.',
    {
      workflow_id: z.string().min(1).max(200),
      approved_row_ids: z.array(z.string().uuid()).default([]).describe(
        'Optional list of bot_intent_training_data ids to mark reviewed=true ' +
        'as part of the signal. v1: empty array means "I have already marked ' +
        'rows reviewed via make training-data-mark-reviewed; just resume."',
      ),
      note: z.string().max(500).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'write',
      whenToUse: [
        'After reviewing pending rows in `make training-data-review`, send the ' +
        'signal to resume a paused RetrainModelWorkflow.',
      ],
      whenNotToUse: ['Workflow is not in awaiting-admin-review state — signals are ignored'],
      commonNextTools: [],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async (args, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;

      try {
        const client = await createTemporalClient();
        const handle = client.workflow.getHandle(args.workflow_id);
        await handle.signal(adminApprovalSignal, {
          approvedRowIds: args.approved_row_ids,
          ...(args.note ? { note: args.note } : {}),
        });
        return ok({
          workflowId: args.workflow_id,
          signalSent: true,
        }, `Signal sent to \`${args.workflow_id}\`. Watch progress in Temporal Web UI.`);
      } catch (err) {
        return refused(
          'workflow_signal_failed',
          err instanceof Error ? err.message : String(err),
        );
      }
    },
  );
}

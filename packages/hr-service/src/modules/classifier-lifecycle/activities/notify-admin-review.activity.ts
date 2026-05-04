// Slice 56N activity: notify admin that the workflow is waiting for
// approval. v1 just logs; later versions can send a Teams message,
// post to Slack, or fire an email — the activity boundary lets us swap
// the notification channel without touching the workflow.
//
// The admin signals approval via the `bot_classifier_approve` MCP tool
// (or directly via temporal-cli for power users) carrying the workflow
// id rendered here.

import { z } from 'zod';

const NotifyAdminReviewInput = z.object({
  tenantId:   z.string().uuid().nullable(),
  unreviewed: z.number().int().nonnegative(),
  workflowId: z.string(),
});

const NotifyAdminReviewOutput = z.object({
  notified: z.boolean(),
});

export async function notifyAdminReviewPendingActivity(
  input: z.input<typeof NotifyAdminReviewInput>,
): Promise<z.infer<typeof NotifyAdminReviewOutput>> {
  const args = NotifyAdminReviewInput.parse(input);
  const scope = args.tenantId ?? 'platform';
  // v1: pod log + Temporal UI activity record. v2: Teams message via
  // the bot's adaptive-card mechanism. Both happen on this activity's
  // run boundary, so swapping is a no-touch-workflow change.
  console.log(
    `[retrain-workflow] AWAITING ADMIN REVIEW scope=${scope} ` +
    `unreviewed=${args.unreviewed} workflowId=${args.workflowId}\n` +
    `  Send approval signal with:\n` +
    `    temporal workflow signal --workflow-id "${args.workflowId}" \\\n` +
    `      --name adminApproval --input '{"approvedRowIds": [], "note": "..."}'\n` +
    `  Or use the bot_classifier_approve MCP tool.`,
  );
  return NotifyAdminReviewOutput.parse({ notified: true });
}

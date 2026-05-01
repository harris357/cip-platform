import { activityInfo } from '@temporalio/activity';
import { ExtractionResultSchema } from '@cip/shared';
import type { ExtractionResult } from '@cip/shared';
import { runVisionAgent } from '../agents/vision-agent/index.js';

export interface RunVisionAgentInput {
  tenantId: string;
  submissionId: string;
  employeeId: string;
  documentBase64: string;
  certTypeHint: string;
}

export async function runVisionAgentActivity(
  input: RunVisionAgentInput,
): Promise<ExtractionResult> {
  const info = activityInfo();
  // Temporal SDK 1.17 typed workflowExecution as optional; in practice an
  // activity always runs inside a workflow, so missing it is a runtime bug.
  if (!info.workflowExecution) {
    throw new Error('runVisionAgentActivity: missing workflowExecution context');
  }

  const raw = await runVisionAgent({
    tenantId:        input.tenantId,
    workerId:        input.employeeId,
    certificationId: input.submissionId,
    documentBase64:  input.documentBase64,
    certType:        input.certTypeHint,
    workflowId:      info.workflowExecution.workflowId,
    activityId:      info.activityId,
  });

  return ExtractionResultSchema.parse(raw);
}

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

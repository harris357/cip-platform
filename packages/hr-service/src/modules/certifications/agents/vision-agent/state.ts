import { Annotation } from '@langchain/langgraph';
import type { ExtractionResult } from '@cip/shared';

export const VisionAgentAnnotation = Annotation.Root({
  tenantId:       Annotation<string>(),
  submissionId:   Annotation<string>(),
  employeeId:     Annotation<string>(),
  certType:       Annotation<string>(),
  objectStoreKey: Annotation<string>(),
  documentBase64: Annotation<string | undefined>(),
  extraction:     Annotation<ExtractionResult | undefined>(),
  requiresHitl:   Annotation<boolean>({ value: (_: boolean, next: boolean) => next, default: () => false }),
  userId:         Annotation<string>(),
  workflowId:     Annotation<string | undefined>(),
  model:          Annotation<string | undefined>(),
});

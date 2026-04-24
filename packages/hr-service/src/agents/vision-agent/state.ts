import { Annotation } from '@langchain/langgraph';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';

export const VisionAgentAnnotation = Annotation.Root({
  tenantId: Annotation<string>(),
  certId: Annotation<string>(),
  documentUrl: Annotation<string>(),
  documentBase64: Annotation<string | undefined>(),
  extraction: Annotation<ExtractionResult | undefined>(),
  requiresHitl: Annotation<boolean>({ default: () => false, reducer: (_: boolean, b: boolean) => b }),
  runId: Annotation<string>(),
  startedAt: Annotation<string>(),
  error: Annotation<string | undefined>(),
});

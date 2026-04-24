import { StateGraph, END, START } from '@langchain/langgraph';
import { CallbackHandler } from '@langfuse/langchain';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { VisionAgentAnnotation } from './state.js';
import { extractFields, assessConfidence, formatOutput, flagForHitl } from './nodes.js';

function routeAfterAssessment(
  state: typeof VisionAgentAnnotation.State,
): 'formatOutput' | 'flagForHitl' {
  return state.requiresHitl ? 'flagForHitl' : 'formatOutput';
}

export async function runVisionAgent(input: {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
  activityId: string;
}): Promise<ExtractionResult> {
  // tenantId and workflowId are mandatory trace metadata for per-tenant cost attribution
  const langfuseHandler = new CallbackHandler({
    tags: [input.tenantId, 'vision-agent', input.certType],
    traceMetadata: {
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      activityId: input.activityId,
      certType: input.certType,
    },
  });

  const graph = new StateGraph(VisionAgentAnnotation)
    .addNode('extractFields', extractFields)
    .addNode('assessConfidence', assessConfidence)
    .addNode('formatOutput', formatOutput)
    .addNode('flagForHitl', flagForHitl)
    .addEdge(START, 'extractFields')
    .addEdge('extractFields', 'assessConfidence')
    .addConditionalEdges('assessConfidence', routeAfterAssessment)
    .addEdge('formatOutput', END)
    .addEdge('flagForHitl', END)
    .compile();

  const initialState: typeof VisionAgentAnnotation.State = {
    tenantId: input.tenantId,
    certId: input.certificationId,
    documentUrl: '',
    documentBase64: input.documentBase64,
    extraction: undefined,
    requiresHitl: false,
    runId: input.activityId,
    startedAt: new Date().toISOString(),
    error: undefined,
  };

  const result = await graph.invoke(initialState, { callbacks: [langfuseHandler] });

  if (!result.extraction) {
    throw new Error('runVisionAgent: graph completed without extraction result');
  }

  return ExtractionResultSchema.parse(result.extraction);
}

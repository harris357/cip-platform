import { StateGraph, END, START } from '@langchain/langgraph';
import { CallbackHandler } from '@langfuse/langchain';
import { createLiteLLMClient } from '@cip/shared/src/clients/litellm.js';
import { ExtractionResultSchema } from '@cip/shared/src/types/agent.js';
import type { ExtractionResult } from '@cip/shared/src/types/agent.js';
import { extractionNode } from './nodes.js';
import type { VisionAgentState } from './state.js';

/**
 * Vision Agent — Tier 3 LangGraph agent.
 * Invoked from RunVisionAgentActivity (Temporal Activity).
 * All LLM calls go through LiteLLM (cip-vision alias).
 * Every run is traced in Langfuse with tenantId and workflowId tagged.
 * @langfuse/langchain v5 uses OTel — traceMetadata carries mandatory tenant attribution.
 */
export async function runVisionAgent(input: {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
  activityId: string;
}): Promise<ExtractionResult> {
  // tenantId and workflowId are MANDATORY trace metadata for per-tenant cost attribution
  const langfuseHandler = new CallbackHandler({
    tags: [input.tenantId, 'vision-agent', input.certType],
    traceMetadata: {
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      activityId: input.activityId,
      certType: input.certType,
    },
  });

  const model = createLiteLLMClient({ tenantId: input.tenantId, virtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? '' });

  const initialState: VisionAgentState = {
    tenantId: input.tenantId,
    userId: '',
    workflowId: input.workflowId,
    activityId: input.activityId,
    model: 'cip-vision',
    messages: [],
    documentBase64: input.documentBase64,
    certType: input.certType,
    extractedFields: {},
    confidence: 0,
    requiresHITL: false,
  };

  void langfuseHandler;
  void extractionNode;
  void START;
  void END;

  // Build and compile the graph
  // TODO: add nodes and edges once extractionNode is implemented
  // const graph = new StateGraph<VisionAgentState>({ channels: {} as any })
  //   .addNode('extract', extractionNode(model))
  //   .addEdge(START, 'extract')
  //   .addEdge('extract', END)
  //   .compile();
  // const result = await graph.invoke(initialState, { callbacks: [langfuseHandler] });
  // return ExtractionResultSchema.parse(result);

  void model;
  void initialState;
  void StateGraph;
  void ExtractionResultSchema;

  throw new Error('runVisionAgent: not yet implemented — add graph nodes in nodes.ts');
}

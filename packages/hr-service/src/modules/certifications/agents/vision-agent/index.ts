import { StateGraph, START, END } from '@langchain/langgraph';
import type { ExtractionResult } from '@cip/shared';
import { VisionAgentAnnotation } from './state.js';
import { extractFields, assessConfidence, formatOutput, flagForHitl } from './nodes.js';

export interface RunVisionAgentInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
  activityId: string;
}

function routeAfterConfidence(state: typeof VisionAgentAnnotation.State): 'formatOutput' | 'flagForHitl' {
  return state.requiresHitl ? 'flagForHitl' : 'formatOutput';
}

const graph = new StateGraph(VisionAgentAnnotation)
  .addNode('extractFields', extractFields)
  .addNode('assessConfidence', assessConfidence)
  .addNode('formatOutput', formatOutput)
  .addNode('flagForHitl', flagForHitl)
  .addEdge(START, 'extractFields')
  .addEdge('extractFields', 'assessConfidence')
  .addConditionalEdges('assessConfidence', routeAfterConfidence)
  .addEdge('formatOutput', END)
  .addEdge('flagForHitl', END)
  .compile();

export async function runVisionAgent(input: RunVisionAgentInput): Promise<ExtractionResult> {
  const result = await graph.invoke({
    tenantId:       input.tenantId,
    submissionId:   input.certificationId,
    employeeId:     input.workerId,
    certType:       input.certType,
    documentBase64: input.documentBase64,
    workflowId:     input.workflowId,
    objectStoreKey: '',
    userId:         '',
  });

  if (!result.extraction) {
    throw new Error('Vision agent produced no extraction result');
  }
  return result.extraction as ExtractionResult;
}

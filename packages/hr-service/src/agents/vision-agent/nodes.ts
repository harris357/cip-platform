import type { ChatOpenAI } from '@langchain/openai';
import type { VisionAgentState } from './state.js';

export function extractionNode(model: ChatOpenAI) {
  return async (state: VisionAgentState): Promise<Partial<VisionAgentState>> => {
    void model;
    void state;
    // TODO: invoke model with document image + extraction prompt
    // Return updated extractedFields, confidence, requiresHITL
    throw new Error('extractionNode: not implemented');
  };
}

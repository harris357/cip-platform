import type { AgentState } from '@cip/shared/src/types/agent.js';

// runId and startedAt are omitted because the LangGraph initial state does not
// carry them — they are populated by the Temporal activity wrapper on completion.
export interface VisionAgentState extends Omit<AgentState, 'runId' | 'startedAt'> {
  runId?: string;
  startedAt?: string;
  userId: string;
  workflowId: string;
  activityId: string;
  model: string;
  messages: unknown[];
  documentBase64: string;
  certType: string;
  extractedFields: Record<string, { value: string | null; confidence: number; requiresReview: boolean }>;
  confidence: number;
  requiresHITL: boolean;
  hitlReason?: string;
}

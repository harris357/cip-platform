import type { AgentState } from '@cip/shared/src/types/agent.js';

export interface VisionAgentState extends AgentState {
  documentBase64: string;
  certType: string;
  extractedFields: Record<string, { value: string | null; confidence: number; requiresReview: boolean }>;
  confidence: number;
  requiresHITL: boolean;
  hitlReason?: string;
}

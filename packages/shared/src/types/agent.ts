import { z } from 'zod';

// Base state injected into every LangGraph agent graph
export interface AgentState {
  tenantId: string;
  userId: string;
  workflowId: string;
  activityId: string;
  model: 'cip-vision' | 'cip-chat' | 'cip-lightweight' | 'cip-reasoning';
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  error?: string;
}

// Vision Agent output — returned from RunVisionAgentActivity
export const ExtractionResultSchema = z.object({
  certType: z.string(),
  extractedFields: z.record(z.object({
    value: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    requiresReview: z.boolean(),
  })),
  overallConfidence: z.number().min(0).max(1),
  requiresHITL: z.boolean(),
  hitlReason: z.string().optional(),
  promptVersion: z.string(),
  modelUsed: z.string(),
  tokensUsed: z.number(),
  costUsd: z.number(),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// Teams Bot intent router output — Tier 2 single structured LLM call
export const IntentResultSchema = z.object({
  intent: z.enum([
    'cert_upload',
    'compliance_query',
    'worker_lookup',
    'status_check',
    'escalation',
    'unknown',
  ]),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string()).optional(),
  rawMessage: z.string(),
});
export type IntentResult = z.infer<typeof IntentResultSchema>;

// Compliance Assessment Agent output
export const ComplianceResultSchema = z.object({
  workerId: z.string(),
  siteId: z.string(),
  isCompliant: z.boolean(),
  blockingGaps: z.array(z.object({
    certType: z.string(),
    reason: z.string(),
    severity: z.enum(['blocking', 'warning']),
    remediation: z.string(),
  })),
  requiresHITL: z.boolean(),
  assessedAt: z.string().datetime(),
  modelUsed: z.string(),
});
export type ComplianceResult = z.infer<typeof ComplianceResultSchema>;

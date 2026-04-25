import { z } from 'zod';

export interface AgentState {
  tenantId: string;       // REQUIRED on every agent state
  runId: string;
  startedAt: string;      // ISO 8601
  completedAt?: string;   // ISO 8601
  error?: string;
}

export interface VisionAgentState extends AgentState {
  certId: string;
  userId: string;
  documentUrl: string;
  documentBase64?: string;
  extraction?: ExtractionResult;
  requiresHitl: boolean;
  hitlResolution?: HitlResolution;
}

export interface HitlResolution {
  reviewedBy: string;
  resolvedAt: string;     // ISO 8601
  approved: boolean;
  corrections?: Record<string, string>;
}

export interface IntentResult {
  intent: 'UPLOAD_CERT' | 'QUERY_COMPLIANCE' | 'RESPOND_HITL' | 'UNKNOWN';
  confidence: number;
  entities: Record<string, string>;
  tenantId: string;       // REQUIRED
}

// Zod schemas — re-exported by utils/zod-schemas.ts
export const ExtractionResultSchema = z.object({
  tenantId: z.string().uuid(),
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

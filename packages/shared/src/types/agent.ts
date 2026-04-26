import { z } from 'zod';

// ExtractionResult is a cross-service contract: hr-service produces it, teams-bot consumes it for HITL cards.
export const ExtractionResultSchema = z.object({
  tenantId:          z.string().uuid(),
  certType:          z.string(),
  extractedFields:   z.record(z.unknown()),
  overallConfidence: z.number().min(0).max(1),
  requiresHITL:      z.boolean(),
  promptVersion:     z.string(),
  modelUsed:         z.string(),
  tokensUsed:        z.number().int().nonnegative(),
  costUsd:           z.number().nonnegative(),
});

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// IntentResult is produced by the bot's intent-router and consumed by bot handlers.
export const IntentResultSchema = z.object({
  intent:     z.enum(['UPLOAD_CERT', 'QUERY_COMPLIANCE', 'RESPOND_HITL', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  entities:   z.record(z.string()),
  tenantId:   z.string(),
});

export type IntentResult = z.infer<typeof IntentResultSchema>;

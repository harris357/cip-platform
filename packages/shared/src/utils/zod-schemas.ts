import { z } from 'zod';

export const ExtractionResultSchema = z.object({
  tenantId: z.string().uuid(),
  certId: z.string().uuid(),
  extracted: z.object({
    certType: z.string().optional(),
    issuingBody: z.string().optional(),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
  }),
  confidence: z.number().min(0).max(1),
  rawText: z.string(),
  warnings: z.array(z.string()),
});

export const IntentResultSchema = z.object({
  intent: z.enum(['UPLOAD_CERT', 'QUERY_COMPLIANCE', 'RESPOND_HITL', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string()),
  tenantId: z.string().uuid(),
});

export type ValidatedExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ValidatedIntentResult = z.infer<typeof IntentResultSchema>;

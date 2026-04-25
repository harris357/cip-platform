import { z } from 'zod';
import { ExtractionResultSchema } from '../types/agent.js';

export { ExtractionResultSchema };

export const IntentResultSchema = z.object({
  intent: z.enum(['UPLOAD_CERT', 'QUERY_COMPLIANCE', 'RESPOND_HITL', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string()),
  tenantId: z.string().uuid(),
});

export type ValidatedExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type ValidatedIntentResult = z.infer<typeof IntentResultSchema>;

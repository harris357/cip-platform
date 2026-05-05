// Slice 58B — bot-progress event schema.
//
// Wire format for the cip.bot.progress.* NATS subject family. Document-
// service activities publish; the bot subscribes per-tenant and edits/
// emits progress cards in Teams. Schema is intentionally small + open
// to extension via `detail`.
//
// Steps cover the full doc-service workflow phases (58B ships scan/
// generic_features/embedding/fingerprint/sensitivity; 58C+ adds the
// later steps). Bot ignores unknown steps gracefully.

import { z } from 'zod';

export const ProgressStepSchema = z.enum([
  'scan',
  'generic_features',
  'embedding',
  'fingerprint',
  'sensitivity',
  'classify',
  'subject',
  'route',
]);
export type ProgressStep = z.infer<typeof ProgressStepSchema>;

export const ProgressStatusSchema = z.enum(['started', 'completed', 'failed', 'skipped']);
export type ProgressStatus = z.infer<typeof ProgressStatusSchema>;

export const BotProgressEventSchema = z.object({
  documentId:     z.string().uuid(),
  tenantId:       z.string().uuid(),
  conversationId: z.string(),
  step:           ProgressStepSchema,
  status:         ProgressStatusSchema,
  message:        z.string().optional(),                 // human-readable; bot may display
  detail:         z.record(z.unknown()).optional(),      // step-specific (threat name, page count, tier, ...)
  occurredAt:     z.string().datetime(),
});
export type BotProgressEvent = z.infer<typeof BotProgressEventSchema>;

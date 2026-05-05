// Slice 58B — best-effort progress publisher.
//
// Streams a per-step BotProgressEvent to the per-conversation NATS subject
// the bot subscribes to. NEVER throws — a NATS outage MUST NOT fail the
// surrounding workflow phase. Hard rule #5.

import {
  BotProgressEventSchema,
  progressSubject,
  getNatsConnection,
  type BotProgressEvent,
} from '@cip/shared'

export interface PublishProgressInput {
  tenantId:       string
  conversationId: string
  documentId:     string
  step:           BotProgressEvent['step']
  status:         BotProgressEvent['status']
  message?:       string
  detail?:        Record<string, unknown>
}

export async function publishProgressActivity(input: PublishProgressInput): Promise<void> {
  const event: BotProgressEvent = {
    tenantId:       input.tenantId,
    conversationId: input.conversationId,
    documentId:     input.documentId,
    step:           input.step,
    status:         input.status,
    ...(input.message !== undefined ? { message: input.message } : {}),
    ...(input.detail !== undefined ? { detail: input.detail }   : {}),
    occurredAt:     new Date().toISOString(),
  }

  // Validate before publishing — schema mismatches at this layer would
  // produce silently-wrong cards; better to log and skip.
  let parsed: BotProgressEvent
  try {
    parsed = BotProgressEventSchema.parse(event)
  } catch (err) {
    console.warn(`[progress] schema mismatch: ${err instanceof Error ? err.message : String(err)} — dropping event`)
    return
  }

  try {
    const nc = await getNatsConnection()
    nc.publish(
      progressSubject(parsed.tenantId, parsed.conversationId),
      new TextEncoder().encode(JSON.stringify(parsed)),
    )
  } catch (err) {
    // Best-effort: log + swallow. Activity returns success.
    console.warn(`[progress] publish failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

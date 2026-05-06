// Slice 58B-2b — bot-progress NATS subscriber + Teams proactive renderer.
// (Updated post-slice-61: in-place status updates instead of stacked messages.)
//
// When the bot kicks off a doc-service upload, doc-service activities
// publish progress events to `cip.bot.progress.{tenantId}.{conversationId}`.
// This module subscribes per-conversation, sends ONE proactive message
// per document on the first event, then UPDATES that same message in
// place on each subsequent event (mirrors modern LLM streaming UX —
// one rotating status line, not a stack of individual messages).
//
// Per-document state: we track the proactive activity id we sent for
// each documentId. First event → sendActivity + capture id. Later
// events → updateActivity(id, …). If the update fails (message too
// old, Teams 1-day update window, etc.) we fall back to sendActivity
// and rebind the id.
//
// Hard rules:
//   - Best-effort. Subscribe failures, parse failures, and proactive-send
//     failures are logged + swallowed; they MUST NOT throw to the bot's
//     main turn loop. NATS publish on the doc-service side is also
//     best-effort, so a missing/dropped event is expected.
//   - Multiplex: one NATS subscription per (tenantId, conversationId).
//     If a second upload arrives in the same conversation, we register
//     its documentId on the existing subscription rather than opening
//     a new one. The renderer demuxes by `documentId` so events render
//     in order even when they interleave.
//   - TTL: tunable `documents.progress_subscription_ttl_seconds` (default
//     300). When it expires, the subscription unsubs cleanly. Re-arms on
//     a new upload in the same conversation.

import type { TurnContext } from '@microsoft/agents-hosting';
import type { Activity, ConversationReference } from '@microsoft/agents-activity';
import {
  BotProgressEventSchema,
  progressSubject,
  getNatsConnection,
  type BotProgressEvent,
} from '@cip/shared';

import { getTunables, getTunable } from '../langgraph/tunables.js';

// `adapter` is the CloudAdapter constructed in server.ts. Resolved
// lazily so unit tests can import this module without bootstrapping
// the express app + Bot Framework auth config that server.ts builds at
// module-load time.
type Adapter = {
  continueConversation: (
    botAppId: string,
    ref:      ConversationReference,
    cb:       (ctx: TurnContext) => Promise<void>,
  ) => Promise<void>;
};
let _adapter: Adapter | undefined;
async function getAdapter(): Promise<Adapter> {
  if (_adapter) return _adapter;
  const mod = await import('../server.js');
  _adapter = mod.adapter as unknown as Adapter;
  return _adapter;
}

interface ActiveSubscription {
  conversationRef:    Partial<ConversationReference>;
  unsubscribe:        () => void;
  ttlTimer:           ReturnType<typeof setTimeout>;
  documentIds:        Set<string>;
  /** Per-document Teams activity id of the status message we're updating
   *  in place. First event for a doc populates this; later events trigger
   *  updateActivity with the captured id. */
  statusActivityIds:  Map<string, string>;
  loop?:              Promise<void>;
}

const ACTIVE = new Map<string /* tenantId|conversationId */, ActiveSubscription>();

function key(tenantId: string, conversationId: string): string {
  return `${tenantId}|${conversationId}`;
}

function closeSubscription(k: string): void {
  const sub = ACTIVE.get(k);
  if (!sub) return;
  try { clearTimeout(sub.ttlTimer); } catch { /* ignore */ }
  try { sub.unsubscribe(); } catch (err) {
    console.warn(`[progress-renderer] unsubscribe failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  ACTIVE.delete(k);
}

/**
 * Translate a `BotProgressEvent` into a short user-facing line. Returns
 * `null` if the event isn't worth surfacing (we're noisy enough as it is).
 */
export function formatProgressEvent(ev: BotProgressEvent): string | null {
  const detail = (ev.detail ?? {}) as Record<string, unknown>;

  if (ev.step === 'scan' && ev.status === 'started')   return 'Scanning for viruses...';
  if (ev.step === 'scan' && ev.status === 'completed') return 'Scan complete.';
  if (ev.step === 'scan' && ev.status === 'failed') {
    const threat = typeof detail['threat'] === 'string' ? detail['threat'] : 'unknown';
    return `Scan failed: ${threat}.`;
  }

  if (ev.step === 'generic_features' && ev.status === 'started')   return 'Extracting features...';
  if (ev.step === 'generic_features' && ev.status === 'completed') {
    const pages = typeof detail['pageCount'] === 'number' ? detail['pageCount'] : null;
    return pages !== null ? `Features extracted (${pages} page${pages === 1 ? '' : 's'}).` : 'Features extracted.';
  }

  if (ev.step === 'embedding' && ev.status === 'started')   return 'Computing embedding...';
  if (ev.step === 'embedding' && ev.status === 'completed') return 'Embedding ready.';

  if (ev.step === 'fingerprint' && ev.status === 'started')   return 'Fingerprinting layout...';
  if (ev.step === 'fingerprint' && ev.status === 'completed') return 'Layout fingerprinted.';

  if (ev.step === 'sensitivity' && ev.status === 'started') return 'Scoring sensitivity...';
  if (ev.step === 'sensitivity' && ev.status === 'completed') {
    const tier = typeof detail['tier'] === 'string' ? detail['tier'] : 'unknown';
    return `Sensitivity tier: ${tier}.`;
  }

  // 58C+ steps — bot doesn't ship UX for these in 58B but keep best-effort
  // pass-through so future slices don't have to revisit this module.
  if (ev.step === 'classify' && ev.status === 'completed') {
    const docType = typeof detail['docType'] === 'string' ? detail['docType'] : null;
    return docType ? `Classified as ${docType}.` : 'Classified.';
  }

  // Skip "started" for late phases (too noisy) and any failure paths
  // we haven't designed copy for; the doc record + status tool show truth.
  if (ev.status === 'failed') {
    return `Step ${ev.step} failed.`;
  }
  return null;
}

/**
 * Send a new status line OR update an existing one in place.
 *
 * Returns the resulting Teams activity id. Caller stores it per
 * documentId so the next event for that document updates this same
 * message instead of stacking a new one.
 *
 * Update-failure fallback: if updateActivity throws (e.g. the message
 * is older than Teams' update window, or the channel doesn't support
 * updates), we send a fresh message and return its id.
 */
async function sendOrUpdateProactive(
  ref:        Partial<ConversationReference>,
  text:       string,
  existingId: string | undefined,
): Promise<string | undefined> {
  const botAppId = process.env['BOT_APP_ID'] ?? '';
  const ad = await getAdapter();
  let resultId: string | undefined;
  await ad.continueConversation(
    botAppId,
    ref as ConversationReference,
    async (ctx: TurnContext) => {
      if (existingId) {
        try {
          await ctx.updateActivity({
            id:   existingId,
            type: 'message',
            text,
          } as unknown as Activity);
          resultId = existingId;
          return;
        } catch (err) {
          console.warn(
            `[progress-renderer] updateActivity failed (id=${existingId}): ${err instanceof Error ? err.message : String(err)} — sending new`,
          );
          // fall through to send a fresh message
        }
      }
      const sent = await ctx.sendActivity({ type: 'message', text } as unknown as Activity);
      resultId = (sent as { id?: string } | undefined)?.id;
    },
  );
  return resultId;
}

async function readProgressTtlMs(tenantId: string): Promise<number> {
  try {
    const tunables = await getTunables(tenantId);
    const seconds = getTunable<number>(tunables, 'documents.progress_subscription_ttl_seconds', 300);
    return Math.max(30, seconds) * 1000;
  } catch {
    return 300_000;
  }
}

/**
 * Subscribe to per-conversation doc-service progress for a given upload.
 * Idempotent at the (tenant, conversation) level — repeat calls register
 * additional documentIds on the existing subscription.
 *
 * Best-effort: any failure (NATS unreachable, parse error, proactive-send
 * failure) is logged and swallowed. The bot's main turn returns success
 * regardless.
 */
export async function startProgressRenderer(
  context:        TurnContext,
  tenantId:       string,
  conversationId: string,
  documentId:     string,
): Promise<void> {
  const k = key(tenantId, conversationId);

  // Multiplex: another upload in the same conversation? Register its
  // documentId on the existing subscription and exit.
  const existing = ACTIVE.get(k);
  if (existing) {
    existing.documentIds.add(documentId);
    return;
  }

  let nc;
  try {
    nc = await getNatsConnection();
  } catch (err) {
    console.warn(`[progress-renderer] getNatsConnection failed: ${err instanceof Error ? err.message : String(err)} — events will not be rendered for ${k}`);
    return;
  }

  const conversationRef = context.activity.getConversationReference();
  const subject = progressSubject(tenantId, conversationId);

  let natsSub: { unsubscribe: () => void; [Symbol.asyncIterator]: () => AsyncIterator<{ data: Uint8Array }> };
  try {
    // @nats-io subscribe returns a Subscription that's async-iterable.
    // The shape is loose because nats-core types ship a richer type than
    // we need; the runtime contract (unsubscribe + iterator over Msg) is stable.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    natsSub = nc.subscribe(subject) as any;
  } catch (err) {
    console.warn(`[progress-renderer] subscribe failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const ttlMs = await readProgressTtlMs(tenantId);
  const ttlTimer = setTimeout(() => closeSubscription(k), ttlMs);

  const sub: ActiveSubscription = {
    conversationRef,
    unsubscribe:       () => natsSub.unsubscribe(),
    ttlTimer,
    documentIds:       new Set([documentId]),
    statusActivityIds: new Map(),
  };
  ACTIVE.set(k, sub);

  // Background loop. Errors inside one event don't break the loop —
  // a single bad payload can't take down the whole subscription.
  sub.loop = (async () => {
    try {
      for await (const m of natsSub) {
        try {
          const raw = JSON.parse(new TextDecoder().decode(m.data));
          const ev = BotProgressEventSchema.parse(raw);
          if (!sub.documentIds.has(ev.documentId)) continue;
          const text = formatProgressEvent(ev);
          if (!text) continue;
          const existingId = sub.statusActivityIds.get(ev.documentId);
          const newId = await sendOrUpdateProactive(sub.conversationRef, text, existingId);
          if (newId) {
            sub.statusActivityIds.set(ev.documentId, newId);
          }
        } catch (err) {
          console.warn(`[progress-renderer] event handle failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } catch (err) {
      // Iterator-level failure (subscription torn down, NATS dropped, etc.)
      console.warn(`[progress-renderer] loop ended: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      // Whatever ended the loop, ensure we drop our entry so a new upload
      // can re-arm a fresh subscription.
      if (ACTIVE.get(k) === sub) ACTIVE.delete(k);
    }
  })();
}

/** Test-only — close every active subscription. */
export function _closeAllProgressSubscriptions(): void {
  for (const k of Array.from(ACTIVE.keys())) closeSubscription(k);
}

/** Test-only — inspect the active subscription map. */
export function _activeSubscriptionCount(): number {
  return ACTIVE.size;
}

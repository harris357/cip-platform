// Slice 58B-2b — bot-progress NATS subscriber + Teams proactive renderer.
//
// When the bot kicks off a doc-service upload, doc-service activities
// publish progress events to `cip.bot.progress.{tenantId}.{conversationId}`.
// This module subscribes per-conversation, transforms each event into a
// fresh Teams message via `adapter.continueConversation(...)`, and tears
// the subscription down after a TTL (so we don't leak NATS subscriptions
// for conversations that have gone quiet).
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
  conversationRef: Partial<ConversationReference>;
  unsubscribe:     () => void;
  ttlTimer:        ReturnType<typeof setTimeout>;
  documentIds:     Set<string>;
  loop?:           Promise<void>;
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

async function sendProactive(
  ref:  Partial<ConversationReference>,
  text: string,
): Promise<void> {
  const botAppId = process.env['BOT_APP_ID'] ?? '';
  const ad = await getAdapter();
  await ad.continueConversation(
    botAppId,
    ref as ConversationReference,
    async (ctx: TurnContext) => {
      // Activity is a thin discriminated-union type; constructing one
      // via the plain shape (matches server.ts /proactive route).
      await ctx.sendActivity({ type: 'message', text } as unknown as Activity);
    },
  );
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
    unsubscribe:  () => natsSub.unsubscribe(),
    ttlTimer,
    documentIds:  new Set([documentId]),
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
          await sendProactive(sub.conversationRef, text);
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

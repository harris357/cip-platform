// Slice 53 — verb-dispatched invoke router for `adaptiveCard/action`.
//
// Card clicks made via `Action.Execute` arrive at the bot as an invoke
// activity with `name === 'adaptiveCard/action'` and `value.action.verb`
// set to whatever verb the card declared. This router fans those out
// to per-verb handlers registered at boot.
//
// Verb naming convention (NOT enforced — convention only):
//   `<module>.<feature>.<action>`
//
// Examples currently used / planned:
//   - bot.write_confirm.respond           (this slice's only consumer)
//   - documents.subject.pick              (slice 58D)
//   - documents.subject.escalate          (slice 58D)
//   - documents.reclassify.submit         (slice 58F)
//   - documents.reclassify.approve        (slice 58F)
//   - cert.template.diff.approve          (slice 58I)
//
// Keep `registerInvokeHandler` permissive — collisions throw, but we
// don't validate the namespace shape. New consumers pick their own
// verb and own its lifecycle.
//
// CRITICAL: this router is ADDITIVE. `dispatchInvoke` returns null
// when no verb matches; the bot then falls through to
// `super.onInvokeActivity()`. Existing `signin/*` invokes and any
// future `adaptiveCard/action` flows that don't register a handler
// here continue to work unchanged.

import type { TurnContext } from '@microsoft/agents-hosting';

/**
 * Decision returned by an invoke handler. Maps directly to the Teams
 * `AdaptiveCardInvokeResponse` shape:
 *   - statusCode → http status the bot returns to Teams (200 even on
 *     business-logic refusal so Teams stops retrying)
 *   - body       → AdaptiveCardInvokeResponse value to return to the
 *     channel (replacement card body lives in body.value.card)
 */
export interface InvokeResult {
  statusCode: number;
  /**
   * AdaptiveCardInvokeResponse body. SDK expects:
   *   { statusCode, type, value }
   * with type='application/vnd.microsoft.card.adaptive' for a card
   * replacement, or type='application/vnd.microsoft.activity.message'
   * for a message-only response.
   */
  body: {
    statusCode: number;
    type:       string;
    value:      Record<string, unknown>;
  };
}

/**
 * Parsed invoke context handed to a registered handler. The router
 * pre-extracts `verb` + `data` from `activity.value.action` so handlers
 * don't have to re-parse the SDK shape.
 */
export interface InvokeContext {
  context: TurnContext;
  verb:    string;
  data:    Record<string, unknown>;
}

export interface InvokeHandler {
  /** Verb this handler claims. See namespace convention above. */
  verb: string;
  /**
   * Optional: return the AAD object id of the user authorised to
   * trigger this verb on THIS click. The router rejects clicks from
   * any other user with a "wrong user" result card. Returning
   * `undefined` opts out of the check (any user in the conversation
   * may trigger).
   *
   * The 53 confirm handler reads `state.values.employeeId` from the
   * suspended checkpoint (employeeId is the AAD object id — see
   * resolve-context.ts). Future handlers in 58D+ will read whatever
   * source-of-truth their flow has (doc uploader, ticket assignee,
   * etc.) and map it to AAD.
   */
  authorizedUser?: (ctx: InvokeContext) => Promise<string | undefined>;
  /** Resolve the click. The handler returns `null` to opt out of
   *  responding (router treats this like a miss); typical handlers
   *  return an AdaptiveCardInvokeResponse body. */
  handle(ctx: InvokeContext): Promise<InvokeResult>;
}

const handlers = new Map<string, InvokeHandler>();

/**
 * Register an invoke handler for a verb. Throws on duplicate verb —
 * registrations are boot-time, so a collision is a programming error
 * and surfacing it loudly is correct.
 */
export function registerInvokeHandler(h: InvokeHandler): void {
  if (handlers.has(h.verb)) {
    throw new Error(`duplicate invoke verb: ${h.verb}`);
  }
  handlers.set(h.verb, h);
}

/** Test-only: drop the registry. Don't call from production code. */
export function _resetInvokeHandlers(): void {
  handlers.clear();
}

/** Test-only: number of handlers currently registered. */
export function _registeredVerbs(): string[] {
  return Array.from(handlers.keys());
}

/**
 * Dispatch an `adaptiveCard/action` invoke through the registry.
 * Returns `null` on any of:
 *   - activity.value missing or malformed (no action.verb)
 *   - no handler registered for the verb
 *
 * The bot's `onInvokeActivity` MUST fall through to
 * `super.onInvokeActivity(context)` on null so signin/* and any
 * unknown invoke types continue to work.
 *
 * On `authorizedUser` mismatch the router short-circuits with a
 * `wrong_user` result before calling the handler.
 */
export async function dispatchInvoke(context: TurnContext): Promise<InvokeResult | null> {
  const value = context.activity.value as
    | { action?: { verb?: unknown; data?: unknown } }
    | undefined;
  const action = value?.action;
  if (!action || typeof action.verb !== 'string') return null;

  const verb = action.verb;
  const handler = handlers.get(verb);
  if (!handler) return null;

  // SDK types `data` as `Record<string, any>`. Defensive cast.
  const data = (action.data ?? {}) as Record<string, unknown>;
  const ctx: InvokeContext = { context, verb, data };

  // Wrong-user check fires BEFORE the handler runs so handlers don't
  // each have to re-implement it. Handlers that want any user to be
  // able to trigger simply omit `authorizedUser`.
  if (handler.authorizedUser) {
    let expected: string | undefined;
    try {
      expected = await handler.authorizedUser(ctx);
    } catch (err) {
      console.warn(`[invoke-router] authorizedUser threw for verb=${verb}: ${err instanceof Error ? err.message : String(err)}`);
      // Treat introspection failure as "can't verify"; safer to refuse.
      return wrongUserResult();
    }
    if (expected) {
      const clickerAad =
        ((context.activity.from as unknown) as Record<string, unknown> | undefined)?.['aadObjectId'] as string | undefined;
      if (!clickerAad || clickerAad !== expected) {
        return wrongUserResult();
      }
    }
  }

  return handler.handle(ctx);
}

function wrongUserResult(): InvokeResult {
  // The handler that registered ownership of the verb is responsible
  // for rendering its OWN refusal card on a wrong-user click — the
  // router doesn't know what the card should look like for an
  // arbitrary verb. We surface a generic result here; the confirm
  // handler doesn't see this branch (its own authorizedUser check
  // is the gate). Future handlers can intercept by short-circuiting
  // in their authorizedUser hook (return undefined → skip check).
  return {
    statusCode: 200,
    body: {
      statusCode: 200,
      type:  'application/vnd.microsoft.activity.message',
      value: { message: 'Only the user who initiated this action can confirm it.' },
    },
  };
}

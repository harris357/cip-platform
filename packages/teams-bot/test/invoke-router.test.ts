// Slice 53 — invoke router unit tests.
//
// Pure registry + dispatch behaviour. No TurnContext bootstrap; we
// hand-build a minimal stub that exposes only what dispatchInvoke
// reads: `activity.value.action` and `activity.from.aadObjectId`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerInvokeHandler,
  dispatchInvoke,
  _resetInvokeHandlers,
  _registeredVerbs,
  type InvokeHandler,
} from '../src/teams-protocol/invoke-router.js';

// Minimum surface dispatchInvoke reads from the TurnContext.
function fakeContext(opts: {
  verb?: string;
  data?: Record<string, unknown>;
  fromAad?: string;
  // explicitly skip the value.action shape (malformed invoke)
  noAction?: boolean;
}): unknown {
  const action = opts.noAction
    ? undefined
    : opts.verb !== undefined
      ? { type: 'Action.Execute', verb: opts.verb, data: opts.data ?? {} }
      : undefined;
  return {
    activity: {
      value: action ? { action } : (opts.noAction ? null : { action }),
      from:  { aadObjectId: opts.fromAad ?? '' },
    },
  };
}

describe('invoke-router', () => {
  beforeEach(() => _resetInvokeHandlers());

  it('registers a handler and exposes its verb', () => {
    const h: InvokeHandler = {
      verb: 'demo.feature.action',
      async handle() {
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    };
    registerInvokeHandler(h);
    expect(_registeredVerbs()).toEqual(['demo.feature.action']);
  });

  it('throws on duplicate verb registration', () => {
    const h: InvokeHandler = {
      verb: 'demo.feature.action',
      async handle() {
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    };
    registerInvokeHandler(h);
    expect(() => registerInvokeHandler(h)).toThrowError(/duplicate invoke verb/);
  });

  it('returns null when activity has no action.verb', async () => {
    // Even with a handler registered, a malformed invoke yields null
    // so the bot falls back to super.onInvokeActivity.
    registerInvokeHandler({
      verb: 'demo.feature.action',
      async handle() {
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await dispatchInvoke(fakeContext({ noAction: true }) as any);
    expect(out).toBeNull();
  });

  it('returns null when no handler matches the verb', async () => {
    registerInvokeHandler({
      verb: 'demo.feature.action',
      async handle() {
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const out = await dispatchInvoke(fakeContext({ verb: 'nope.unknown.verb' }) as any);
    expect(out).toBeNull();
  });

  it('dispatches to the matching handler', async () => {
    let seen: { verb: string; data: Record<string, unknown> } | null = null;
    registerInvokeHandler({
      verb: 'demo.feature.action',
      async handle(ctx) {
        seen = { verb: ctx.verb, data: ctx.data };
        return {
          statusCode: 200,
          body: { statusCode: 200, type: 'demo', value: { ok: true } },
        };
      },
    });
    const out = await dispatchInvoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeContext({ verb: 'demo.feature.action', data: { hello: 'world' } }) as any,
    );
    expect(out).not.toBeNull();
    expect(out!.statusCode).toBe(200);
    expect(out!.body.value).toEqual({ ok: true });
    expect(seen).toEqual({ verb: 'demo.feature.action', data: { hello: 'world' } });
  });

  it('rejects with wrong-user result when authorizedUser mismatches the clicker', async () => {
    let handlerRan = false;
    registerInvokeHandler({
      verb: 'demo.feature.action',
      authorizedUser: async () => 'aad-user-A',
      async handle() {
        handlerRan = true;
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    });
    const out = await dispatchInvoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeContext({ verb: 'demo.feature.action', fromAad: 'aad-user-B' }) as any,
    );
    expect(out).not.toBeNull();
    expect(out!.statusCode).toBe(200);                         // 200 so Teams stops retry
    expect(handlerRan).toBe(false);                            // handler never invoked
    expect(JSON.stringify(out!.body)).toMatch(/Only the user who initiated/);
  });

  it('passes through when authorizedUser matches the clicker', async () => {
    let handlerRan = false;
    registerInvokeHandler({
      verb: 'demo.feature.action',
      authorizedUser: async () => 'aad-user-A',
      async handle() {
        handlerRan = true;
        return {
          statusCode: 200,
          body: { statusCode: 200, type: 'demo', value: { ok: true } },
        };
      },
    });
    const out = await dispatchInvoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeContext({ verb: 'demo.feature.action', fromAad: 'aad-user-A' }) as any,
    );
    expect(out).not.toBeNull();
    expect(handlerRan).toBe(true);
    expect(out!.body.value).toEqual({ ok: true });
  });

  it('treats authorizedUser returning undefined as "no check" (any user OK)', async () => {
    let handlerRan = false;
    registerInvokeHandler({
      verb: 'demo.feature.action',
      authorizedUser: async () => undefined,
      async handle() {
        handlerRan = true;
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    });
    const out = await dispatchInvoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeContext({ verb: 'demo.feature.action', fromAad: 'aad-user-Q' }) as any,
    );
    expect(out).not.toBeNull();
    expect(handlerRan).toBe(true);
  });

  it('treats authorizedUser throwing as a refusal (defensive)', async () => {
    let handlerRan = false;
    registerInvokeHandler({
      verb: 'demo.feature.action',
      authorizedUser: async () => { throw new Error('introspect failed'); },
      async handle() {
        handlerRan = true;
        return { statusCode: 200, body: { statusCode: 200, type: 'x', value: {} } };
      },
    });
    const out = await dispatchInvoke(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeContext({ verb: 'demo.feature.action', fromAad: 'aad-user-A' }) as any,
    );
    expect(out).not.toBeNull();
    expect(handlerRan).toBe(false);
    expect(out!.statusCode).toBe(200);
  });
});

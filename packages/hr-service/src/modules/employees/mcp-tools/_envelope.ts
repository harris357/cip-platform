// Slice 33: shared response envelope for HR MCP tools.
// Existing tools (certifications) use { data, card?, message? } JSON-in-text.
// This envelope extends that with an explicit `ok` flag and optional `code`
// so the bot can deterministically branch on success/failure for the new
// HR-tool flows that have non-ok refusal paths (cannot_revoke_baseline,
// migration_no_op, not_found, etc.).
//
// On the wire (matches the existing pattern):
//   return { content: [{ type: 'text', text: JSON.stringify(envelope) }] }
//
// `isError` is reserved for unexpected failures (uncaught exceptions); a
// "refused for documented reason" is { ok: false, code, message } with
// isError UNSET — it's a normal flow result.

export interface OkEnvelope<T = unknown> {
  ok:       true;
  data:     T;
  message?: string;
}

export interface RefusedEnvelope {
  ok:       false;
  code:     string;
  message:  string;
  data?:    null;
}

export type Envelope<T = unknown> = OkEnvelope<T> | RefusedEnvelope;

export function ok<T>(data: T, message?: string): { content: [{ type: 'text'; text: string }] } {
  const env: OkEnvelope<T> = message !== undefined ? { ok: true, data, message } : { ok: true, data };
  return { content: [{ type: 'text' as const, text: JSON.stringify(env) }] };
}

export function refused(
  code: string,
  message: string,
): { content: [{ type: 'text'; text: string }] } {
  const env: RefusedEnvelope = { ok: false, code, message, data: null };
  return { content: [{ type: 'text' as const, text: JSON.stringify(env) }] };
}

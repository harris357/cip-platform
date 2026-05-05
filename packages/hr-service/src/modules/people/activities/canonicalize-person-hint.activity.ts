// Slice 58D-A — LLM canonicalization of free-form person hints.
//
// Calls the canonicalize prompt (Langfuse: `hr.people.canonicalize`,
// label='production'; FALLBACK in code at ../prompts/canonicalize-fallback.ts)
// to normalise candidate text + structured hints into a typed name
// surface the shortlist activity can run pg_trgm against.
//
// Memory: no static nickname/alias maps in code. The LLM does the
// nickname expansion via the prompt; the fallback just narrates the
// rules. Per-tenant overrides live in the Langfuse production label.
//
// Output shape (LLM JSON contract):
//   { firstName?, lastName?, email?, department?, role? }
// All keys optional; missing -> the LLM had no signal. Caller treats
// empty-object as "use candidateText raw against pg_trgm".

import { z } from 'zod';

import {
  callLLM,
  createLiteLLMClient,
  getPrompt,
  // Slice 58E — alias-resolver consolidated into @cip/shared.
  resolveAlias,
} from '@cip/shared';

import { HR_PEOPLE_CANONICALIZE_FALLBACK } from '../prompts/canonicalize-fallback.js';

export const CanonicalizationSchema = z.object({
  firstName:  z.string().optional(),
  lastName:   z.string().optional(),
  email:      z.string().optional(),
  department: z.string().optional(),
  role:       z.string().optional(),
});
export type Canonicalization = z.infer<typeof CanonicalizationSchema>;

export const CanonicalizePersonHintInputSchema = z.object({
  tenantId:      z.string().uuid(),
  candidateText: z.string(),
  /** Same shape as MatchPersonInput.structuredHints — intentionally a
   *  loose record here so the activity can be called with partial info. */
  structuredHints: z.record(z.unknown()).optional(),
});
export type CanonicalizePersonHintInput = z.infer<typeof CanonicalizePersonHintInputSchema>;

export async function canonicalizePersonHintActivity(
  input: CanonicalizePersonHintInput,
): Promise<Canonicalization> {
  const validated = CanonicalizePersonHintInputSchema.parse(input);

  // Short-circuit when there's literally nothing to canonicalize. Saves
  // an LLM call when the caller has only structured hints (e.g. an AAD
  // OID lookup feeding the matcher).
  if (!validated.candidateText.trim() && !validated.structuredHints) {
    return CanonicalizationSchema.parse({});
  }

  const virtualKey = process.env['LITELLM_VIRTUAL_KEY'];
  if (!virtualKey) {
    // No LiteLLM available — return a best-effort canonicalization from
    // the structured hints alone. Better than throwing; the shortlist
    // activity will still run pg_trgm on candidateText.
    return CanonicalizationSchema.parse({
      ...(validated.structuredHints?.['firstName']  !== undefined && { firstName:  String(validated.structuredHints['firstName']) }),
      ...(validated.structuredHints?.['lastName']   !== undefined && { lastName:   String(validated.structuredHints['lastName']) }),
      ...(validated.structuredHints?.['email']      !== undefined && { email:      String(validated.structuredHints['email']).toLowerCase() }),
      ...(validated.structuredHints?.['department'] !== undefined && { department: String(validated.structuredHints['department']) }),
    });
  }

  const client = createLiteLLMClient({ tenantId: validated.tenantId, virtualKey });

  // Single source of truth: alias-resolver. Per-tenant overrides live in
  // routing_rules / tenant_settings.routing_overrides. No matcher-specific
  // tunable for the model alias — every LLM call in the codebase routes
  // through this path uniformly.
  const alias = await resolveAlias({
    service:  'hr-service',
    purpose:  'people_canonicalize',
    tenantId: validated.tenantId,
  });

  // Try Langfuse first; fall back to the local FALLBACK prompt body if
  // langfuse returns the global empty fallback (the slice-41 registry
  // doesn't have this prompt registered globally — slice-58D-A places
  // the fallback alongside the activity).
  let promptText: string;
  try {
    const handle = await getPrompt({
      name:     'hr.people.canonicalize',
      tenantId: validated.tenantId,
    });
    if (handle.source === 'fallback') {
      // Global registry has no entry → use our local fallback body.
      promptText = renderLocalFallback({
        candidateText: validated.candidateText,
        ...(validated.structuredHints !== undefined && { structuredHints: validated.structuredHints }),
      });
    } else {
      promptText = handle.compile({
        candidateText:   validated.candidateText,
        structuredHints: JSON.stringify(validated.structuredHints ?? {}),
      });
    }
  } catch (err) {
    console.warn(`[canonicalize] getPrompt failed: ${err instanceof Error ? err.message : String(err)} — using local fallback`);
    promptText = renderLocalFallback({
      candidateText: validated.candidateText,
      ...(validated.structuredHints !== undefined && { structuredHints: validated.structuredHints }),
    });
  }

  const response = await callLLM(client, {
    model:    alias,
    messages: [{ role: 'user', content: promptText }],
    purpose:  'hr-service.people_canonicalize',
    tenantId: validated.tenantId,
    max_tokens: 200,
  });

  const text = response.choices[0]?.message?.content?.trim() ?? '';
  const parsed = parseJsonObject(text);

  return CanonicalizationSchema.parse(parsed);
}

function renderLocalFallback(args: {
  candidateText:    string;
  structuredHints?: Record<string, unknown>;
}): string {
  // Naive substitution — Langfuse's compile() handles Jinja2; the
  // fallback path just does {{ key }} replacement. Sufficient for the
  // two variables this prompt declares. Stays in lockstep with the
  // production prompt so handoff is byte-identical.
  return HR_PEOPLE_CANONICALIZE_FALLBACK
    .replace('{{ candidateText }}',   args.candidateText)
    .replace('{{ structuredHints }}', JSON.stringify(args.structuredHints ?? {}));
}

function parseJsonObject(text: string): Record<string, unknown> {
  if (!text) return {};
  // Pull the first {...} block to tolerate leading/trailing prose
  // (defensive even though the prompt forbids it).
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return {};
  try {
    const obj = JSON.parse(match[0]) as unknown;
    if (obj && typeof obj === 'object') return obj as Record<string, unknown>;
  } catch {
    // Bad JSON → empty canonicalization → caller falls back to
    // candidateText for pg_trgm. Never throws.
  }
  return {};
}

import Langfuse from 'langfuse';
import { Template } from '@huggingface/jinja';
import { FALLBACKS } from './prompts/index.js';

let _instance: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (_instance) return _instance;

  const publicKey = process.env['LANGFUSE_PUBLIC_KEY'];
  const secretKey = process.env['LANGFUSE_SECRET_KEY'];
  const baseUrl   = process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    throw new Error('Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY');
  }

  _instance = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 10, flushInterval: 5000 });
  return _instance;
}

export async function shutdownLangfuse(): Promise<void> {
  if (_instance) {
    await _instance.shutdownAsync();
    _instance = null;
  }
}

// ─── Slice 41: prompt management ────────────────────────────────────────────

export interface PromptHandle {
  name:    string;
  version: number | null;            // null when served from fallback
  source:  'langfuse' | 'fallback';  // diagnostic — surfaces in traces
  compile: (vars?: Record<string, unknown>) => string;
}

interface CacheEntry {
  handle:    PromptHandle;
  expiresAt: number;
}

const TTL_MS = 5 * 60 * 1000;
const promptCache: Map<string, CacheEntry> = new Map();

// Pre-compile fallback templates once at module load — Jinja2 parsing is
// non-trivial, no point doing it on every classify() call.
const compiledFallbacks: Map<string, Template> = new Map();
for (const [name, text] of Object.entries(FALLBACKS)) {
  try {
    compiledFallbacks.set(name, new Template(text));
  } catch (err) {
    // Bad template at compile time = developer bug. Log loudly; we still
    // register the name so getPrompt() returns a non-null handle (which
    // will produce empty output — visible enough to investigate).
    console.error(`[prompts] failed to pre-compile fallback for '${name}': ${err instanceof Error ? err.message : String(err)}`);
  }
}

function compileFallback(name: string, vars?: Record<string, unknown>): string {
  const tmpl = compiledFallbacks.get(name);
  if (!tmpl) {
    console.error(`[prompts] no fallback registered for '${name}' — empty prompt!`);
    return '';
  }
  try {
    return tmpl.render(vars ?? {});
  } catch (err) {
    console.error(`[prompts] fallback render failed for '${name}': ${err instanceof Error ? err.message : String(err)}`);
    return FALLBACKS[name] ?? '';
  }
}

function fallbackHandle(name: string): PromptHandle {
  return {
    name,
    version: null,
    source:  'fallback',
    compile: (vars) => compileFallback(name, vars),
  };
}

/**
 * Slice 41: fetch a prompt by name + label from Langfuse Cloud, with
 * 5-minute in-memory cache. Falls back to the byte-identical baked-in
 * copy in `clients/prompts/` on any failure (Langfuse down, prompt
 * missing, malformed response).
 *
 * Templating is Jinja2 — for Langfuse-fetched prompts the SDK's compile()
 * handles it; for fallbacks @huggingface/jinja does. Same syntax, same
 * output for the same vars.
 */
export async function getPrompt(args: {
  name:     string;
  tenantId: string;
  label?:   string;
}): Promise<PromptHandle> {
  const label = args.label ?? process.env['LANGFUSE_PROMPT_LABEL'] ?? 'production';
  const cacheKey = `${args.name}:${label}`;

  const cached = promptCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.handle;

  let handle: PromptHandle;
  try {
    const lf = getLangfuse();
    const lfPrompt = await lf.getPrompt(args.name, undefined, { label });
    if (!lfPrompt) {
      console.warn(`[prompts] langfuse returned null for '${args.name}@${label}', using fallback`);
      handle = fallbackHandle(args.name);
    } else {
      handle = {
        name:    args.name,
        version: lfPrompt.version,
        source:  'langfuse',
        // SDK's compile() compiles whatever templating engine the prompt
        // is configured with in Langfuse (mustache or Jinja2).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        compile: (vars) => lfPrompt.compile((vars ?? {}) as any),
      };
    }
  } catch (err) {
    console.warn(`[prompts] langfuse fetch failed for '${args.name}@${label}': ${err instanceof Error ? err.message : String(err)} — using fallback`);
    handle = fallbackHandle(args.name);
  }

  promptCache.set(cacheKey, { handle, expiresAt: Date.now() + TTL_MS });
  return handle;
}

// Test-only: clear the cache between cases.
export function _resetPromptCache(): void {
  promptCache.clear();
}

import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';
import type { PromptHandle } from './langfuse.js';

export interface LiteLLMClientOptions {
  tenantId:   string;
  virtualKey: string;
  baseURL?:   string;
}

export function createLiteLLMClient(opts: LiteLLMClientOptions): OpenAI {
  return new OpenAI({
    apiKey:  opts.virtualKey,
    baseURL: opts.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: {
      'x-tenant-id': opts.tenantId,
    },
  });
}

/**
 * Slice 39A: per-purpose-tagged completion call. Every LLM call site uses
 * this, never `client.chat.completions.create` directly.
 *
 * `purpose` is dot-namespaced — '<service>.<purpose>' (e.g. 'bot.route_simple',
 * 'hr-service.ocr_document'). Surfaces in Langfuse as a filterable tag via
 * the OpenAI metadata field — LiteLLM forwards it to the langfuse callback.
 */
export async function callLLM(
  client: OpenAI,
  args: ChatCompletionCreateParamsNonStreaming & {
    purpose:       string;
    tenantId:      string;
    promptHandle?: PromptHandle;                     // Slice 41: prompt provenance
    extraMeta?:    Record<string, string | number | boolean>;
  },
): Promise<ChatCompletion> {
  const { purpose, tenantId, promptHandle, extraMeta, ...rest } = args;
  const metadata: Record<string, string> = {
    purpose,
    tenantId,
    ...(promptHandle ? {
      prompt_name:    promptHandle.name,
      prompt_version: String(promptHandle.version ?? 'fallback'),
      prompt_source:  promptHandle.source,
    } : {}),
    ...Object.fromEntries(
      Object.entries(extraMeta ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  };
  const resp = await client.chat.completions.create({
    ...rest,
    metadata,
  });

  // Slice 46c part 5: prompt-cache visibility. Mistral's automatic prompt
  // caching surfaces `prompt_tokens_details.cached_tokens` in the response
  // when the prefix matched a recent call (typical TTL ~5 min). Log when
  // a hit fires so we can grep cache effectiveness, and so Langfuse's
  // built-in usage view shows the savings.
  // Verification path noted in slice doc — if LiteLLM doesn't surface
  // this for Mistral, we'll see no [llm-cache] lines and adapt.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = resp.usage as any;
  const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  if (cachedTokens > 0) {
    const totalPrompt = usage?.prompt_tokens ?? 0;
    const ratio = totalPrompt > 0 ? (cachedTokens / totalPrompt).toFixed(2) : '0.00';
    console.log(
      `[llm-cache] purpose=${purpose} cached_tokens=${cachedTokens} ` +
      `total_prompt_tokens=${totalPrompt} hit_ratio=${ratio}`,
    );
  }
  return resp;
}

/**
 * Slice 44: embedding call. Used for tool-catalog vector retrieval and
 * (future) any other embedding-pipelined work. Same metadata convention
 * as callLLM so Langfuse picks up purpose + tenantId tags consistently.
 *
 * Returns the raw embedding vector. Caller is responsible for storage.
 */
export async function callEmbed(
  client: OpenAI,
  args: {
    model:    string;
    input:    string | string[];
    purpose:  string;
    tenantId: string;
    extraMeta?: Record<string, string | number | boolean>;
  },
): Promise<number[][]> {
  const { purpose, tenantId, extraMeta, model, input } = args;
  const metadata: Record<string, string> = {
    purpose,
    tenantId,
    ...Object.fromEntries(
      Object.entries(extraMeta ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  };
  // OpenAI SDK's embeddings.create doesn't accept a typed `metadata` field,
  // but LiteLLM forwards arbitrary extras when passed via the request body.
  // encoding_format: 'float' is set explicitly — without it, some LiteLLM
  // configurations default to base64, and the SDK then surfaces the raw
  // base64 string as `embedding` rather than decoding it to a float array,
  // truncating downstream consumers' dim checks.
  const resp = await client.embeddings.create(
    { model, input, encoding_format: 'float' } as Parameters<typeof client.embeddings.create>[0],
    { headers: { 'x-litellm-metadata': JSON.stringify(metadata) } },
  );
  return resp.data.map(d => {
    const e = d.embedding;
    // Defensive: SDK type says number[], but we've seen base64 strings come
    // through certain proxy configurations. If we get a string, decode it
    // (float32 little-endian) ourselves.
    if (typeof e === 'string') {
      const buf = Buffer.from(e, 'base64');
      const out: number[] = [];
      for (let i = 0; i < buf.length; i += 4) out.push(buf.readFloatLE(i));
      return out;
    }
    return e as number[];
  });
}

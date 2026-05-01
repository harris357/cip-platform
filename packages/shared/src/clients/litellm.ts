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
  return client.chat.completions.create({
    ...rest,
    metadata,
  });
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
  const resp = await client.embeddings.create(
    { model, input } as Parameters<typeof client.embeddings.create>[0],
    { headers: { 'x-litellm-metadata': JSON.stringify(metadata) } },
  );
  return resp.data.map(d => d.embedding);
}

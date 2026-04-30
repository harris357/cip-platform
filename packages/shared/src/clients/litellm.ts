import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
} from 'openai/resources/chat/completions';

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
    purpose:    string;
    tenantId:   string;
    extraMeta?: Record<string, string | number | boolean>;
  },
): Promise<ChatCompletion> {
  const { purpose, tenantId, extraMeta, ...rest } = args;
  const metadata: Record<string, string> = {
    purpose,
    tenantId,
    ...Object.fromEntries(
      Object.entries(extraMeta ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  };
  return client.chat.completions.create({
    ...rest,
    metadata,
  });
}

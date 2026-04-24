import OpenAI from 'openai';

export interface LiteLLMClientOptions {
  tenantId: string;
  virtualKey: string;
  baseURL?: string;
}

export function createLiteLLMClient(opts: LiteLLMClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.virtualKey,
    baseURL: opts.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: {
      'x-tenant-id': opts.tenantId,
    },
  });
}

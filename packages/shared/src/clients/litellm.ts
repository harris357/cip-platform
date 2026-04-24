import { ChatOpenAI } from '@langchain/openai';

export type ModelAlias = 'cip-vision' | 'cip-chat' | 'cip-lightweight' | 'cip-reasoning';

/**
 * Returns a ChatOpenAI instance pointed at LiteLLM.
 * All agents call this — no service imports @anthropic-ai/sdk directly.
 * ANTHROPIC_API_KEY never appears outside the LiteLLM pod.
 */
export function createLiteLLMClient(alias: ModelAlias): ChatOpenAI {
  const baseURL = process.env['LITELLM_BASE_URL']
    ?? 'http://litellm.cip-app.svc.cluster.local:4000';
  const apiKey = process.env['LITELLM_VIRTUAL_KEY'];

  if (!apiKey) throw new Error('LITELLM_VIRTUAL_KEY not set');

  return new ChatOpenAI({
    modelName: alias,
    openAIApiKey: apiKey,
    configuration: { baseURL },
    temperature: 0,
  });
}

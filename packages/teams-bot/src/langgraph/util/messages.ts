// Slice 45: convert LangChain BaseMessages to OpenAI's chat-completion
// shape (what LiteLLM expects). The OpenAI SDK has no helper for this
// — we walk the array manually.

import {
  type BaseMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * Convert BaseMessage[] → OpenAI ChatCompletionMessageParam[].
 *
 * - HumanMessage  → { role: 'user',      content }
 * - AIMessage     → { role: 'assistant', content, tool_calls? }
 * - ToolMessage   → { role: 'tool',      content, tool_call_id }
 * - SystemMessage → { role: 'system',    content }
 *
 * Caller prepends a system message (the planner prompt). This function
 * does NOT inject a system message.
 */
export function messagesToOpenAI(
  messages: BaseMessage[],
): ChatCompletionMessageParam[] {
  return messages.map((m): ChatCompletionMessageParam => {
    if (m instanceof SystemMessage) {
      return { role: 'system', content: stringContent(m.content) };
    }
    if (m instanceof HumanMessage) {
      return { role: 'user', content: stringContent(m.content) };
    }
    if (m instanceof AIMessage) {
      const tool_calls = m.tool_calls?.length
        ? m.tool_calls.map((tc, i) => ({
            id:       tc.id ?? `call_${i}`,
            type:     'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          }))
        : undefined;
      return {
        role:    'assistant',
        content: stringContent(m.content),
        ...(tool_calls ? { tool_calls } : {}),
      };
    }
    if (m instanceof ToolMessage) {
      return {
        role:         'tool',
        tool_call_id: m.tool_call_id,
        content:      stringContent(m.content),
      };
    }
    // Fallback — treat as user
    return { role: 'user', content: stringContent(m.content) };
  });
}

function stringContent(content: BaseMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(c => (typeof c === 'string' ? c : 'text' in c ? c.text : ''))
      .join('');
  }
  return '';
}

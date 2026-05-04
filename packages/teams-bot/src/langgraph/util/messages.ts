// Slice 45: convert LangChain BaseMessages to OpenAI's chat-completion
// shape (what LiteLLM expects). The OpenAI SDK has no helper for this
// — we walk the array manually.
//
// Slice 56D follow-up: switched from `instanceof` to type-tag checks via
// the message-types helpers. PostgresSaver round-trips messages through
// serialization; on a continuing-thread invoke, every message in
// state.messages can be a plain object that fails instanceof but DOES
// carry a `_getType()`/`type` discriminator. Without this, every
// AIMessage(tool_calls) and ToolMessage from a prior turn was getting
// converted to `{role:'user'}`, scrambling the planner's view of the
// conversation and causing Mistral 400s for tool_call_id mismatches.

import {
  type BaseMessage,
  AIMessage,
  ToolMessage,
} from '@langchain/core/messages';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { isAIMessage, isToolMessage, isHumanMessage } from './message-types.js';

interface MessageLike {
  _getType?: () => string;
  type?:     string;
  content?:  unknown;
  tool_calls?: Array<{ id?: string; name: string; args?: Record<string, unknown> }>;
  tool_call_id?: string;
}

function isSystemLike(m: unknown): boolean {
  if (typeof m !== 'object' || m === null) return false;
  const obj = m as MessageLike;
  if (typeof obj._getType === 'function') {
    try { return obj._getType() === 'system'; } catch { /* fall through */ }
  }
  return obj.type === 'system';
}

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
    if (isSystemLike(m)) {
      return { role: 'system', content: stringContent((m as MessageLike).content as BaseMessage['content']) };
    }
    if (isHumanMessage(m)) {
      return { role: 'user', content: stringContent(m.content) };
    }
    if (isAIMessage(m)) {
      const ai = m as AIMessage;
      const tool_calls = ai.tool_calls?.length
        ? ai.tool_calls.map((tc, i) => ({
            id:       tc.id ?? `call_${i}`,
            type:     'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
          }))
        : undefined;
      return {
        role:    'assistant',
        content: stringContent(ai.content),
        ...(tool_calls ? { tool_calls } : {}),
      };
    }
    if (isToolMessage(m)) {
      const tm = m as ToolMessage;
      return {
        role:         'tool',
        tool_call_id: tm.tool_call_id,
        content:      stringContent(tm.content),
      };
    }
    // Fallback — treat as user
    return { role: 'user', content: stringContent((m as MessageLike).content as BaseMessage['content']) };
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

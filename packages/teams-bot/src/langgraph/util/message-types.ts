// Slice 56D follow-up: defensive message-type checks.
//
// LangGraph's PostgresSaver round-trips state through msgpack/JSON
// between turns. In practice, the deserializer reconstructs class
// instances most of the time — but not always. When it gives back
// plain objects with `_getType()` or a `type` discriminator, naked
// `m instanceof AIMessage` returns false, and every node/runner check
// that relies on it silently routes around the message.
//
// Symptom in production: continuing-thread turns showed empty
// tools_attempted, and the user saw "(I had nothing to say...)"
// because the runner's outbound search couldn't find the freshly-
// emitted AIMessage(content) hidden behind a failed instanceof check.
//
// Use these helpers everywhere we'd otherwise call `m instanceof X`
// on messages routed through state.

import { AIMessage, ToolMessage, HumanMessage } from '@langchain/core/messages';

interface MessageLike {
  _getType?: () => string;
  type?:     string;
}

function getMessageType(m: unknown): string | undefined {
  if (typeof m !== 'object' || m === null) return undefined;
  const obj = m as MessageLike;
  if (typeof obj._getType === 'function') {
    try { return obj._getType(); } catch { /* fall through */ }
  }
  return typeof obj.type === 'string' ? obj.type : undefined;
}

export function isAIMessage(m: unknown): m is AIMessage {
  return m instanceof AIMessage || getMessageType(m) === 'ai';
}

export function isToolMessage(m: unknown): m is ToolMessage {
  return m instanceof ToolMessage || getMessageType(m) === 'tool';
}

export function isHumanMessage(m: unknown): m is HumanMessage {
  return m instanceof HumanMessage || getMessageType(m) === 'human';
}

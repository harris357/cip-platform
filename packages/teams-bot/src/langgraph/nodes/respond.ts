// Slice 45 + 55: respond node — terminal node. Selects the message to
// send to Teams based on graph state.
//
// Response paths:
//   1. Triage clarification path (Slice 45): triage emitted
//      clarificationQuestion and routeOnSignals routed here directly.
//   2. Plan-with-no-tools path (Slice 45): planner emitted an AIMessage
//      with content and no tool_calls.
//   3. Confirm path (Slice 46b): confirmNode added the "About to: X.
//      Reply yes/no" AIMessage.
//   4. Slice 55: extractionResult.kind === 'missing' — render a
//      templated clarification (no LLM).
//   5. Slice 55: extractionResult.kind === 'ambiguous' — render a
//      disambiguation adaptive card; runner sends as attachment.
//   6. Slice 55/56 (this fix): extractionResult.kind === 'complete' —
//      grammar/classifier ran a tool deterministically; the planner
//      LLM was skipped. Render the tool's `message` field directly so
//      the user sees the answer without paying for a planner round-trip.
//
// In all cases, this node doesn't call any LLM — it just identifies
// what to send. The actual sendActivity happens in runner.ts (after
// graph.invoke returns) so we have access to the Teams TurnContext.

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { CLARIFICATION_BY_TOOL } from '../../intent/clarification-templates.js';
import { buildDisambiguationCard } from '../../intent/disambiguation-card.js';
import { isAIMessage, isToolMessage } from '../util/message-types.js';
import type { State } from '../state.js';

/**
 * Pull the user-facing `message` out of an MCP tool's JSON envelope, if
 * present. Tools that follow the McpModuleResponse convention return
 * `{data, message, card?}` — the bot uses `message` as the markdown to
 * surface verbatim. Returns null if the tool didn't set one.
 *
 * Slice 56D follow-up: handle the MCP wire envelope. executeTool
 * stringifies the raw MCP response shape `{content:[{type,text:<JSON>}]}`
 * and stores it in ToolMessage.content. Previously this function only
 * looked for `.message` at the top level — which is the WRAPPER's level,
 * not the application envelope. Result: every grammar/classifier-routed
 * turn fell through to lastToolFacts (or "(I had nothing to say...)" when
 * that was empty too) instead of rendering the tool's nicely-formatted
 * user message. distillFact handles both shapes; we now match.
 */
interface McpInnerEnvelope { data?: unknown; message?: unknown; card?: unknown; refused?: unknown }
function unwrapMcpEnvelope(parsed: unknown): McpInnerEnvelope {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const obj = parsed as { content?: unknown };
  // MCP wire shape: { content: [{ type:'text', text:'<inner JSON>' }] }
  if (Array.isArray(obj.content)) {
    const text = obj.content
      .find((c): c is { type: string; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text' &&
        typeof (c as { text?: unknown }).text === 'string')
      ?.text;
    if (typeof text === 'string') {
      try { return JSON.parse(text) as McpInnerEnvelope; }
      catch { return {}; }
    }
    return {};
  }
  return parsed as McpInnerEnvelope;
}

function extractToolUserMessage(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    const env = unwrapMcpEnvelope(parsed);
    if (env.refused) return null;
    if (typeof env.message === 'string' && env.message.length > 0) {
      return env.message;
    }
  } catch { /* not JSON — ignore */ }
  return null;
}

export async function respondNode(state: State): Promise<Partial<State>> {
  // ─── Slice 55: ambiguous extraction → disambiguation card ─────────
  if (state.extractionResult?.kind === 'ambiguous' && state.grammarMatch) {
    const card = buildDisambiguationCard({
      prompt:      'Which one did you mean?',
      toolName:    state.grammarMatch.toolName,
      argName:     state.extractionResult.argName,
      partialArgs: {},
      candidates:  state.extractionResult.candidates,
    });
    return {
      outboundCard: card,
      // Also append a fallback AIMessage so non-card-rendering channels see something.
      messages: [new AIMessage('Which one did you mean? (your client should show a picker — pick one to proceed)')],
    };
  }

  // ─── Slice 55: missing arg → templated clarification ──────────────
  if (state.extractionResult?.kind === 'missing' && state.grammarMatch) {
    const tpl = CLARIFICATION_BY_TOOL[state.grammarMatch.toolName];
    if (tpl) {
      return { messages: [new AIMessage(tpl())] };
    }
  }

  // ─── Triage clarification path (Slice 45) ─────────────────────────
  if (state.triageSignals?.needsClarification && state.triageSignals.clarificationQuestion) {
    const last = state.messages[state.messages.length - 1];
    if (!isAIMessage(last) || last.content !== state.triageSignals.clarificationQuestion) {
      return {
        messages: [new AIMessage(state.triageSignals.clarificationQuestion)],
      };
    }
  }

  // ─── Slice 55/56: deterministic tool path → render tool message ────
  // Grammar router or classifier matched, extractor ran the tool, and
  // shouldContinue routed straight here (skipping plan). The latest
  // ToolMessage has the answer — surface its `message` field as the
  // user-facing reply. No LLM in the loop.
  if (state.extractionResult?.kind === 'complete') {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (isToolMessage(m) && typeof m.content === 'string') {
        const userMessage = extractToolUserMessage(m.content);
        if (userMessage) {
          return { messages: [new AIMessage(userMessage)] };
        }
        break;
      }
    }
    // Fallback: tool didn't set a `message`. Use distilled facts so the
    // user still sees something useful instead of "I had nothing to say".
    if (state.lastToolFacts.length > 0) {
      return { messages: [new AIMessage(state.lastToolFacts.join('\n'))] };
    }
  }

  return {};
}

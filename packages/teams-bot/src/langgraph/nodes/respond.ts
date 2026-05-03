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
//
// In all cases, this node doesn't call any LLM — it just identifies
// what to send. The actual sendActivity happens in runner.ts (after
// graph.invoke returns) so we have access to the Teams TurnContext.

import { AIMessage } from '@langchain/core/messages';
import { CLARIFICATION_BY_TOOL } from '../../intent/clarification-templates.js';
import { buildDisambiguationCard } from '../../intent/disambiguation-card.js';
import type { State } from '../state.js';

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
    if (!(last instanceof AIMessage) || last.content !== state.triageSignals.clarificationQuestion) {
      return {
        messages: [new AIMessage(state.triageSignals.clarificationQuestion)],
      };
    }
  }
  return {};
}

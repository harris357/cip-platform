// Slice 45 + 46c: executeTool node — invokes each tool call in the latest
// AIMessage via the existing executeTool() wrapper.
//
// Defenses:
//   1. Reject calls to tools NOT in current candidateTools (hallucination
//      guard). Returns a ToolMessage with `{refused: 'unknown_tool'}`.
//   2. Distill each result into a 1-line fact for state.lastToolFacts.
//
// 46c part 3: when the planner emits multiple tool_calls in one
// AIMessage, run them in parallel via Promise.all. They're independent
// HTTP calls; serial execution wastes wall-clock. Tool-result join is
// by tool_call_id, not array index, so emit order doesn't matter.
//
// Server-side assertPermission remains the security gate; this node is
// the UX-layer hallucination guard.

import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { executeTool } from '../../mcp/tool-executor.js';
import { distillFact } from '../util/distill.js';
import type { State } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

export function makeExecuteToolNode(ctx: BotAuthContext) {
  return async function executeToolNode(state: State): Promise<Partial<State>> {
    const last = state.messages[state.messages.length - 1];
    if (!(last instanceof AIMessage) || !last.tool_calls?.length) {
      return {};
    }

    // 46c part 3: parallel tool execution. Use Promise.all so that
    // independent tool_calls overlap. Each per-tool error is caught
    // inside the map; the outer promise should never reject.
    const settled = await Promise.all(
      last.tool_calls.map(async (call): Promise<{ tool: ToolMessage; fact: string }> => {
        const known = state.candidateTools.find(t => t.name === call.name);
        if (!known) {
          return {
            tool: new ToolMessage({
              tool_call_id: call.id ?? '',
              content:      JSON.stringify({ refused: 'unknown_tool', name: call.name }),
            }),
            fact: `${call.name} refused: unknown_tool (not in permitted catalog)`,
          };
        }
        try {
          const result = await executeTool(call.name, (call.args ?? {}) as Record<string, unknown>, ctx);
          return {
            tool: new ToolMessage({
              tool_call_id: call.id ?? '',
              content:      typeof result === 'string' ? result : JSON.stringify(result),
            }),
            fact: distillFact(call.name, result),
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            tool: new ToolMessage({
              tool_call_id: call.id ?? '',
              content:      JSON.stringify({ refused: 'execution_error', name: call.name, error: msg }),
            }),
            fact: `${call.name} threw: ${msg}`,
          };
        }
      }),
    );

    return {
      messages:      settled.map(r => r.tool),
      lastToolFacts: settled.map(r => r.fact),
    };
  };
}

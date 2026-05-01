// Slice 45: executeTool node — invokes each tool call in the latest
// AIMessage via the existing executeTool() wrapper.
//
// Defenses:
//   1. Reject calls to tools NOT in current candidateTools (hallucination
//      guard). Returns a ToolMessage with `{refused: 'unknown_tool'}`.
//   2. Distill each result into a 1-line fact for state.lastToolFacts.
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

    const out: ToolMessage[] = [];
    const facts: string[] = [];

    for (const call of last.tool_calls) {
      const known = state.candidateTools.find(t => t.name === call.name);
      if (!known) {
        out.push(new ToolMessage({
          tool_call_id: call.id ?? '',
          content:      JSON.stringify({ refused: 'unknown_tool', name: call.name }),
        }));
        facts.push(`${call.name} refused: unknown_tool (not in permitted catalog)`);
        continue;
      }
      try {
        const result = await executeTool(call.name, (call.args ?? {}) as Record<string, unknown>, ctx);
        out.push(new ToolMessage({
          tool_call_id: call.id ?? '',
          content:      typeof result === 'string' ? result : JSON.stringify(result),
        }));
        facts.push(distillFact(call.name, result));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        out.push(new ToolMessage({
          tool_call_id: call.id ?? '',
          content:      JSON.stringify({ refused: 'execution_error', name: call.name, error: msg }),
        }));
        facts.push(`${call.name} threw: ${msg}`);
      }
    }

    return {
      messages:      out,
      lastToolFacts: facts,
    };
  };
}

// Slice 55: grammarRoute graph node — runs FIRST after ingest.
//
// Workflow:
//   1. Tunable check: lg.grammar_router_enabled. If false → no-op
//      (returns null) so the graph falls through to triage.
//   2. matchGrammar(text). No match → no-op.
//   3. Look up the extractor for the matched tool. No extractor → no-op.
//   4. extractor.extract(...). Returns one of:
//      - complete   — synthesize an AIMessage with tool_calls so the
//                     execute node consumes it. Skip the planner.
//      - ambiguous  — no AIMessage; routeAfterGrammar sends to respond
//                     for disambiguation card rendering.
//      - missing    — no AIMessage; routeAfterGrammar sends to respond
//                     for templated clarification.
//      - no_match   — fall through.
//
// Hard rule: no turn fails because of this node. Errors → log + return
// null → graph falls through to triage normally.

import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { matchGrammar } from '../../intent/grammar/patterns.js';
import { EXTRACTORS } from '../../intent/extractors/index.js';
import { getTunables, getTunable } from '../tunables.js';
import { getPool } from '../../db/pool.js';
import type { State } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

export function makeGrammarRouteNode(ctx: BotAuthContext) {
  return async function grammarRouteNode(state: State): Promise<Partial<State>> {
    try {
      const tunables = await getTunables(state.tenantId);
      const enabled = getTunable<boolean>(tunables, 'lg.grammar_router_enabled', false);
      if (!enabled) {
        return { grammarMatch: null, extractionResult: null };
      }

      const matched = matchGrammar(state.latestUserText);
      if (!matched) {
        return { grammarMatch: null, extractionResult: { kind: 'no_match' } };
      }

      const extractor = EXTRACTORS[matched.toolName];
      if (!extractor) {
        // Grammar pattern points to a tool with no extractor — log + fall through.
        console.warn(`[grammar-route] pattern=${matched.name} → tool=${matched.toolName} but no extractor registered`);
        return { grammarMatch: null, extractionResult: { kind: 'no_match' } };
      }

      const result = await extractor.extract(state.latestUserText, ctx, { pool: getPool() });

      if (result.kind === 'complete') {
        // Synthesize the AIMessage(tool_calls) so execute node fires the tool.
        const toolCallId = `grammar_${randomUUID().slice(0, 8)}`;
        const ai = new AIMessage({
          content: '',
          tool_calls: [{
            id:   toolCallId,
            name: matched.toolName,
            args: result.args,
          }],
        });
        console.log(`[grammar-route] EMITTED pattern=${matched.name} tool=${matched.toolName} call_id=${toolCallId} prior_msg_count=${state.messages.length}`);
        return {
          grammarMatch:     { name: matched.name, toolName: matched.toolName },
          extractionResult: result,
          messages:         [ai],
        };
      }

      // ambiguous / missing / no_match → no synthesized AIMessage; respond
      // node consumes extractionResult.
      return {
        grammarMatch:     { name: matched.name, toolName: matched.toolName },
        extractionResult: result,
      };
    } catch (err) {
      console.warn(`[grammar-route] failed: ${err instanceof Error ? err.message : String(err)}`);
      return { grammarMatch: null, extractionResult: { kind: 'no_match' } };
    }
  };
}

/**
 * Routing edge from grammarRoute:
 *   - extractionResult complete   → execute (we synthesized AIMessage with tool_calls)
 *   - extractionResult ambiguous  → respond (disambiguation card)
 *   - extractionResult missing    → respond (templated clarification)
 *   - extractionResult no_match   → triage (existing path)
 *   - grammarMatch null + extractionResult null → triage (router disabled or errored)
 */
export function routeAfterGrammar(state: State): 'execute' | 'respond' | 'triage' {
  const r = state.extractionResult;
  const last = state.messages[state.messages.length - 1];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastInfo = last ? `${(last as any)._getType?.() ?? 'unknown'}/tc=${(last as any).tool_calls?.length ?? 0}` : 'none';
  console.log(`[route-after-grammar] extractionResult=${r?.kind ?? 'null'} msg_count=${state.messages.length} last=${lastInfo}`);
  if (!r || r.kind === 'no_match') return 'triage';
  if (r.kind === 'complete')        return 'execute';
  return 'respond';   // ambiguous OR missing both render via respond
}

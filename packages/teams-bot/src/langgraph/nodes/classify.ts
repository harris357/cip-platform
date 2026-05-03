// Slice 56: classify graph node — calls the intent-classifier service
// AFTER ingest, AFTER grammarRoute (Slice 55), but BEFORE triage.
//
// Routing decisions (in priority order — high specificity first):
//   1. lg.classifier_enabled = false       → fallthrough (no-op)
//   2. service unreachable / timeout       → fallthrough
//   3. confidence < lg.classifier_uncertain_threshold → fallthrough
//   4. confidence >= lg.classifier_uncertain_threshold AND
//      next_action='clarify'               → respond (templated, no LLM)
//      next_action='call_tool' AND extractor exists AND extraction='complete'
//                                          → execute (skip planner)
//      next_action='call_tool' AND ambiguous → respond (disambiguation card)
//      next_action='call_tool' AND missing → narrow_plan (single-tool planner call)
//      else                                → fallthrough
//
// Phase 1 of rollout: regardless of the above, ALWAYS return
// fallthrough — record everything for shadow analysis. Flip to honoring
// the decisions tenant-by-tenant after observing 1-2 weeks of data.

import { randomUUID } from 'node:crypto';
import { AIMessage } from '@langchain/core/messages';
import { classifyMessage, type ClassifierPrediction } from '../../intent/classifier-client.js';
import { EXTRACTORS } from '../../intent/extractors/index.js';
import { CLARIFICATION_BY_TOOL } from '../../intent/clarification-templates.js';
import { buildDisambiguationCard } from '../../intent/disambiguation-card.js';
import { getTunables, getTunable } from '../tunables.js';
import { tryGetPool } from '../../db/pool.js';
import type { State } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';
import type { ExtractionResult } from '../../intent/extractors/types.js';

export type ClassifierDecision =
  | 'fallthrough'   // ignore prediction, run triage as today
  | 'clarify'       // templated clarification, no LLM
  | 'skip'          // deterministic execute, no LLM (extractor returned complete)
  | 'disambiguate'  // disambiguation card, no LLM (extractor returned ambiguous)
  | 'narrow_plan'   // narrow planner call (extractor missing args)
  ;

export function makeClassifyNode(ctx: BotAuthContext) {
  return async function classifyNode(state: State): Promise<Partial<State>> {
    // ── Skip classifier entirely if grammar router already handled this turn.
    // (Slice 55 grammar node sets extractionResult; if it's anything other
    // than no_match/null, the graph routed elsewhere already and we shouldn't
    // be here. Defensive bail.)
    if (state.extractionResult && state.extractionResult.kind !== 'no_match') {
      return { classifierPrediction: null, classifierDecision: 'fallthrough' };
    }

    try {
      const tunables = await getTunables(state.tenantId);
      const enabled = getTunable<boolean>(tunables, 'lg.classifier_enabled', false);
      if (!enabled) {
        return { classifierPrediction: null, classifierDecision: 'fallthrough' };
      }

      const serviceUrl = getTunable<string>(tunables, 'lg.classifier_service_url',
        'http://intent-classifier.cip-app.svc.cluster.local:8000');
      const timeoutMs  = getTunable<number>(tunables, 'lg.classifier_timeout_ms', 500);
      const uncertain  = getTunable<number>(tunables, 'lg.classifier_uncertain_threshold', 0.65);
      const honorDecisions = getTunable<boolean>(tunables, 'lg.classifier_honor_decisions', false);

      const pred = await classifyMessage({
        serviceUrl, text: state.latestUserText,
        tenantId: state.tenantId, turnId: state.turnId,
        timeoutMs,
      });

      if (!pred || pred.confidence < uncertain) {
        // Shadow mode: record but fall through.
        return { classifierPrediction: pred, classifierDecision: 'fallthrough' };
      }

      // Phase 1 (default): honorDecisions=false → record + fallthrough.
      if (!honorDecisions) {
        return { classifierPrediction: pred, classifierDecision: 'fallthrough' };
      }

      // ── honorDecisions=true: flip to actively routing on classifier output

      // 'clarify' → templated clarification (no LLM)
      if (pred.next_action === 'clarify') {
        const tplKey = pred.tool ?? `intent:${pred.intent}`;
        const tpl = CLARIFICATION_BY_TOOL[pred.tool ?? ''];
        const reply = tpl
          ? tpl()
          : `Could you tell me more about what you'd like to do? (intent guess: ${pred.intent})`;
        return {
          classifierPrediction: pred,
          classifierDecision:   'clarify',
          messages:             [new AIMessage(reply)],
        };
      }

      // 'call_tool' → run extractor (if registered) and route accordingly
      if (pred.next_action === 'call_tool' && pred.tool) {
        const extractor = EXTRACTORS[pred.tool];
        if (!extractor) {
          // No extractor — fall through to narrow_plan path so the planner can fill args.
          return {
            classifierPrediction: pred,
            classifierDecision:   'narrow_plan',
            // narrow planner consumes classifierPrediction.tool to narrow the catalog
          };
        }

        const pool = tryGetPool();
        if (!pool) {
          // Can't run extractor without DB → fall through.
          return { classifierPrediction: pred, classifierDecision: 'fallthrough' };
        }

        const result: ExtractionResult = await extractor.extract(state.latestUserText, ctx, { pool });

        if (result.kind === 'complete') {
          // Synthesize an AIMessage(tool_calls) for execute node to consume.
          const toolCallId = `classify_${randomUUID().slice(0, 8)}`;
          const ai = new AIMessage({
            content: '',
            tool_calls: [{
              id:   toolCallId,
              name: pred.tool,
              args: result.args,
            }],
          });
          return {
            classifierPrediction: pred,
            classifierDecision:   'skip',
            extractionResult:     result,
            messages:             [ai],
          };
        }
        if (result.kind === 'ambiguous') {
          const card = buildDisambiguationCard({
            prompt:      'Which one did you mean?',
            toolName:    pred.tool,
            argName:     result.argName,
            partialArgs: {},
            candidates:  result.candidates,
          });
          return {
            classifierPrediction: pred,
            classifierDecision:   'disambiguate',
            extractionResult:     result,
            outboundCard:         card,
            messages:             [new AIMessage('Which one did you mean? (your client should show a picker — pick one to proceed)')],
          };
        }
        if (result.kind === 'missing') {
          // Fall through to narrow_plan — planner gets one tool's schema to fill the gap.
          return {
            classifierPrediction: pred,
            classifierDecision:   'narrow_plan',
            extractionResult:     result,
          };
        }
        // no_match — extractor refused; fall through to triage+plan as usual.
        return {
          classifierPrediction: pred,
          classifierDecision:   'fallthrough',
        };
      }

      // 'answer_directly' or 'unknown' → fall through
      return { classifierPrediction: pred, classifierDecision: 'fallthrough' };
    } catch (err) {
      console.warn(`[classify] failed: ${err instanceof Error ? err.message : String(err)}`);
      return { classifierPrediction: null, classifierDecision: 'fallthrough' };
    }
  };
}

/**
 * Routing edge from classify:
 *   - skip / disambiguate / clarify → execute or respond (similar shape to
 *     Slice 55's grammar router)
 *   - narrow_plan → plan (planner sees classifierPrediction.tool and narrows
 *     its tool catalog)
 *   - fallthrough → triage (existing path)
 */
export function routeAfterClassify(state: State): 'execute' | 'respond' | 'plan' | 'triage' {
  const d = state.classifierDecision;
  if (d === 'skip')         return 'execute';
  if (d === 'disambiguate') return 'respond';
  if (d === 'clarify')      return 'respond';
  if (d === 'narrow_plan')  return 'plan';
  return 'triage';
}

// Slice 45 + 46d: typed graph state for the LangGraph runtime.
//
// State = explicit conversational memory. The reducers tell LangGraph
// how to merge node returns into the persisted state. The checkpointer
// (PostgresSaver) persists state per Teams thread.
//
// 46d Part 1: candidateTools removed from state entirely. Each consumer
// node (plan, gateWriteAction, executeTool) calls discoverTools(ctx,
// state.latestUserText) directly — discoverTools caches per
// (tenant, employee) for 5 minutes, so the second call onwards is
// sub-millisecond. Net: zero bytes serialized for the tool catalog
// per checkpoint, no wasted DB I/O across mid-turn writes.

import { type BaseMessage } from '@langchain/core/messages';
import { Annotation, messagesStateReducer } from '@langchain/langgraph';

/**
 * Triage signals. NON-BINDING — the graph uses them to route, but the
 * planner can override (and frequently does — confidence < threshold means
 * "let the planner decide"). Reset each turn by `ingest`.
 */
export interface TriageSignals {
  needsTool:             boolean;
  answerDirectly:        boolean;
  needsClarification:    boolean;
  currentGoal:           string;
  knownEntities:         Record<string, string>;
  confidence:            number;            // 0..1
  clarificationQuestion?: string;
}

/**
 * A write-action tool call awaiting user confirmation. The graph
 * interrupts at the `confirm` node and saves this in state. On the
 * next user message, `ingest` consumes it.
 */
export interface PendingWriteCall {
  toolName:    string;
  toolArgs:    Record<string, unknown>;
  toolCallId:  string;
  summary:     string;   // human-readable: "Disable Jane Smith"
}

export const StateAnnotation = Annotation.Root({
  threadId:        Annotation<string>(),
  tenantId:        Annotation<string>(),
  employeeId:      Annotation<string>(),

  /**
   * Conversational history. messagesStateReducer appends new messages
   * (LangGraph's standard reducer for BaseMessage[]).
   */
  messages:        Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  /**
   * Compact rolling summary of older turns. Empty in Slice 45; Slice 46
   * adds an LLM-driven summarize node.
   */
  summary:         Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  permissions:     Annotation<Record<string, boolean>>({
    reducer: (_prev, next) => next,
    default: () => ({}),
  }),
  roles:           Annotation<string[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),

  triageSignals:   Annotation<TriageSignals | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Persists across the confirm interrupt; cleared on resume. */
  pendingWriteCall: Annotation<PendingWriteCall | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /** Distilled tool-result lines for the current turn. Reset by `ingest`. */
  lastToolFacts:   Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  /** Plan→execute loop guard. Reset to 0 by `ingest`. */
  stepCount:       Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /** Latest user text — used by triage and gate-write heuristics. Reset by `ingest`. */
  latestUserText:  Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  /**
   * Per-turn unique identifier. Generated at runner entry, threaded
   * into every LLM call's Langfuse metadata as `trace_id`, surfaced
   * in the response footer + [turn] log line. Lets a user reference
   * a specific turn in support / debugging — they can paste the ID
   * and we can find the corresponding trace + log lines.
   */
  turnId:          Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),

  /**
   * Slice 48 follow-up: Langfuse session id, scoped to a continuous
   * interaction within a Teams thread. Reset by ingest when the gap
   * since the previous turn exceeds `lg.session_timeout_minutes`.
   * threadId would be a constant-for-the-relationship value; the
   * sessionId gives Langfuse useful "session" grouping.
   */
  sessionId:               Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
  sessionLastActivityAt:   Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),

  /**
   * Slice 55: grammar router + extractor outcomes. `grammarMatch` is
   * which pattern fired (or null); `extractionResult` is the per-tool
   * extractor's verdict. Both are reset each turn — no cross-turn
   * persistence beyond the single-turn duration.
   */
  grammarMatch: Annotation<{ name: string; toolName: string } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  extractionResult: Annotation<import('../intent/extractors/types.js').ExtractionResult | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  /**
   * Slice 55: when respond needs to send an adaptive card (e.g.,
   * disambiguation), it sets this. Runner detects + sends as an
   * attachment instead of a plain-text AIMessage.content.
   */
  outboundCard: Annotation<unknown | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  /**
   * Slice 56: sklearn classifier prediction + the routing decision the
   * classify node made. Recorded in bot_turn_metrics for shadow analysis
   * even when the decision is fallthrough.
   */
  classifierPrediction: Annotation<{
    intent:             string;
    next_action:        string;
    tool:               string | null;
    confidence:         number;
    scores:             Record<string, number>;
    normalized:         string;
    classifier_version: string;
  } | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  classifierDecision: Annotation<
    'fallthrough' | 'clarify' | 'skip' | 'disambiguate' | 'narrow_plan' | null
  >({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
});

export type State = typeof StateAnnotation.State;

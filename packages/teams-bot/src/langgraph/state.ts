// Slice 45: typed graph state for the LangGraph runtime.
//
// State = explicit conversational memory. The reducers tell LangGraph
// how to merge node returns into the persisted state. The checkpointer
// (MemorySaver in this slice) persists state per Teams thread.
//
// IMPORTANT: `candidateTools` is computed-not-persisted. The persisted
// checkpoint always carries an empty array; turn entry re-derives the
// permitted tool set from the current MCP catalog + current ctx.permissions.
// This guarantees a confirm→resume cycle uses the user's CURRENT permitted
// tools, not whatever was permitted when the interrupt fired.

import { type BaseMessage } from '@langchain/core/messages';
import { type Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
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

  /**
   * Computed-not-persisted (see file header). Always re-derived from the
   * live MCP catalog at the start of each turn and on resume.
   */
  candidateTools:  Annotation<McpTool[]>({
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
});

export type State = typeof StateAnnotation.State;

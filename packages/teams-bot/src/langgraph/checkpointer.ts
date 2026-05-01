// Slice 45: in-process checkpointer for the LangGraph runtime.
//
// MemorySaver is a Map keyed by thread_id (Teams conversation ID). State
// survives node-to-node transitions within a turn AND successive turns
// within a pod's lifetime — but NOT pod restarts and NOT multi-replica.
//
// Slice 46 swaps to PostgresSaver via @langchain/langgraph-checkpoint-postgres
// for durable + multi-replica state.

import { MemorySaver } from '@langchain/langgraph';

export const checkpointer = new MemorySaver();

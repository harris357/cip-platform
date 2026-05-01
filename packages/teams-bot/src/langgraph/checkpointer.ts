// Slice 46: durable checkpointer.
//
// PostgresSaver from @langchain/langgraph-checkpoint-postgres replaces the
// in-process MemorySaver. State now survives pod restart and is shared across
// replicas — the same Postgres backing the rest of `cip_hr` is reused.
//
// Hard rules (per slice doc):
//   1. ensureCheckpointerReady() runs once at boot before serving traffic.
//      setup() is idempotent; we cache the promise so concurrent boots don't
//      run it twice.
//   2. Connection string comes from DATABASE_URL_HR — the same env the rest
//      of teams-bot uses for hr-service queries (auth context, channel
//      registry, tunables, etc.).
//   3. candidateTools is reset to [] at turn start (in ingest) so the
//      between-turn checkpoint is small. Per slice 45's "computed-not-
//      persisted" rule.

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';

const POOL_URL = process.env['DATABASE_URL_HR'];
if (!POOL_URL) {
  throw new Error('DATABASE_URL_HR required for LangGraph Postgres checkpointer');
}

export const checkpointer = PostgresSaver.fromConnString(POOL_URL);

let setupPromise: Promise<void> | null = null;
export async function ensureCheckpointerReady(): Promise<void> {
  if (!setupPromise) setupPromise = checkpointer.setup();
  return setupPromise;
}

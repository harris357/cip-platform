// Slice 45: per-Teams-thread engine toggle.
// Slice 47: slash-command parsing extracted to packages/teams-bot/src/slash-commands.
// This file now exposes only the override-state primitives + selectEngine.

import { getTunables, getTunable } from '../langgraph/tunables.js';

export type Engine = 'legacy' | 'langgraph';

const overrides = new Map<string, Engine>();

function key(tenantId: string, threadId: string): string {
  return `${tenantId}:${threadId}`;
}

/**
 * Resolve the active engine for a given (tenant, thread). Three layers:
 *   1. process.env.BOT_FORCE_LANGGRAPH=true — every thread uses LangGraph
 *   2. In-process per-thread override (set via /lg on or /lg off)
 *   3. Per-tenant default from bot_tunables (`lg.default_engine`)
 *   4. Code fallback: 'legacy'
 *
 * Slice 46 will persist (2) to a DB table so overrides survive pod restarts.
 */
export async function selectEngine(tenantId: string, threadId: string): Promise<Engine> {
  if (process.env['BOT_FORCE_LANGGRAPH'] === 'true') return 'langgraph';
  const perThread = overrides.get(key(tenantId, threadId));
  if (perThread) return perThread;
  const tunables = await getTunables(tenantId);
  return getTunable<Engine>(tunables, 'lg.default_engine', 'legacy');
}

/**
 * Set or clear the per-thread engine override. Called by /lg slash
 * command handlers.
 */
export function setEngineOverride(
  tenantId: string,
  threadId: string,
  engine:   Engine,
): void {
  overrides.set(key(tenantId, threadId), engine);
}

// Test-only.
export function _resetEngineOverrides(): void {
  overrides.clear();
}

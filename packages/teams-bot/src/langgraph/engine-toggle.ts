// Slice 45: per-Teams-thread engine toggle. Three layers:
//
//   1. process.env.BOT_FORCE_LANGGRAPH=true → every thread uses LangGraph
//   2. In-process per-(tenant,thread) overrides set by /lg slash commands
//   3. Per-tenant default from bot_tunables `lg.default_engine`
//   4. Code fallback: 'legacy'
//
// In-process overrides die on pod restart — Slice 46 persists them.

import { getTunables, getTunable } from './tunables.js';

export type Engine = 'legacy' | 'langgraph';

const overrides = new Map<string, Engine>();

function key(tenantId: string, threadId: string): string {
  return `${tenantId}:${threadId}`;
}

export async function selectEngine(tenantId: string, threadId: string): Promise<Engine> {
  if (process.env['BOT_FORCE_LANGGRAPH'] === 'true') return 'langgraph';
  const perThread = overrides.get(key(tenantId, threadId));
  if (perThread) return perThread;
  const tunables = await getTunables(tenantId);
  return getTunable<Engine>(tunables, 'lg.default_engine', 'legacy');
}

export interface SlashResult {
  reply: string;
}

/**
 * Returns a SlashResult if the message was a recognized engine slash
 * command (caller should send the reply and short-circuit). Returns
 * null if the message was not a slash command.
 */
export async function handleEngineSlashCommand(
  tenantId: string,
  threadId: string,
  text: string,
): Promise<SlashResult | null> {
  const t = text.trim().toLowerCase();
  if (t === '/lg on' || t === '/langgraph on') {
    overrides.set(key(tenantId, threadId), 'langgraph');
    return { reply: '_Engine: **LangGraph** (this thread). Use `/lg off` to revert._' };
  }
  if (t === '/lg off' || t === '/langgraph off') {
    overrides.set(key(tenantId, threadId), 'legacy');
    return { reply: '_Engine: **legacy** (this thread). Use `/lg on` to switch back._' };
  }
  if (t === '/lg status' || t === '/langgraph status') {
    const current = await selectEngine(tenantId, threadId);
    return { reply: `_Engine: **${current}** (this thread)._` };
  }
  if (t === '/lg help' || t === '/langgraph help') {
    return {
      reply:
        '_LangGraph engine commands:_\n' +
        '- `/lg on` — switch this thread to the LangGraph runtime\n' +
        '- `/lg off` — switch this thread back to the legacy runtime\n' +
        '- `/lg status` — show which engine is active here',
    };
  }
  return null;
}

// Test-only.
export function _resetEngineOverrides(): void {
  overrides.clear();
}

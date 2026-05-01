// Slice 47: /lg engine-toggle handlers. Refactored from the inline
// handleEngineSlashCommand in engine-toggle.ts. The override storage
// (Map) and selectEngine() stay in engine-toggle.ts; only the slash
// parsing moves here so it lives next to the other slash handlers.

import {
  setEngineOverride,
  selectEngine,
} from '../../intent/engine-toggle.js';
import type { SlashCommandHandlerArgs, SlashCommandResult } from '../registry.js';

export async function lgOnHandler(
  args: SlashCommandHandlerArgs,
): Promise<SlashCommandResult> {
  setEngineOverride(args.ctx.tenantId, args.threadId, 'langgraph');
  return {
    reply: '_Engine: **LangGraph** (this thread). Use `/lg off` to revert._',
  };
}

export async function lgOffHandler(
  args: SlashCommandHandlerArgs,
): Promise<SlashCommandResult> {
  setEngineOverride(args.ctx.tenantId, args.threadId, 'legacy');
  return {
    reply: '_Engine: **legacy** (this thread). Use `/lg on` to switch back._',
  };
}

export async function lgStatusHandler(
  args: SlashCommandHandlerArgs,
): Promise<SlashCommandResult> {
  const current = await selectEngine(args.ctx.tenantId, args.threadId);
  return {
    reply: `_Engine: **${current}** (this thread)._`,
  };
}

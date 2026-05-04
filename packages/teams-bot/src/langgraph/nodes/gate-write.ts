// Slice 45: gateWriteAction node + its routing edge function.
//
// For each tool call in the latest AIMessage, look up the tool's
// sideEffectLevel annotation:
//   - 'none' | 'read' | undefined → safe; proceed to executeTool
//   - 'write' | 'external'        → check isExplicitlyAuthorized; if not
//                                    authorized, store as pendingWriteCall
//                                    and route to confirm.
//
// If a turn produces multiple tool_calls and ANY is write/external, the
// first such call gets gated. After confirm/resume, that single call
// runs; subsequent tool_calls would be re-emitted by the planner on the
// next plan iteration if still relevant.

import { AIMessage } from '@langchain/core/messages';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { isExplicitlyAuthorized } from '../util/authorize-write.js';
import { discoverTools } from '../../mcp/tool-discovery.js';
import { getTunables, getTunable } from '../tunables.js';
import { isAIMessage } from '../util/message-types.js';
import type { State, PendingWriteCall } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

function getSideEffect(tool: McpTool | undefined): string {
  if (!tool) return 'read';
  const ann = (tool.annotations as Record<string, unknown> | undefined) ?? {};
  const level = ann['sideEffectLevel'];
  return typeof level === 'string' ? level : 'read';
}

function summarize(toolName: string, args: Record<string, unknown>): string {
  // Compact human-readable summary for the confirm prompt.
  const argStr = Object.entries(args)
    .filter(([_, v]) => v !== undefined && v !== null)
    .slice(0, 3)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(', ');
  return `${toolName}(${argStr})`;
}

/**
 * gateWriteAction is a NODE that may stage a pendingWriteCall but always
 * returns. The conditional edge `routeAfterGate` does the actual routing.
 *
 * 46d: factory now takes ctx so we can call discoverTools — candidateTools
 * is no longer in state. discoverTools is cached 5-min per tenant+employee
 * so this is sub-ms after warmup.
 */
export function makeGateWriteActionNode(ctx: BotAuthContext) {
  return async function gateWriteActionNode(state: State): Promise<Partial<State>> {
  const last = state.messages[state.messages.length - 1];
  if (!isAIMessage(last) || !last.tool_calls?.length) {
    return {};   // No tool calls — nothing to gate.
  }

  const tunables = await getTunables(state.tenantId);
  const verbs = getTunable<string[]>(
    tunables, 'lg.authorized_write_verbs',
    ['disable', 'off-board', 'offboard', 'create', 'add', 'assign', 'grant', 'revoke', 'remove', 'fire', 'approve', 'reject'],
  );

  const candidateTools = await discoverTools(ctx, state.latestUserText);

  for (const call of last.tool_calls) {
    const tool = candidateTools.find(t => t.name === call.name);
    const level = getSideEffect(tool);
    if (level !== 'write' && level !== 'external') continue;

    const authorized = isExplicitlyAuthorized({
      userText:        state.latestUserText,
      toolArgs:        (call.args ?? {}) as Record<string, unknown>,
      authorizedVerbs: verbs,
    });
    if (authorized) continue;

    // Stage this as the pending call. First one wins.
    const pending: PendingWriteCall = {
      toolName:   call.name,
      toolArgs:   (call.args ?? {}) as Record<string, unknown>,
      toolCallId: call.id ?? `call_${Date.now()}`,
      summary:    summarize(call.name, (call.args ?? {}) as Record<string, unknown>),
    };
    return { pendingWriteCall: pending };
  }
  return {};
  };
}

/**
 * Routing edge from gateWriteAction:
 *   - pendingWriteCall set → 'confirm'
 *   - last AIMessage has tool_calls → 'execute'
 *   - otherwise (no tool calls)     → 'respond'
 */
export function routeAfterGate(state: State): 'confirm' | 'execute' | 'respond' {
  if (state.pendingWriteCall) return 'confirm';
  const last = state.messages[state.messages.length - 1];
  if (isAIMessage(last) && last.tool_calls && last.tool_calls.length > 0) {
    return 'execute';
  }
  return 'respond';
}

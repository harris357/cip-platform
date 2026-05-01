// Slice 45: discoverCandidates node — re-derives the permitted tool set
// for this turn. Wraps the existing discoverTools() which handles:
//   - Permission filter (via tool.annotations.requiredPermission)
//   - Slice 44 vector retrieval (top-K narrowing)
//
// Always re-runs at turn start AND on resume from a confirm interrupt
// (per Slice 45 hard rule: candidateTools is computed-not-persisted).

import type { State } from '../state.js';
import { discoverTools } from '../../mcp/tool-discovery.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';

export function makeDiscoverCandidatesNode(ctx: BotAuthContext) {
  return async function discoverCandidates(state: State): Promise<Partial<State>> {
    const tools = await discoverTools(ctx, state.latestUserText);
    return { candidateTools: tools };
  };
}

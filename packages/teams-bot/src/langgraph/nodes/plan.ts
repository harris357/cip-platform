// Slice 45: plan node — the strong-model planner.
//
// Two outcomes:
//   1. AIMessage with tool_calls → graph routes to gateWriteAction
//   2. AIMessage with content only → graph routes to respond
//
// Tool definitions go via the OpenAI function-calling `tools` parameter
// (Channel 1). Operational metadata (whenToUse / whenNotToUse / output
// shape / commonNextTools) goes into the system prompt as the
// {{ tool_reference }} variable (Channel 2).

import { AIMessage, type SystemMessage } from '@langchain/core/messages';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { callLLM, createLiteLLMClient, getPrompt } from '@cip/shared';
import { resolveAlias } from '../../intent/alias-resolver.js';
import { discoverTools } from '../../mcp/tool-discovery.js';
import { messagesToOpenAI } from '../util/messages.js';
import { formatToolReference } from '../util/tool-reference.js';
import { getTunables, getTunable } from '../tunables.js';
import type { State } from '../state.js';
import type { BotAuthContext } from '../../auth/resolve-context.js';
import { SystemMessage as SysMsg } from '@langchain/core/messages';

interface ChatToolDef {
  type:     'function';
  function: {
    name:        string;
    description: string;
    parameters:  Record<string, unknown>;
  };
}

function toChatTool(t: McpTool): ChatToolDef {
  // Short description for Channel 1 — first sentence only. Full operational
  // metadata is in the system prompt (Channel 2).
  const desc = (t.description ?? '').split('. ')[0] ?? t.name;
  return {
    type: 'function',
    function: {
      name:        t.name,
      description: desc,
      parameters:  (t.inputSchema ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    },
  };
}

export function makePlanNode(ctx: BotAuthContext) {
  return async function plan(state: State): Promise<Partial<State>> {
    const tunables = await getTunables(state.tenantId);
    const maxRecent = getTunable<number>(tunables, 'lg.max_recent_messages', 8);

    const alias  = await resolveAlias({ purpose: 'route', tenantId: state.tenantId });
    const prompt = await getPrompt({ name: 'bot.plan', tenantId: state.tenantId });
    const client = createLiteLLMClient({
      tenantId:   state.tenantId,
      virtualKey: ctx.tenantConfig.litellmVirtualKey,
    });

    // 46d: candidateTools no longer in state; recompute via the cached
    // discovery call (5-min TTL per tenant+employee, sub-ms after warmup).
    let candidateTools = await discoverTools(ctx, state.latestUserText);

    // Slice 56I: when the classifier decision was 'narrow_plan', filter
    // the candidate tools down to JUST the predicted tool's schema.
    // Saves ~5-15× prompt tokens on these turns. The original Slice 56
    // promised this but the implementation never landed — until now,
    // 'narrow_plan' was just a metric label with no behavioral effect.
    //
    // If the predicted tool is no longer in the candidate set (revoked
    // permission, deprecated, etc.), fall back to the full catalog
    // rather than presenting the planner with an empty tool list.
    if (state.classifierDecision === 'narrow_plan' && state.classifierPrediction?.tool) {
      const targetTool = state.classifierPrediction.tool;
      const narrowed = candidateTools.filter(t => t.name === targetTool);
      if (narrowed.length > 0) {
        console.log(`[plan] narrow_plan active: tool=${targetTool} (was ${candidateTools.length} candidates)`);
        candidateTools = narrowed;
      } else {
        console.warn(`[plan] narrow_plan requested ${targetTool} but not in candidate catalog — using full set`);
      }
    }

    const systemContent = prompt.compile({
      currentGoal:    state.triageSignals?.currentGoal ?? '',
      facts:          state.lastToolFacts,
      summary:        state.summary,
      tool_reference: formatToolReference(candidateTools),
      latest:         state.latestUserText,
    });
    const systemMsg: SystemMessage = new SysMsg(systemContent);

    // Trim history to the last N messages, then prepend the system message.
    // After the slice, drop any leading ToolMessages: their parent
    // AIMessage(tool_calls) may have been sliced out, leaving the tool_call_id
    // reference dangling. Mistral rejects this with
    //   "Unexpected role 'tool' after role 'system'"
    // because the canonical chat-completion shape requires every tool message
    // to follow an assistant message that carries the matching tool_calls.
    let trimmed = state.messages.slice(-maxRecent);
    while (trimmed.length > 0 && trimmed[0]!.getType() === 'tool') {
      trimmed = trimmed.slice(1);
    }
    const messages = messagesToOpenAI([systemMsg, ...trimmed]);

    const tools = candidateTools.map(toChatTool);

    const resp = await callLLM(client, {
      model:        alias,
      messages,
      ...(tools.length > 0 ? { tools, tool_choice: 'auto' as const } : {}),
      temperature:  0.2,
      max_tokens:   2048,
      purpose:      'bot.plan',
      promptHandle: prompt,
      tenantId:     state.tenantId,
      sessionId:    state.sessionId,
    });

    const choice = resp.choices[0]?.message;
    if (!choice) {
      // No completion — emit a graceful AIMessage so respond can send something.
      return {
        messages:  [new AIMessage('Sorry, I couldn\'t generate a response. Please try again.')],
        stepCount: state.stepCount + 1,
      };
    }

    const ai = new AIMessage({
      content: choice.content ?? '',
      tool_calls: choice.tool_calls?.length
        ? choice.tool_calls
            .filter((tc): tc is Extract<typeof tc, { type: 'function' }> => tc.type === 'function')
            .map((tc, i) => ({
              id:   tc.id ?? `call_${i}`,
              name: tc.function.name,
              args: safeParseArgs(tc.function.arguments),
            }))
        : [],
    });

    return {
      messages:  [ai],
      stepCount: state.stepCount + 1,
    };
  };
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

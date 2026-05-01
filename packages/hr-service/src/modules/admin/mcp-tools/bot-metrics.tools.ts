// Slice 46e: five admin MCP tools that wrap the most common queries
// against `bot_turn_metrics`. All gated on `bot.metrics.read`. Read-only,
// tenant-scoped, bounded result size.
//
// Surfaces in Teams via the planner picking them naturally + via the
// `/turn <id>` slash command (which calls bot_metrics_get_turn directly).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getPool } from '../../../db/index.js';
import {
  assertPermission,
  extractAuthContext,
  PermissionDeniedError,
} from '../../../mcp-server/auth.js';
import { ok, refused } from '../../employees/mcp-tools/_envelope.js';
import {
  parseSince,
  getTurn,
  getSummary,
  getTopN,
  getToolUsage,
  getOutliers,
} from '../../../db/queries/bot-turn-metrics.js';

const REQUIRED = 'bot.metrics.read';

function langfuseTraceUrl(turnId: string): string {
  // Langfuse 5.x trace IDs aren't our turnIds; the cleanest deep-link is
  // a search by metadata.turnId. Falls back to the bare host if env is
  // missing.
  const host = process.env['LANGFUSE_HOST'] ?? 'https://cloud.langfuse.com';
  return `${host}/traces?search=${encodeURIComponent(turnId)}`;
}

async function gate(authInfo: unknown): Promise<{ tenantId: string } | { refusal: ReturnType<typeof refused> }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = extractAuthContext(authInfo as any);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await assertPermission(authInfo as any, REQUIRED);
  } catch (err) {
    if (err instanceof PermissionDeniedError) {
      return { refusal: refused('permission_denied', err.message) };
    }
    throw err;
  }
  return { tenantId: ctx.tenantId };
}

// ─── 1. bot_metrics_get_turn ──────────────────────────────────────────

export function registerBotMetricsGetTurn(server: McpServer): void {
  server.tool(
    'bot_metrics_get_turn',
    'Drill into a single bot turn by its 8-char turn_id. ' +
    'Scope: one turn from this tenant. Audience: HR admins (gated on bot.metrics.read). ' +
    'Output: full bot_turn_metrics row + a Langfuse trace URL. ' +
    'Use when an admin pasted a turn_id, clicked the inline turn-debug footer, or asked "what happened on turn X". ' +
    'Differs from bot_metrics_summary (aggregate) and bot_metrics_top_n (slowest list).',
    { turn_id: z.string().regex(/^[0-9a-f]{8}$/, 'turn_id must be 8 hex chars') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'User pasted or clicked a turn_id from the response footer ("turn=<id>")',
        'Admin debugging a complaint about one specific turn',
      ],
      whenNotToUse: [
        'User wants aggregate stats — use bot_metrics_summary',
        'User wants top-N slow turns — use bot_metrics_top_n',
      ],
      commonNextTools: ['bot_metrics_summary'],
      outputSchema: {
        type: 'object', required: ['data'],
        properties: { data: { type: 'object' } },
      },
    } as any,
    async ({ turn_id }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      const row = await getTurn(getPool(), { tenantId: g.tenantId, turnId: turn_id });
      if (!row) return refused('not_found', `turn ${turn_id} not found in this tenant's metrics`);
      return ok({
        ...row,
        langfuse_url: langfuseTraceUrl(turn_id),
      }, `Turn ${turn_id}`);
    },
  );
}

// ─── 2. bot_metrics_summary ───────────────────────────────────────────

export function registerBotMetricsSummary(server: McpServer): void {
  server.tool(
    'bot_metrics_summary',
    'Aggregate health of the bot for this tenant over a time window. ' +
    'Scope: tenant-wide. Audience: HR admins. ' +
    'Output: {turns, latency percentiles, intent mix, refusal/confirmation/resume rates}. ' +
    'Use to answer "how is the bot doing this week" or to baseline before a deploy. ' +
    'Differs from bot_metrics_top_n (specific turns) and bot_metrics_outliers (flagged turns only).',
    { since: z.enum(['1h', '6h', '24h', '7d', '30d']) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "how is the bot doing" / "any latency issues today" / "show metrics"',
        'Before a deploy, to baseline; after a deploy, to compare',
      ],
      whenNotToUse: [
        'User wants a specific turn — use bot_metrics_get_turn',
        'User wants the slowest N — use bot_metrics_top_n',
      ],
      commonNextTools: ['bot_metrics_top_n', 'bot_metrics_outliers'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ since }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      try {
        const window = parseSince(since);
        const row = await getSummary(getPool(), { tenantId: g.tenantId, since: window });
        return ok({ since: window, ...row }, `Bot metrics for ${window}`);
      } catch (err) {
        return refused('bad_args', err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ─── 3. bot_metrics_top_n ─────────────────────────────────────────────

export function registerBotMetricsTopN(server: McpServer): void {
  server.tool(
    'bot_metrics_top_n',
    'Top-N turns ranked by latency or step count. ' +
    'Scope: tenant. Audience: HR admins. ' +
    'Output: list of turns with turn_id (drillable) + key metrics. ' +
    'Use for "show me the slowest turns this week" or "any planner-loop pattern". ' +
    'Differs from bot_metrics_outliers (flagged with reasons) and bot_metrics_summary (aggregate).',
    {
      since:  z.enum(['1h', '6h', '24h', '7d', '30d']),
      metric: z.enum(['total_ms', 'graph_ms', 'step_count']).default('total_ms'),
      limit:  z.number().int().min(1).max(50).default(10),
      intent: z.enum(['ask', 'direct', 'tool', 'unknown']).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "show me the slowest turns" / "biggest planner loops" / "what took the longest"',
      ],
      whenNotToUse: [
        'User wants flagged outliers (multiple reasons) — use bot_metrics_outliers',
      ],
      commonNextTools: ['bot_metrics_get_turn', 'bot_metrics_outliers'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ since, metric, limit, intent }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      try {
        const window = parseSince(since);
        const rows = await getTopN(getPool(), {
          tenantId: g.tenantId,
          since:    window,
          metric,
          limit,
          intent,
        });
        return ok({ since: window, metric, limit, intent: intent ?? null, turns: rows },
                  `Top ${limit} by ${metric}`);
      } catch (err) {
        return refused('bad_args', err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ─── 4. bot_metrics_tools ─────────────────────────────────────────────

export function registerBotMetricsTools(server: McpServer): void {
  server.tool(
    'bot_metrics_tools',
    'Per-tool breakdown of bot activity over a window. ' +
    'Scope: tenant. Audience: HR admins. ' +
    'Output: array of {tool, calls, refusals, avg_graph_ms, p95_graph_ms} sorted by call count. ' +
    'Use for "which tools are most used" or "which tools are slow / failing". ' +
    'Differs from bot_metrics_top_n (specific turns) and bot_metrics_summary (aggregate-not-per-tool).',
    { since: z.enum(['1h', '6h', '24h', '7d', '30d']) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "which tools are getting used" / "is tool X slow" / "are any tools failing"',
      ],
      whenNotToUse: [
        'User wants a specific turn — use bot_metrics_get_turn',
      ],
      commonNextTools: ['bot_metrics_top_n', 'bot_metrics_outliers'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ since }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      try {
        const window = parseSince(since);
        const rows = await getToolUsage(getPool(), { tenantId: g.tenantId, since: window });
        return ok({ since: window, tools: rows }, `Tool usage for ${window}`);
      } catch (err) {
        return refused('bad_args', err instanceof Error ? err.message : String(err));
      }
    },
  );
}

// ─── 5. bot_metrics_outliers ──────────────────────────────────────────

export function registerBotMetricsOutliers(server: McpServer): void {
  server.tool(
    'bot_metrics_outliers',
    'Flagged turns within a window: refused tools, high step count, low triage confidence, latency above the period p95, or abandoned confirms. ' +
    'Scope: tenant. Audience: HR admins. ' +
    'Output: list of turns each tagged with one or more reason codes. ' +
    'Use for "anything weird today" / "any incidents". ' +
    'Differs from bot_metrics_top_n (single-axis) and bot_metrics_summary (aggregate, no per-turn detail).',
    { since: z.enum(['1h', '6h', '24h', '7d', '30d']) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'User asks "anything weird" / "any failures" / "did anything go wrong today"',
      ],
      whenNotToUse: [
        'User wants raw slowest list — use bot_metrics_top_n',
      ],
      commonNextTools: ['bot_metrics_get_turn'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ since }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      try {
        const window = parseSince(since);
        const rows = await getOutliers(getPool(), { tenantId: g.tenantId, since: window });
        return ok({ since: window, outliers: rows }, `Outliers for ${window}`);
      } catch (err) {
        return refused('bad_args', err instanceof Error ? err.message : String(err));
      }
    },
  );
}

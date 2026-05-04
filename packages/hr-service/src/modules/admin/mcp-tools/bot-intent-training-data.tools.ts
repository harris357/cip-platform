// Slice 56B: MCP tools for bot_intent_training_data + model lifecycle.
//
// Renamed from bot-intent-examples.tools.ts alongside the table rename.
// All tools gated on bot.metrics.read (same admin permission as /turn).
//
// Tools:
//   - bot_intent_training_data_add              — used by /teach and "Add to training set"
//   - bot_intent_training_data_list_unreviewed  — used by `make training-data-review`
//   - bot_intent_model_runs_list                — list recent model runs (Slice 56B)
//   - bot_intent_classifier_status              — latest run + untrained-row count (Slice 56B)
//
// Tenant-scoped where the data is per-tenant; bot_intent_model_runs is
// platform-wide (one model serves all tenants in v1) so model_runs_list
// returns global state but bot_intent_classifier_status reports
// untrained-row count for the calling tenant by default.

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
  addTrainingData,
  listUnreviewed,
  listModelRuns,
  countUntrainedSinceLatest,
} from '../../../db/queries/bot-intent-training-data.js';

const REQUIRED = 'bot.metrics.read';

async function gate(authInfo: unknown): Promise<{ tenantId: string; employeeId: string } | { refusal: ReturnType<typeof refused> }> {
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
  return { tenantId: ctx.tenantId, employeeId: ctx.employeeId };
}

export function registerBotIntentTrainingDataAdd(server: McpServer): void {
  server.tool(
    'bot_intent_training_data_add',
    'Append a labelled training row to bot_intent_training_data for the calling tenant. ' +
    'Scope: tenant. Audience: HR admins (gated on bot.metrics.read). ' +
    'Used by the /teach slash command and the "Add to training set" action on /turn cards. ' +
    'Output: { id, reviewed: false }. The row is held in a review queue until an admin marks it reviewed via `make training-data-mark-reviewed`. ' +
    'Differs from training_data.csv (committed file for bulk imports) — this tool is for ad-hoc one-offs.',
    {
      text:           z.string().min(1).max(2000),
      intent:         z.string().min(1).max(100),
      tool:           z.string().max(100).optional(),
      next_action:    z.enum(['call_tool', 'clarify', 'answer_directly', 'unknown']),
      source:         z.enum(['teach', 'turn_label']).default('teach'),
      source_turn_id: z.string().regex(/^[0-9a-f]{8}$/).optional(),
      notes:          z.string().max(500).optional(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'write',
      whenToUse: [
        'User invoked /teach slash command to label a training row',
        'User tapped "Add to training set" on a /turn card',
      ],
      whenNotToUse: [
        'Bulk CSV import — use the manual_examples.csv file + `make training-data-export` instead',
      ],
      commonNextTools: [],
      outputSchema: {
        type: 'object', required: ['data'],
        properties: { data: { type: 'object', properties: { id: { type: 'string' }, reviewed: { type: 'boolean' } } } },
      },
    } as any,
    async (args, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      const row = await addTrainingData(getPool(), {
        tenantId:     g.tenantId,
        addedBy:      g.employeeId,
        text:         args.text,
        intent:       args.intent,
        tool:         args.tool ?? null,
        nextAction:   args.next_action,
        source:       args.source,
        sourceTurnId: args.source_turn_id ?? null,
        notes:        args.notes ?? null,
      });
      return ok({ id: row.id, reviewed: row.reviewed }, `Added training row (id=${row.id.slice(0, 8)}…). Pending review.`);
    },
  );
}

export function registerBotIntentTrainingDataListUnreviewed(server: McpServer): void {
  server.tool(
    'bot_intent_training_data_list_unreviewed',
    'List unreviewed bot_intent_training_data rows for the calling tenant. ' +
    'Scope: tenant. Audience: HR admins (gated on bot.metrics.read). ' +
    'Output: { rows: [...] } each with id, text, intent, tool, next_action, added_by, added_at, source, notes. ' +
    'Used by `make training-data-review` to surface entries pending human review before they are eligible for the next training run.',
    { limit: z.number().int().min(1).max(200).default(50) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'Admin reviewing pending /teach + turn-label entries before they feed the next train',
        'Operator calling `make training-data-review`',
      ],
      whenNotToUse: ['Live tenant data — this is admin tooling only'],
      commonNextTools: [],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ limit }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      const rows = await listUnreviewed(getPool(), g.tenantId, limit);
      return ok({ rows }, `${rows.length} unreviewed row${rows.length === 1 ? '' : 's'}`);
    },
  );
}

export function registerBotIntentModelRunsList(server: McpServer): void {
  server.tool(
    'bot_intent_model_runs_list',
    'List recent intent-classifier model runs (platform-wide). ' +
    'Scope: platform (no tenant filter — one model serves all tenants in v1). ' +
    'Audience: HR admins (gated on bot.metrics.read). ' +
    'Output: { runs: [...] } each with model_version, trained_at, corpus_cutoff_at, train_count, intents_count, cv_macro_f1, holdout_macro_f1, artifact_uri, deployed_at, deprecated_at. ' +
    'Used to audit when the classifier was last retrained and which artifact is live.',
    { limit: z.number().int().min(1).max(50).default(10) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'Admin auditing model lineage / retrain cadence',
        'Operator calling `make classifier-status` (which reads this + the latest run)',
      ],
      whenNotToUse: ['Per-row training-data audit — use bot_intent_training_data_list_unreviewed instead'],
      commonNextTools: ['bot_intent_classifier_status'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ limit }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      const runs = await listModelRuns(getPool(), limit);
      return ok({ runs }, `${runs.length} model run${runs.length === 1 ? '' : 's'}`);
    },
  );
}

export function registerBotIntentClassifierStatus(server: McpServer): void {
  server.tool(
    'bot_intent_classifier_status',
    'Status snapshot of the intent classifier: latest model_version + count of training rows added since that model\'s corpus_cutoff_at. ' +
    'Scope: caller\'s tenant (untrained-row count). The latest model itself is platform-wide. ' +
    'Audience: HR admins (gated on bot.metrics.read). ' +
    'Output: { latestModelVersion, corpusCutoffAt, untrained, scope }. ' +
    'When `untrained` is large, queue a `make classifier-train` to incorporate the new labels.',
    { tenant_only: z.boolean().default(true).describe('true → untrained count for caller\'s tenant; false → cross-tenant total') },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'Operator wants a one-shot view of "is the model up to date with the labels?"',
        '`make classifier-status` script wraps this',
      ],
      whenNotToUse: [],
      commonNextTools: ['bot_intent_model_runs_list'],
      outputSchema: { type: 'object', required: ['data'], properties: { data: { type: 'object' } } },
    } as any,
    async ({ tenant_only }, context) => {
      const g = await gate(context.authInfo);
      if ('refusal' in g) return g.refusal;
      const status = await countUntrainedSinceLatest(
        getPool(), tenant_only ? g.tenantId : undefined,
      );
      const scope = tenant_only ? 'tenant' : 'platform';
      const msg = status.latestModelVersion
        ? `Latest: ${status.latestModelVersion} (cutoff ${status.corpusCutoffAt?.toISOString().slice(0, 10)}). ${status.untrained} untrained row${status.untrained === 1 ? '' : 's'} (${scope} scope).`
        : `No model runs yet. ${status.untrained} reviewed row${status.untrained === 1 ? '' : 's'} pending first train.`;
      return ok({ ...status, scope }, msg);
    },
  );
}

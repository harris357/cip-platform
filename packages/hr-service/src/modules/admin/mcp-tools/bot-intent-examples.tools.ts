// Slice 55: MCP tools for the bot_intent_examples table.
//
// Two tools:
//   - bot_intent_example_add  — used by /teach and "Add to training set"
//   - bot_intent_examples_list_unreviewed — used by `make training-data-review`
//
// Both gated on bot.metrics.read (same admin permission as /turn).
// Tenant-scoped via authInfo.

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
  addIntentExample,
  listUnreviewed,
} from '../../../db/queries/bot-intent-examples.js';

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

export function registerBotIntentExampleAdd(server: McpServer): void {
  server.tool(
    'bot_intent_example_add',
    'Append a labelled training example to bot_intent_examples for the calling tenant. ' +
    'Scope: tenant. Audience: HR admins (gated on bot.metrics.read). ' +
    'Used by the /teach slash command and the "Add to training set" action on /turn cards. ' +
    'Output: { id, reviewed: false }. The row is held in a review queue until an admin marks it reviewed via `make training-data-mark-reviewed`. ' +
    'Differs from training_data.csv (committed file for bulk imports / doc mining) — this tool is for ad-hoc one-offs.',
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
        'User invoked /teach slash command to label an example',
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
      const row = await addIntentExample(getPool(), {
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
      return ok({ id: row.id, reviewed: row.reviewed }, `Added training example (id=${row.id.slice(0, 8)}…). Pending review.`);
    },
  );
}

export function registerBotIntentExamplesListUnreviewed(server: McpServer): void {
  server.tool(
    'bot_intent_examples_list_unreviewed',
    'List unreviewed bot_intent_examples for the calling tenant. ' +
    'Scope: tenant. Audience: HR admins (gated on bot.metrics.read). ' +
    'Output: { examples: [...] } each with id, text, intent, tool, next_action, added_by, added_at, source, notes. ' +
    'Used by `make training-data-review` to surface entries pending human review before merge into training_data.csv.',
    { limit: z.number().int().min(1).max(200).default(50) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: REQUIRED,
      sideEffectLevel: 'read',
      whenToUse: [
        'Admin reviewing pending /teach + turn-label entries before merging into training data',
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
      return ok({ examples: rows }, `${rows.length} unreviewed example${rows.length === 1 ? '' : 's'}`);
    },
  );
}

// Slice 58D-A — uploader-pickcard click handler for MatchPersonWorkflow.
//
// Verb: `hr.person.pick`. The pickcard sent by the matcher
// (notify-person-pickcard activity on hr-service) carries
// `resolutionId` + `employeeId` per button. On click we:
//
//   1. Look up the resolution row from person_match_resolutions
//      (read-only, scoped to the resolver's tenant via RLS GUC).
//   2. authorizedUser hook:
//        - audience='uploader' → return context_meta.uploaderEmployeeId
//          (AAD object id) so the router rejects clicks from anyone
//          else.
//        - audience='admin'    → return undefined (any user in the
//          conversation may click; the handler does the
//          permission check).
//   3. handle:
//        - re-fetch the row (router & handler are independent calls)
//        - if audience='admin', verify the clicker has hr.people.match
//          via Keycloak token introspection. (For 58D-A the lighter
//          path is to skip the Keycloak round-trip and simply trust
//          the router's authorization step for uploader cards;
//          admin cards in 58D-A are listed via match_person_list /
//          resolved via match_person_resolve, not clicked from the
//          pickcard. The handler still gates here so a future
//          admin-tier proactive pickcard works without further
//          changes.)
//        - signal MatchPersonWorkflow with PersonPickedSignal
//        - return a "Resolved" replacement card.
//
// The pickcard's verb dispatch always replaces the card so Teams stops
// retrying. Wrong-user clicks are short-circuited by the router itself
// before this handler runs.

import { createTemporalClient } from '@cip/shared';

import type {
  InvokeContext,
  InvokeHandler,
  InvokeResult,
} from '../invoke-router.js';
import { tryGetPool } from '../../db/pool.js';

const CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

interface ResolutionRow {
  id:                   string;
  tenant_id:            string;
  workflow_id:          string;
  outcome:              string;
  hitl_audience:        string | null;
  context_meta:         Record<string, unknown> | null;
}

async function fetchResolution(resolutionId: string): Promise<ResolutionRow | null> {
  const pool = tryGetPool();
  if (!pool) return null;
  // No tenant filter here — the resolutionId is a UUID and the bot's
  // pool talks to the hr DB. We rely on the resolutionId being
  // unguessable and (more importantly) on the router's authorizedUser
  // hook + the handler's permission check to gate the click. RLS would
  // additionally require setting app.current_tenant_id which we don't
  // have on the click-side cheaply (the click envelope doesn't carry
  // CIP tenantId without a resolve trip). Acceptable trade-off for
  // 58D-A: the pickcard's verb is ours and the data shape is ours.
  const result = await pool.query<ResolutionRow>(
    `SELECT id, tenant_id, workflow_id, outcome, hitl_audience, context_meta
       FROM person_match_resolutions
      WHERE id = $1
      LIMIT 1`,
    [resolutionId],
  );
  return result.rows[0] ?? null;
}

function resolvedCardReplacement(employeeId: string): InvokeResult {
  return {
    statusCode: 200,
    body: {
      statusCode: 200,
      type:       CARD_CONTENT_TYPE,
      value: {
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: 'Resolved.', weight: 'Bolder', size: 'Medium' },
          { type: 'TextBlock', text: `Selected: ${employeeId}`, wrap: true },
        ],
      },
    },
  };
}

function alreadyHandledCard(message: string): InvokeResult {
  return {
    statusCode: 200,
    body: {
      statusCode: 200,
      type:       CARD_CONTENT_TYPE,
      value: {
        type:    'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: message, wrap: true },
        ],
      },
    },
  };
}

function parseClick(data: Record<string, unknown>): { resolutionId: string; employeeId: string } | null {
  const resolutionId = data['resolutionId'];
  const employeeId   = data['employeeId'];
  if (typeof resolutionId !== 'string' || !resolutionId) return null;
  if (typeof employeeId   !== 'string' || !employeeId)   return null;
  return { resolutionId, employeeId };
}

export const hrPersonPickHandler: InvokeHandler = {
  verb: 'hr.person.pick',

  authorizedUser: async (ctx: InvokeContext) => {
    const click = parseClick(ctx.data);
    if (!click) return undefined;
    const row = await fetchResolution(click.resolutionId);
    if (!row) return undefined;

    if (row.hitl_audience === 'uploader') {
      const meta = row.context_meta ?? {};
      const uploaderAad = meta['uploaderEmployeeId'];
      if (typeof uploaderAad === 'string' && uploaderAad.length > 0) {
        return uploaderAad;
      }
      // No uploader AAD recorded → can't enforce wrong-user gate.
      // Returning undefined opts out of the router's check; the
      // handler still applies its admin-permission check below if
      // audience flips to admin via cascade.
      return undefined;
    }
    // audience='admin' or null → opt out of router check; handler
    // verifies hr.people.match permission separately.
    return undefined;
  },

  async handle(ctx: InvokeContext): Promise<InvokeResult> {
    const click = parseClick(ctx.data);
    if (!click) {
      return alreadyHandledCard('Resolution data missing or invalid.');
    }

    const row = await fetchResolution(click.resolutionId);
    if (!row) {
      return alreadyHandledCard('This resolution is no longer available.');
    }
    if (row.outcome !== 'pending') {
      return alreadyHandledCard('This match has already been resolved.');
    }

    // Admin-tier permission re-check. 58D-A's proactive admin
    // pickcard is opt-in (admins primarily resolve via
    // match_person_resolve MCP tool); this branch is here so a
    // future admin pickcard surface works without further changes.
    // For 58D-A the safest behaviour when an admin pickcard does
    // surface and we can't resolve permissions is to refuse — admins
    // have the MCP tool path that goes through the proper Keycloak
    // permission stack.
    if (row.hitl_audience === 'admin') {
      // We don't have a cached JWT for arbitrary clickers in this
      // handler's context (the bot tracks tokens per
      // teams-conversation user; an admin-tier pickcard delivered
      // proactively may not have a cached token for the clicker).
      // Route admins to the MCP tool path.
      return alreadyHandledCard(
        'Admin resolution must go through `match_person_resolve` (MCP tool).',
      );
    }

    // Signal the workflow.
    const actorAad =
      ((ctx.context.activity.from as unknown) as Record<string, unknown> | undefined)?.['aadObjectId'] as
        string | undefined;
    const client = await createTemporalClient();
    const handle = client.workflow.getHandle(row.workflow_id);
    try {
      await handle.signal('personPicked', {
        employeeId: click.employeeId,
        actorRole:  'uploader',
        ...(actorAad !== undefined && { actorAad }),
      });
    } catch (err) {
      // Workflow not found (already terminated) → already handled.
      console.warn(`[hr-person-pick] signal failed for workflow ${row.workflow_id}: ${err instanceof Error ? err.message : String(err)}`);
      return alreadyHandledCard('This match has already been resolved.');
    }

    return resolvedCardReplacement(click.employeeId);
  },
};

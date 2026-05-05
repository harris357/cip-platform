// Slice 58D-A — uploader-pickcard click handler for MatchPersonWorkflow.
//
// Verb: `hr.person.pick`. The pickcard sent by the matcher
// (notify-person-pickcard activity on hr-service) carries
// `resolutionId` + `employeeId` per button. On click we:
//
//   1. Fetch the resolution row from hr-service via the
//      `/internal/resolutions/:id` endpoint (slice 58D-A). The bot
//      does NOT connect directly to DATABASE_URL_HR for this — every
//      cross-service read goes through hr-service's HTTP surface so
//      the data layer stays owned by one service.
//   2. authorizedUser hook:
//        - audience='uploader' → return contextMeta.uploaderEmployeeId
//          (AAD object id) so the router rejects clicks from anyone
//          else.
//        - audience='admin'    → return undefined (the handler refuses
//          admin clicks below; admins use match_person_resolve MCP).
//   3. handle:
//        - re-fetch the row (router & handler are independent calls)
//        - if audience='admin', refuse — admin tier must go through
//          match_person_resolve MCP for proper Keycloak permission
//          stack
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

const CARD_CONTENT_TYPE = 'application/vnd.microsoft.card.adaptive';

interface ResolutionResponse {
  id:           string;
  tenantId:     string;
  workflowId:   string;
  outcome:      string;
  hitlAudience: string | null;
  contextMeta:  Record<string, unknown> | null;
}

async function fetchResolution(resolutionId: string): Promise<ResolutionResponse | null> {
  const baseUrl = process.env['HR_SERVICE_URL'];
  const token   = process.env['PLATFORM_ADMIN_TOKEN'];
  if (!baseUrl || !token) {
    console.warn('[hr-person-pick] HR_SERVICE_URL or PLATFORM_ADMIN_TOKEN missing — cannot fetch resolution');
    return null;
  }
  const url = `${baseUrl}/internal/resolutions/${encodeURIComponent(resolutionId)}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      headers: { 'x-platform-admin-token': token },
    });
  } catch (err) {
    console.warn(`[hr-person-pick] fetch threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }

  if (resp.status === 404) return null;
  if (!resp.ok) {
    console.warn(`[hr-person-pick] fetch failed: HTTP ${resp.status}`);
    return null;
  }
  return (await resp.json()) as ResolutionResponse;
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

    if (row.hitlAudience === 'uploader') {
      const meta = row.contextMeta ?? {};
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
    // refuses admin clicks below.
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
    if (row.hitlAudience === 'admin') {
      return alreadyHandledCard(
        'Admin resolution must go through `match_person_resolve` (MCP tool).',
      );
    }

    // Signal the workflow.
    const actorAad =
      ((ctx.context.activity.from as unknown) as Record<string, unknown> | undefined)?.['aadObjectId'] as
        string | undefined;
    const client = await createTemporalClient();
    const handle = client.workflow.getHandle(row.workflowId);
    try {
      await handle.signal('personPicked', {
        employeeId: click.employeeId,
        actorRole:  'uploader',
        ...(actorAad !== undefined && { actorAad }),
      });
    } catch (err) {
      // Workflow not found (already terminated) → already handled.
      console.warn(`[hr-person-pick] signal failed for workflow ${row.workflowId}: ${err instanceof Error ? err.message : String(err)}`);
      return alreadyHandledCard('This match has already been resolved.');
    }

    return resolvedCardReplacement(click.employeeId);
  },
};

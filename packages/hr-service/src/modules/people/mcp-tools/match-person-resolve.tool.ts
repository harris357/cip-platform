// Slice 58D-A — admin signal forwarder for the person matcher.
//
// Looks up the workflow_id from person_match_resolutions, signals
// 'personPicked' on the running MatchPersonWorkflow handle. Idempotent
// at the workflow side: the workflow's signal handler keeps only the
// first click, subsequent signals see workflow already advanced.
//
// Permission: hr.people.match.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpModuleResponse, PersonPickedSignal } from '@cip/shared';
import { createTemporalClient } from '@cip/shared';

import { extractAuthContext, assertPermission } from '../../../mcp-server/auth.js';
import { findResolutionById } from '../db/queries/person-match-resolutions.js';

export function registerMatchPersonResolve(server: McpServer): void {
  server.tool(
    'match_person_resolve',
    'Resolve a pending person-match item by picking an employee. ' +
    'Scope: one resolution row. ' +
    'Audience: HR admins (gated on `hr.people.match`). ' +
    'Output: signal sent to the MatchPersonWorkflow with the picked employeeId. ' +
    'The workflow advances and persists `source=hitl_admin` + the resolver as ' +
    'the actor. ' +
    'Idempotent: subsequent calls hit the no-longer-pending guard.',
    {
      resolutionId: z.string().uuid().describe('Resolution row id from match_person_list'),
      employeeId:   z.string().uuid().describe('Selected employee id'),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'hr.people.match',
      sideEffectLevel:    'write',
      whenToUse: [
        'Admin picks an employee for a queued match resolution',
      ],
      whenNotToUse: [
        'Match is still on the uploader tier — let the uploader pickcard run its TTL',
        'Listing items — use match_person_list',
      ],
      commonNextTools: ['match_person_list'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: { signalSent: { type: 'boolean' }, workflowId: { type: 'string' } },
          },
        },
      },
    } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      await assertPermission(context.authInfo, 'hr.people.match');

      const row = await findResolutionById({
        tenantId:     ctx.tenantId,
        resolutionId: args.resolutionId,
      });
      if (!row) {
        throw new Error(`resolution ${args.resolutionId} not found in tenant ${ctx.tenantId}`);
      }
      if (row.outcome !== 'pending') {
        throw new Error(`resolution ${args.resolutionId} is no longer pending (outcome=${row.outcome})`);
      }

      const signalPayload: PersonPickedSignal = {
        employeeId: args.employeeId,
        actorRole:  'admin',
        actorAad:   ctx.employeeId,  // JWT sub == AAD object id for AAD-federated users
      };

      const client = await createTemporalClient();
      const handle = client.workflow.getHandle(row.workflowId);
      await handle.signal('personPicked', signalPayload);

      const response: McpModuleResponse<{ signalSent: boolean; workflowId: string }> = {
        data: { signalSent: true, workflowId: row.workflowId },
        message: `Resolution signalled with employee ${args.employeeId}.`,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}

// Slice 58D-A — admin-queue listing for the person matcher.
//
// Polled by hr admin operators (no proactive push from the matcher
// itself). Default `state='pending_admin'` returns only items that have
// either escalated to admin tier (uploader TTL elapsed) or were
// initiated with `policy.onAmbiguous='admin_queue'`.
//
// Permission: hr.people.match (seeded by permission-catalog-seed).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { McpModuleResponse } from '@cip/shared';

import { extractAuthContext, assertPermission } from '../../../mcp-server/auth.js';
import { listPendingResolutions } from '../db/queries/person-match-resolutions.js';

export function registerMatchPersonList(server: McpServer): void {
  server.tool(
    'match_person_list',
    'List pending person-match resolutions in the admin queue. ' +
    'Scope: tenant-wide. ' +
    'Audience: HR admins / triage operators (gated on `hr.people.match`). ' +
    'Output: array of resolutions with candidates + canonicalization + audience. ' +
    'Default `state=pending_admin` shows only items the admin can act on; ' +
    "`pending_any` adds rows still on the uploader tier; `all` removes the filter. " +
    'Used in conjunction with match_person_resolve to dispatch the click.',
    {
      state: z.enum(['pending_admin', 'pending_any', 'all']).default('pending_admin'),
      limit: z.number().int().min(1).max(200).default(50),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    {
      requiredPermission: 'hr.people.match',
      sideEffectLevel:    'read',
      whenToUse: [
        'Admin asks "what person-match items are pending"',
        'Operator triage of stale matcher resolutions',
      ],
      whenNotToUse: [
        'Resolving a single item — use match_person_resolve directly',
        'Matcher trace / debug — query person_match_resolutions DB directly',
      ],
      commonNextTools: ['match_person_resolve'],
      outputSchema: {
        type: 'object',
        required: ['data'],
        properties: {
          data: {
            type: 'object',
            properties: {
              resolutions: { type: 'array' },
              count:       { type: 'number' },
            },
          },
        },
      },
    } as any,
    async (args, context) => {
      const ctx = extractAuthContext(context.authInfo);
      // assertPermission throws PermissionDeniedError on miss; the MCP
      // transport surfaces the throw as a structured error response.
      await assertPermission(context.authInfo, 'hr.people.match');

      const rows = await listPendingResolutions({
        tenantId: ctx.tenantId,
        state:    args.state,
        limit:    args.limit,
      });

      const resolutions = rows.map(r => ({
        resolutionId:    r.id,
        workflowId:      r.workflowId,
        source:          r.source,
        callerSubmissionId: r.callerSubmissionId,
        candidateText:   r.candidateText,
        canonicalization: r.canonicalization,
        candidates:      r.scoredCandidates,
        audience:        r.hitlAudience,
        outcome:         r.outcome,
        initiatedAt:     r.initiatedAt,
        hitlOfferedAt:   r.hitlOfferedAt,
      }));

      const userMessage = resolutions.length === 0
        ? '_No pending person-match items._'
        : `**${resolutions.length} pending match${resolutions.length === 1 ? '' : 'es'}.**`;

      const response: McpModuleResponse<{ resolutions: typeof resolutions; count: number }> = {
        data: { resolutions, count: resolutions.length },
        message: userMessage,
      };
      return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
    },
  );
}

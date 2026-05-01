import type { PoolClient } from 'pg';

export interface HrActionRecord {
  tenantId:           string;
  actorEmployeeId:    string;
  actionType:         string;
  targetEmployeeId?:  string;
  payload:            unknown;
  result:             'success' | 'failed';
  errorCode?:         string;
  errorMessage?:      string;
}

// Slice 42C: read side of hr_actions for the `audit_log_list` MCP tool.
export interface HrActionRow {
  id:                string;
  tenantId:          string;
  actorEmployeeId:   string;
  actionType:        string;
  targetEmployeeId:  string | null;
  payload:           unknown;
  result:            string;
  errorCode:         string | null;
  errorMessage:      string | null;
  createdAt:         string;
}

export interface ListHrActionsFilter {
  actorEmployeeId?:  string;
  targetEmployeeId?: string;
  actionType?:       string;
  sinceIso?:         string;
  limit?:            number;
}

export async function insertHrAction(
  client: PoolClient,
  rec:    HrActionRecord,
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO hr_actions
       (tenant_id, actor_employee_id, action_type, target_employee_id,
        payload, result, error_code, error_message)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING id`,
    [
      rec.tenantId,
      rec.actorEmployeeId,
      rec.actionType,
      rec.targetEmployeeId ?? null,
      JSON.stringify(rec.payload),
      rec.result,
      rec.errorCode ?? null,
      rec.errorMessage ?? null,
    ],
  );
  return result.rows[0]!;
}

/**
 * Slice 42C: list audit events from hr_actions with optional filtering.
 * Used by the `audit_log_list` MCP tool. Tenant-scoped.
 */
export async function listHrActions(
  client:   PoolClient,
  tenantId: string,
  filter:   ListHrActionsFilter,
): Promise<HrActionRow[]> {
  const where: string[] = ['tenant_id = $1'];
  const args: unknown[] = [tenantId];

  if (filter.actorEmployeeId) {
    where.push(`actor_employee_id = $${args.length + 1}`);
    args.push(filter.actorEmployeeId);
  }
  if (filter.targetEmployeeId) {
    where.push(`target_employee_id = $${args.length + 1}`);
    args.push(filter.targetEmployeeId);
  }
  if (filter.actionType) {
    where.push(`action_type = $${args.length + 1}`);
    args.push(filter.actionType);
  }
  if (filter.sinceIso) {
    where.push(`created_at >= $${args.length + 1}`);
    args.push(filter.sinceIso);
  }

  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  args.push(limit);

  const r = await client.query<HrActionRow>(
    `SELECT id,
            tenant_id           AS "tenantId",
            actor_employee_id   AS "actorEmployeeId",
            action_type         AS "actionType",
            target_employee_id  AS "targetEmployeeId",
            payload,
            result,
            error_code          AS "errorCode",
            error_message       AS "errorMessage",
            created_at          AS "createdAt"
       FROM hr_actions
      WHERE ${where.join(' AND ')}
      ORDER BY created_at DESC
      LIMIT $${args.length}`,
    args,
  );
  return r.rows;
}

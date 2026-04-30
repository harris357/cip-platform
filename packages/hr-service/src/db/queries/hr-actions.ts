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

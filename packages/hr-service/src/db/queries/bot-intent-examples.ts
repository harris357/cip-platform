// Slice 55: queries for bot_intent_examples table.
//
// Backing store for the /teach slash command, "Add to training set"
// /turn card action, and bulk CSV imports. Tenant-scoped — every
// query takes tenantId.

import type pg from 'pg';

export interface AddIntentExampleInput {
  tenantId:     string;
  addedBy:      string;
  text:         string;
  intent:       string;
  tool?:        string | null;
  nextAction:   'call_tool' | 'clarify' | 'answer_directly' | 'unknown';
  source:       'teach' | 'turn_label' | 'manual_csv';
  sourceTurnId?: string | null;
  notes?:       string | null;
}

export interface IntentExampleRow {
  id:             string;
  tenant_id:      string;
  added_by:       string;
  added_at:       Date;
  text:           string;
  intent:         string;
  tool:           string | null;
  next_action:    string;
  source:         string;
  source_turn_id: string | null;
  notes:          string | null;
  reviewed:       boolean;
}

export async function addIntentExample(
  pool: pg.Pool,
  input: AddIntentExampleInput,
): Promise<IntentExampleRow> {
  const r = await pool.query<IntentExampleRow>(
    `INSERT INTO bot_intent_examples
       (tenant_id, added_by, text, intent, tool, next_action, source, source_turn_id, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      input.tenantId, input.addedBy, input.text, input.intent,
      input.tool ?? null, input.nextAction, input.source,
      input.sourceTurnId ?? null, input.notes ?? null,
    ],
  );
  return r.rows[0]!;
}

export async function listUnreviewed(
  pool: pg.Pool, tenantId: string, limit = 50,
): Promise<IntentExampleRow[]> {
  const r = await pool.query<IntentExampleRow>(
    `SELECT * FROM bot_intent_examples
      WHERE tenant_id = $1 AND NOT reviewed
      ORDER BY added_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return r.rows;
}

export async function markReviewed(
  pool: pg.Pool, tenantId: string, ids: string[],
): Promise<number> {
  const r = await pool.query(
    `UPDATE bot_intent_examples
       SET reviewed = true
     WHERE tenant_id = $1 AND id = ANY($2::uuid[])`,
    [tenantId, ids],
  );
  return r.rowCount ?? 0;
}

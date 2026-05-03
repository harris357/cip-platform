// Slice 55: shared DB-resolution helpers used by extractors.
//
// Each helper:
//   - Always filters by tenant_id (non-negotiable).
//   - Uses a hard timeout (lg.extractor_db_timeout_ms, default 500ms).
//     Exceeded → returns null and lets the extractor bail to no_match.
//   - Returns one of three shapes: resolved (1 match), ambiguous
//     (>1 match, top 5 returned), or null (no match).
//
// The helpers are deliberately narrow — they don't try to BE smart;
// they just reduce DB-glue boilerplate across extractors.

import type pg from 'pg';
import type { BotAuthContext } from '../../auth/resolve-context.js';
import type { DisambiguationCandidate } from './types.js';

const DEFAULT_TIMEOUT_MS = 500;

export type Resolution<T> =
  | { kind: 'resolved';  value: T }
  | { kind: 'ambiguous'; candidates: DisambiguationCandidate[] }
  | { kind: 'none' };

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    const result = await Promise.race([p, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Resolve an employee mention from raw text.
 *
 * Strategy (in order):
 *   1. Email pattern → exact match in employees.email.
 *   2. Quoted name OR Capitalized-Word(s) following a known verb → ILIKE on full_name.
 *
 * Filters out disabled employees automatically.
 */
export async function resolveEmployeeByNameOrEmail(
  text: string,
  ctx:  BotAuthContext,
  pool: pg.Pool,
): Promise<Resolution<{ id: string; label: string }>> {
  const email = text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
  if (email) {
    const r = await withTimeout(
      pool.query(
        `SELECT id, full_name FROM employees
          WHERE LOWER(email) = LOWER($1)
            AND tenant_id = $2
            AND disabled_at IS NULL
          LIMIT 5`,
        [email, ctx.tenantId],
      ),
      DEFAULT_TIMEOUT_MS,
    );
    if (!r) return { kind: 'none' };
    if (r.rows.length === 1) return { kind: 'resolved', value: { id: r.rows[0].id, label: r.rows[0].full_name } };
    if (r.rows.length > 1) {
      return {
        kind: 'ambiguous',
        candidates: r.rows.map((row: { id: string; full_name: string }) => ({
          id:    row.id,
          label: row.full_name,
          hint:  email,
        })),
      };
    }
  }

  const quoted   = text.match(/"([^"]+)"|'([^']+)'/);
  const verbName = text.match(
    /(?:off-?board|disable|deactivate|terminate|fire|enable|view|show|find|lookup|details? for|assign|revoke|grant)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/,
  );
  const candidate = (quoted?.[1] ?? quoted?.[2] ?? verbName?.[1] ?? '').trim();
  if (!candidate) return { kind: 'none' };

  const r = await withTimeout(
    pool.query(
      `SELECT id, full_name, email FROM employees
        WHERE tenant_id = $1
          AND full_name ILIKE $2
          AND disabled_at IS NULL
        LIMIT 5`,
      [ctx.tenantId, `%${candidate}%`],
    ),
    DEFAULT_TIMEOUT_MS,
  );
  if (!r) return { kind: 'none' };
  if (r.rows.length === 1) return { kind: 'resolved', value: { id: r.rows[0].id, label: r.rows[0].full_name } };
  if (r.rows.length > 1) {
    return {
      kind: 'ambiguous',
      candidates: r.rows.map((row: { id: string; full_name: string; email: string }) => ({
        id:    row.id,
        label: row.full_name,
        hint:  row.email,
      })),
    };
  }
  return { kind: 'none' };
}

/**
 * Resolve a role by its code. Roles are tenant-scoped via roles.tenant_id.
 */
export async function resolveRoleByCode(
  code: string,
  ctx:  BotAuthContext,
  pool: pg.Pool,
): Promise<Resolution<{ id: string; label: string; codeNormalized: string }>> {
  const normalized = code.trim().toLowerCase();
  const r = await withTimeout(
    pool.query(
      `SELECT id, code, label FROM roles
        WHERE tenant_id = $1 AND LOWER(code) = $2
        LIMIT 1`,
      [ctx.tenantId, normalized],
    ),
    DEFAULT_TIMEOUT_MS,
  );
  if (!r || r.rows.length === 0) return { kind: 'none' };
  return {
    kind: 'resolved',
    value: { id: r.rows[0].id, label: r.rows[0].label, codeNormalized: r.rows[0].code },
  };
}

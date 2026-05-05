// Slice 58D-A — internal HTTP endpoint for person_match_resolutions lookups.
//
// The bot's hr-person-pick invoke handler (uploader-pickcard click) needs
// to read a resolution row to:
//   - know the workflow_id to signal
//   - resolve `authorizedUser` (compare context_meta.uploaderEmployeeId
//     to the click's AAD object id)
//   - check outcome=='pending' before signalling
//
// hr-service owns the data; the bot reaches it via this endpoint rather
// than connecting directly to DATABASE_URL_HR. Mirrors the pattern of
// /admin/routing-rules: shared platform-admin-token auth, JSON response,
// no per-tenant body required (the resolutionId is unguessable; RLS is
// applied below via app.current_tenant_id GUC keyed off the row's own
// tenant_id).

import { Router, type IRouter, type Request, type Response, type NextFunction } from 'express';
import { getPool } from '../db/index.js';

export const internalResolutionsRouter: IRouter = Router();

// Same shared-token auth as admin-routing/admin-tenants — keeps internal
// endpoints uniform.
internalResolutionsRouter.use((req: Request, res: Response, next: NextFunction): void => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

interface ResolutionRow {
  id:                   string;
  tenant_id:            string;
  workflow_id:          string;
  outcome:              string;
  hitl_audience:        string | null;
  context_meta:         Record<string, unknown> | null;
}

internalResolutionsRouter.get(
  '/internal/resolutions/:id',
  async (req: Request, res: Response): Promise<void> => {
    const id = req.params['id'];
    if (typeof id !== 'string' || !id) {
      res.status(400).json({ error: 'id_required' });
      return;
    }

    const pool = getPool();
    const client = await pool.connect();
    try {
      // Two-step read: first lookup the row (no tenant gate yet — the
      // resolutionId is unguessable), then re-read under the row's own
      // tenant RLS GUC for defense-in-depth. The first read is bounded
      // by the unique PK + LIMIT 1; an attacker brute-forcing UUIDs is
      // already gated by the platform-admin-token + auth layer above.
      const initial = await client.query<ResolutionRow>(
        `SELECT id, tenant_id, workflow_id, outcome, hitl_audience, context_meta
           FROM person_match_resolutions
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      const row = initial.rows[0];
      if (!row) {
        res.status(404).json({ error: 'not_found' });
        return;
      }

      // Re-read under tenant RLS to confirm visibility under the row's
      // tenant context (mirrors how every other hr-service activity
      // reads). Belt-and-suspenders against future RLS policy changes
      // that might tighten visibility.
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [row.tenant_id]);
      const verified = await client.query<ResolutionRow>(
        `SELECT id, tenant_id, workflow_id, outcome, hitl_audience, context_meta
           FROM person_match_resolutions
          WHERE id = $1
          LIMIT 1`,
        [id],
      );
      await client.query('COMMIT');

      const v = verified.rows[0];
      if (!v) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
      res.json({
        id:           v.id,
        tenantId:     v.tenant_id,
        workflowId:   v.workflow_id,
        outcome:      v.outcome,
        hitlAudience: v.hitl_audience,
        contextMeta:  v.context_meta,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      console.error('[internal-resolutions] failed:', err);
      res.status(500).json({ error: 'internal' });
    } finally {
      client.release();
    }
  },
);

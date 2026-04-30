# Slice 32 — Realm Roles `hr`/`employee`, Auth Context, and HR Audit Table

> **Prerequisite:** Slice 25 complete (`EmployeeOnboardingWorkflow` + activities exist).
> **Package:** `@cip/shared`, `@cip/hr-service`, plus `scripts/bootstrap.sh`
> **Verify:** `pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Slice 25 assigns identity-mechanism-flavoured role names (`field_operations`,
`field_employee`) as defaults during onboarding. The plan in
[docs/users-roles-auth-normalization-plan.md](../docs/users-roles-auth-normalization-plan.md)
replaces that with two purpose-driven realm roles:

- `employee` — baseline access for everyone in the system. Cannot be revoked
  (use `employee.disable` instead).
- `hr` — additive role granting employee-management capability. Held by HR reps;
  may also be held by employees who are themselves HR reps.

Slice 31 (`/admin/employees` HTTP endpoint) and Slice 33 (HR MCP tools) both
need:

1. Those realm roles to exist in KC.
2. A way to extract `realm_access.roles` from the KC token into the request's
   auth context.
3. A `requireRealmRole(role)` middleware to gate routes/tools.
4. An audit-trail destination — `hr_actions` — so every HR action leaves a
   row regardless of which entrypoint (HTTP or MCP) triggered it.

This slice produces all four. It is consumed by Slice 31 next, then Slice 33.

---

## What You Are Building

```
packages/shared/src/utils/
  tenant-context.ts                      ← MODIFY: extend AuthContext + add requireRealmRole

packages/hr-service/src/
  modules/employees/activities/
    assign-default-role.activity.ts      ← MODIFY: default to 'employee' for both identity types
  db/migrations/
    00X_hr_actions.sql                   ← NEW: append-only audit table (next free 00X number)
  db/queries/
    hr-actions.ts                        ← NEW: insertHrAction
  services/
    audit.ts                             ← NEW: recordHrAction wrapper

scripts/
  bootstrap.sh                           ← MODIFY: create 'hr' and 'employee' realm roles in cip-dev
```

No new MCP tools, no new workflows. This slice is plumbing only.

---

## Read Before Writing

- `packages/shared/src/utils/tenant-context.ts` (existing `tenantAuthMiddleware`)
- `packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts`
- `packages/hr-service/src/db/migrations/` (find the next free `00X_*.sql` number)
- `packages/hr-service/src/db/queries/workers.ts` (style reference for queries/hr-actions.ts)
- `packages/hr-service/src/db/rls.ts` (`withTenantRLS` helper signature)
- `scripts/bootstrap.sh` section 4 (Keycloak block — admin token already obtained mid-section)
- [docs/users-roles-auth-normalization-plan.md](../docs/users-roles-auth-normalization-plan.md) §§ "Decisions resolved", "Audit"

Do **not** read other packages or other modules — this slice does not touch them.

---

## Hard Rules (Seven Non-Negotiables)

- `tenantId: string` — `hr_actions.tenant_id` is `NOT NULL`. RLS scoped on it.
- No `@anthropic-ai/sdk` imports.
- No raw NATS subjects (this slice doesn't publish events; if any later helper does, use `Subjects.*`).
- MCP input schemas — N/A this slice (no MCP tools added).
- Activity-output Zod validation — `assign-default-role.activity.ts` already returns Zod-validated output; the modification keeps that contract.
- Stubs forbidden — every function ships with a working body.
- Workflow ID pattern — N/A this slice (no `workflow.start`).

---

## Files to Modify

### `packages/shared/src/utils/tenant-context.ts`

Extend the existing module (do **not** rewrite it):

1. Extend `AuthContext` with `roles: string[]`. Source: the JWT's
   `realm_access.roles` array (KC emits this by default in every realm token).
2. In whatever JWT-decoding path `tenantAuthMiddleware` already uses, also pull
   `realm_access?.roles` and attach to `req.auth.roles`. If the array is missing
   or malformed, default to `[]` (don't throw — only `requireRealmRole` cares).
3. Add an exported helper `requireRealmRole(role: string): RequestHandler` —
   Express middleware that 403s if `req.auth?.roles` does not include `role`.
   Response shape: `{ error: 'forbidden', missingRole: role }`.
4. Export everything from the module's existing barrel (no new files).

The middleware is intentionally single-role-per-call. Composition is a chain
(`router.use(requireRealmRole('hr'), requireRealmRole('admin'))`) when both
must hold; for "any of N", add a separate `requireAnyRealmRole(roles[])`
helper if a real caller needs it (don't speculatively add it now).

### `packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts`

Change the default-role mapping:

- Old: `'field_operations'` for `aad_federated`, `'field_employee'` for `field_employee`.
- New: `'employee'` for both.

Do **not** delete the legacy roles from KC. Existing users who have them keep
them; new users simply don't get them. The `field_*` realm roles can stay in
the realm as orphans until a future cleanup slice.

The activity's Zod-validated return type does not change. Its callers
(`EmployeeOnboardingWorkflow`) do not change.

### `scripts/bootstrap.sh` — realm-role creation

Add this block inside the existing KC section, **after** the realm exists and
the admin token has been obtained. Keep it idempotent (KC returns 201 on
create, 409 on duplicate — both are success).

```bash
# Create realm roles 'hr' and 'employee' (idempotent — 409 means already there).
for role in hr employee; do
  desc=""
  case "$role" in
    hr)       desc="Human Resources — can manage employees" ;;
    employee) desc="Baseline employee access (cannot be revoked; use disable instead)" ;;
  esac
  curl -s -o /dev/null -w "      realm role ${role}: HTTP %{http_code}\n" \
    -X POST "${KC_LOCAL}/admin/realms/cip-dev/roles" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"${role}\", \"description\": \"${desc}\"}" 2>/dev/null
done
```

Do **not** create `field_operations` / `field_employee` here. They may already
exist from prior bootstrap runs; leave them alone.

---

## Files to Create

### `packages/hr-service/src/db/migrations/00X_hr_actions.sql`

Use the next free migration number (likely `004_*.sql`; verify before naming).

```sql
-- HR action audit log — append-only.
-- Every successful or failed HR-action tool/endpoint call writes one row.
-- Not a column-level audit (that's pgaudit / temporal tables — out of scope).
-- Not a security event log (that's KC's own audit + SIEM).

CREATE TABLE IF NOT EXISTS hr_actions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  actor_employee_id  UUID NOT NULL REFERENCES employees(id),
  action_type        TEXT NOT NULL,
  target_employee_id UUID REFERENCES employees(id),
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  result             TEXT NOT NULL CHECK (result IN ('success', 'failed')),
  error_code         TEXT,
  error_message      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE hr_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hr_actions
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Common query: "show recent actions affecting this employee"
CREATE INDEX idx_hr_actions_tenant_target
  ON hr_actions(tenant_id, target_employee_id, created_at DESC);

-- Common query: "show recent actions performed by this HR rep"
CREATE INDEX idx_hr_actions_tenant_actor
  ON hr_actions(tenant_id, actor_employee_id, created_at DESC);
```

The table is append-only at the *application* level (no `UPDATE` or `DELETE`
called from any code in this slice or Slice 33). Postgres role privileges can
enforce this later if/when we have separate `hr_app` vs `hr_audit` users; that's
out of scope here.

### `packages/hr-service/src/db/queries/hr-actions.ts`

Single function:

```typescript
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
      rec.tenantId, rec.actorEmployeeId, rec.actionType,
      rec.targetEmployeeId ?? null,
      JSON.stringify(rec.payload),
      rec.result,
      rec.errorCode ?? null,
      rec.errorMessage ?? null,
    ],
  );
  return result.rows[0]!;
}
```

Style mirrors `db/queries/workers.ts`: takes `PoolClient`, leaves RLS-wrapping
to the caller.

### `packages/hr-service/src/services/audit.ts`

A thin convenience wrapper so callers don't have to manage `PoolClient` +
`withTenantRLS` for every audit row:

```typescript
import { withTenantRLS } from '../db/rls.js';
import { insertHrAction, type HrActionRecord } from '../db/queries/hr-actions.js';

/**
 * Write a single HR audit row. Wraps RLS handling.
 * Errors writing audit are logged but never thrown — losing the audit row
 * must not roll back the original action.
 */
export async function recordHrAction(rec: HrActionRecord): Promise<void> {
  try {
    await withTenantRLS(rec.tenantId, async (client) => {
      await insertHrAction(client, rec);
    });
  } catch (err) {
    console.error('[audit] failed to write hr_actions row:', err, { rec });
  }
}
```

The "swallow errors" stance is deliberate — if the DB is down, we'd rather the
HR rep succeed at creating the employee and lose the audit row than fail their
request because the audit table is unreachable. Operationally we'd want a
prometheus alert on the log line. That's an ops concern, not in scope here.

---

## Acceptance Criteria

- [ ] `bootstrap.sh` creates realm roles `hr` and `employee` idempotently;
      reruns produce HTTP 409 logs (not 500).
- [ ] `assign-default-role.activity.ts` returns `roleCode === 'employee'` for
      both `aad_federated` and `field_employee` paths.
- [ ] `AuthContext` has a `roles: string[]` field populated from the JWT.
      Existing `tenantId` extraction still works.
- [ ] `requireRealmRole('hr')` returns 403 with body `{error:'forbidden',missingRole:'hr'}` for a token without that role; passes through otherwise.
- [ ] `hr_actions` table exists, has RLS enabled, and the two indexes are created.
- [ ] `recordHrAction` writes a row when called with valid input.
- [ ] `recordHrAction` does **not** throw when the DB write fails — it logs.
- [ ] `pnpm --filter @cip/shared typecheck` passes.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- Removing the legacy `field_operations` / `field_employee` realm roles from
  KC. They become orphans; cleanup deferred.
- Backfilling `realm_access.roles=[employee]` onto users created before this
  slice (Slice 25 era). They will keep their old roles. If a new test session
  fails because a user was provisioned with the old defaults, re-run their
  onboarding or manually grant `employee` via the KC admin UI.
- MCP tool changes — Slice 33.
- HTTP endpoint changes — Slice 31.
- pgaudit / column-level audit logging.
- Postgres role privileges to enforce append-only at the DB layer.

---

## Cross-Slice Notes

If the existing `tenantAuthMiddleware` does its JWT decoding in a way that
makes adding `roles` extraction non-trivial (e.g., it's hidden behind a
third-party verifier with no claims passthrough), STOP — log a cross-slice
note pointing back to the slice that introduced that middleware, and finish
the rest of this slice. Slice 33 can paper over with a stub until that's
resolved, but better to surface the issue.

---

## Commit

```
slice(32): hr/employee realm roles, auth-context roles[], hr_actions audit table
```

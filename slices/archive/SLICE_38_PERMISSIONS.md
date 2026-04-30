# Slice 38 — Module-Level Permissions + Permission Management Tools

> **Prerequisite:** Slice 32 (realm roles `hr`/`employee`) complete.
> **Package:** `@cip/teams-bot`, `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Two layers of access control are needed:

1. **Realm role** (KC, Slice 32): "Can this user reach this service at all?"
   Coarse, lives in the JWT, e.g. `employee`, `hr`.
2. **Permission**: "Within this service, what specific actions can they
   perform?" Fine-grained, lives in the service DB, e.g. `cert.approve`,
   `employee.create`, `compliance.view`.

The bot already has plumbing for the second layer — `discoverTools()` in
`tool-discovery.ts` filters tools by an annotation lookup against the user's
permission map, and `resolveAuthContext` calls a hr-service MCP tool to
build that map. **The infrastructure is there; the implementation is empty.**
This slice fills it in.

It also **renames the existing "capabilities" terminology to "permissions"**
across the codebase. "Capabilities" collides with MCP's protocol-level
`capabilities` field (which describes what the server/client supports —
totally different concept). Industry-standard RBAC terminology is
`permission`; that's what this slice adopts.

---

## What You Are Building

```
packages/teams-bot/src/
  auth/
    resolve-context.ts          ← MODIFY: rename capabilities→permissions; call new tool name
  mcp/
    tool-discovery.ts           ← MODIFY: annotation lookup key requiredCapability→requiredPermission
  bot.ts                        ← MODIFY: any references to ctx.capabilities (search & replace)

packages/hr-service/src/
  db/
    migrations/
      00X_role_permissions.sql  ← NEW: ALTER roles ADD permissions JSONB; seed dev-tenant roles
    queries/
      permissions.ts            ← NEW: getPermissionsForEmployee() → string[] (distinct, deduped)
  mcp-server/
    auth.ts                     ← MODIFY: add assertPermission(authInfo, code) helper
  modules/employees/
    mcp-tools/
      get-employee-permissions.tool.ts   ← NEW: replaces / renames get_employee_capabilities
      sync-employee.ts                   ← MODIFY: doc-comment update
      employee.grant-permission.tool.ts  ← NEW: HR-only; inserts a role assignment
      employee.revoke-permission.tool.ts ← NEW: HR-only; removes a role assignment
      index.ts                           ← MODIFY: register new tools
```

---

## Read Before Writing

- `packages/teams-bot/src/auth/resolve-context.ts` (current capabilities flow)
- `packages/teams-bot/src/mcp/tool-discovery.ts` (annotation filter)
- `packages/hr-service/src/mcp-server/auth.ts` (extractAuthContext pattern)
- `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` (style reference)
- `packages/hr-service/src/db/migrations/002_domain_model.sql` (existing roles + employee_roles schema)
- `packages/hr-service/src/db/queries/employees.ts` (style reference for queries)
- `slices/SLICE_32_REALM_ROLES_AND_AUDIT.md` (the broad-gate layer this slice complements)
- `docs/users-roles-auth-normalization-plan.md` (background — two-layer model)

Do **not** modify Slice 33's tool implementations directly. When that slice
runs, its prompt is updated to declare `requiredPermission` annotations
against this slice's catalog. This slice owns only the permission
infrastructure and the rename.

---

## Hard Rules (Seven Non-Negotiables)

- **Naming:** `permission` everywhere. The word `capability`/`capabilities`
  must not appear in this slice's deliverables (except in any preserved
  doc-comment that explicitly references the *MCP protocol's* capabilities
  field).
- **Permission code format:** `<resource>.<action>`, lowercase, dots not
  colons. Examples: `employee.create`, `employee.disable`, `cert.approve`,
  `cert.submit`, `compliance.view`. Verb-on-resource (AWS-IAM style).
- **`tenantId`** flows through unchanged — permissions are looked up scoped
  to the calling user's tenant.
- **Defense in depth:** the bot's `discoverTools` filter is for **UX** only;
  every tool handler also calls `assertPermission` server-side. Either layer
  can fail safely; both must pass for the call to succeed.
- All Zod-validated outputs from new MCP tools.
- No `@anthropic-ai/sdk` imports.
- Stubs forbidden — every function ships with a working body.

---

## The two-layer access flow after this slice

```
User sends Teams message
   │
   ▼
Bot resolves tenant, gets KC token (Slice 36 chain)
   │
   ▼
Bot calls hr-service MCP get_employee_permissions
   ↓ returns ["cert.submit","compliance.view"] etc.
   │
   ▼
ctx.permissions = { "cert.submit": true, "compliance.view": true }
   │
   ▼
Bot's discoverTools filters MCP tools by annotation:
  tools.filter(t => !t.annotations.requiredPermission
                    || ctx.permissions[t.annotations.requiredPermission])
   │
   ▼
LLM picks a tool from the filtered list
   │
   ▼
Tool handler in hr-service:
   1. extractAuthContext(authInfo) → tenantId, sub, realm roles
   2. assertPermission(authInfo, 'cert.submit') → throws if missing
       (defense in depth — even if the bot bypasses the discovery filter,
        the handler refuses)
   3. Do the work
```

---

## Migration: `00X_role_permissions.sql` (NEW)

Use the next free 00X number (likely 006).

```sql
-- Slice 38: store the bundle of permissions each role grants.
-- roles is tenant-scoped; production tenants get their own seed via
-- a future provisioning workflow. This migration seeds the dev tenant
-- (00000000-0000-0000-0000-000000000001) only.

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permissions JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Dev-tenant role seed. Two roles align with Slice 32's two realm roles.
-- field_worker  → users with realm role 'employee'
-- hr_standard   → users with realm role 'hr' (additive, also have 'employee')
INSERT INTO roles (tenant_id, code, label, keycloak_role, permissions)
VALUES
  ('00000000-0000-0000-0000-000000000001',
   'field_worker', 'Field Worker', 'employee',
   '["cert.submit","cert.view_own","compliance.view_own"]'::jsonb),
  ('00000000-0000-0000-0000-000000000001',
   'hr_standard',  'HR Standard',  'hr',
   '["employee.create","employee.list","employee.find",
     "employee.assign_role","employee.revoke_role",
     "employee.migrate_identity","employee.disable",
     "employee.grant_permission","employee.revoke_permission",
     "cert.approve","cert.list_all","compliance.view"]'::jsonb)
ON CONFLICT (tenant_id, code) DO UPDATE
  SET permissions = EXCLUDED.permissions, label = EXCLUDED.label;

-- Auto-grant: every employee in the dev tenant gets the field_worker role
-- on creation. Done via a follow-up SQL block when sync_employee runs (see
-- query layer below). Production tenants will configure default roles per
-- their HR onboarding policy.
```

If `hr_service.roles` doesn't yet exist with these columns, log a cross-slice
note pointing at Slice 05A and finish the rest of the slice — the
permissions code will compile against the `permissions` column either way.

---

## `db/queries/permissions.ts` (NEW)

```typescript
import type { PoolClient } from 'pg';

export async function getPermissionsForEmployee(
  client: PoolClient,
  employeeId: string,
): Promise<string[]> {
  const r = await client.query<{ p: string }>(
    `SELECT DISTINCT jsonb_array_elements_text(r.permissions) AS p
     FROM employee_roles er
     JOIN roles r ON r.id = er.role_id
     WHERE er.employee_id = $1`,
    [employeeId],
  );
  return r.rows.map(row => row.p).sort();
}

export async function grantRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
  grantedBy: string | null,
): Promise<void> {
  await client.query(
    `INSERT INTO employee_roles (employee_id, role_id, granted_by)
     SELECT $1, id, $4 FROM roles WHERE tenant_id = $2 AND code = $3
     ON CONFLICT DO NOTHING`,
    [employeeId, tenantId, roleCode, grantedBy],
  );
}

export async function revokeRoleByCode(
  client: PoolClient,
  tenantId: string,
  employeeId: string,
  roleCode: string,
): Promise<void> {
  await client.query(
    `DELETE FROM employee_roles
     WHERE employee_id = $1
       AND role_id IN (
         SELECT id FROM roles WHERE tenant_id = $2 AND code = $3
       )`,
    [employeeId, tenantId, roleCode],
  );
}
```

Note: this slice grants/revokes **roles** (which carry permissions),
not individual permissions. Roles are the unit of bundling. If a finer
"grant a single permission to one user" need ever surfaces, that's a
future schema change (employee_permissions direct join). Today: roles
are bundles, employee gets roles, permissions derive.

The MCP tools below are still named `grant_permission`/`revoke_permission`
because that's what the HR rep is conceptually doing — they pick a
permission, the system finds the role(s) that grant it. Optionally the tool
can accept a role code instead. **Decision deferred to Step 0 of this
slice's prompt** — implementer chooses the UX based on the role catalog.

---

## `mcp-server/auth.ts` (MODIFY) — add assertPermission

```typescript
import { getPool } from '../db/index.js';
import { withTenantRLS } from '../db/rls.js';
import { getPermissionsForEmployee } from '../db/queries/permissions.js';
import { findEmployeeByKeycloakId } from '../db/queries/employees.js';   // existing or add

// Per-request permission check. Reads from DB; cached per-request via
// closure variable would be a future optimisation, not in scope here.
export async function assertPermission(
  authInfo: { token: string } | undefined,
  required: string,
): Promise<void> {
  const ctx = extractAuthContext(authInfo);   // existing — throws on missing JWT bits
  const pool = getPool();
  const client = await pool.connect();
  try {
    const employee = await withTenantRLS(client, ctx.tenantId, async (tx) => {
      // tx still uses raw query since RLS sets the GUC; queries return what RLS allows.
      // employee lookup by sub (= keycloak_id) — assumes such a query exists in
      // db/queries/employees.ts. Add if missing.
      // returns { id } or throws.
      ...
    });
    const perms = await getPermissionsForEmployee(client, employee.id);
    if (!perms.includes(required)) {
      throw new Error(`Permission denied: missing '${required}'`);
    }
  } finally {
    client.release();
  }
}
```

The thrown error propagates as the MCP tool result error; bot's existing
JSON-parse path will see something like `{"isError": true, "content": [...]}`
in the new envelope shape (Slice 33 Step 0 will lock that exact shape).

---

## MCP tools

### `get-employee-permissions.tool.ts` (NEW — replaces get_employee_capabilities)

```
Input:  none (every authenticated user reads their own; no permission gate)
Output: { permissions: string[], roles: string[] }   ← roles = the role codes
                                                       attached, for UI display
                                                       and Slice 32 realm-role
                                                       check parity
```

Resolves the calling user's `cip_worker_id` from JWT → looks up
`employee_roles` rows → flattens role permissions → returns deduped sorted
list. Every authenticated user can call it (no permission required); used
by the bot's resolveAuthContext on every turn.

### `employee.grant-permission.tool.ts` (NEW)

```
Input:  { employeeId, role: string }   (grant a ROLE, which bundles permissions)
Auth:   requires 'hr' realm role + 'employee.grant_permission' permission
Action: insert employee_roles(employee_id, role_id) where role.code matches
        and role.tenant_id matches the caller's tenantId
        (idempotent — duplicate insert ignored)
Audit:  recordHrAction('employee.grant_permission', payload, ...)   (Slice 32)
Result: envelope per Slice 33 Step 0
```

### `employee.revoke-permission.tool.ts` (NEW)

```
Input:  { employeeId, role: string }
Auth:   requires 'hr' realm role + 'employee.revoke_permission' permission
Action: DELETE employee_roles WHERE employee_id = ? AND role_id matches code
Audit:  recordHrAction('employee.revoke_permission', payload, ...)
Special: refuses to revoke a role whose absence would orphan the user
         (no roles left). Use employee.disable instead.
```

### Modify existing MCP tools — add `requiredPermission` annotations

All hr-service MCP tools that exist today:
- `sync_employee` — **no** annotation (every authenticated user; first-call bootstrap)
- `get_employee_permissions` — **no** annotation (every user reads their own)
- `get_tenant_channel_config` — `requiredPermission: 'tenant.channel_config.view'`
  (probably; confirm with whatever caller uses it)

Future Slice 33 tools should declare:
- `employee.create` → `employee.create`
- `employee.list` → `employee.list`
- `employee.find` → `employee.find`
- `employee.assign_role` → `employee.assign_role`
- `employee.revoke_role` → `employee.revoke_role`
- `employee.migrate_identity` → `employee.migrate_identity`
- `employee.disable` → `employee.disable`

When Slice 33 runs, its prompt should reference this catalog and declare
the right annotations for each tool.

---

## Bot-side rename (mechanical)

| Before | After |
|---|---|
| `requiredCapability` (annotation lookup key) | `requiredPermission` |
| `ctx.capabilities` | `ctx.permissions` |
| `BotAuthContext.capabilities: Record<string, boolean>` | `BotAuthContext.permissions: Record<string, boolean>` |
| `get_employee_capabilities` (tool call name) | `get_employee_permissions` |
| `capsResult` / `capsResponse` (variable names) | `permsResult` / `permsResponse` |
| `capabilities: capsResponse.data?.capabilities ?? {}` | `permissions: permsResponse.data?.permissions ?? {}` |

5 files at most:
- `packages/teams-bot/src/mcp/tool-discovery.ts`
- `packages/teams-bot/src/auth/resolve-context.ts`
- `packages/teams-bot/src/bot.ts` (only if it directly references the field)
- `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` (doc-comment)
- Tests, if any

---

## Acceptance Criteria

- [ ] Migration `00X_role_permissions.sql` adds the `permissions JSONB` column
      and seeds two dev-tenant roles (`field_worker`, `hr_standard`) with
      sensible permission lists.
- [ ] `getPermissionsForEmployee` returns the deduped permission list for a
      given employee, joining `employee_roles` → `roles.permissions`.
- [ ] `assertPermission(authInfo, code)` throws unless the calling user has
      `code` in their permission list.
- [ ] `get_employee_permissions` MCP tool exists, returns
      `{ permissions: string[], roles: string[] }`, requires no permission.
- [ ] `employee.grant_permission` and `employee.revoke_permission` MCP tools
      exist, gated on `hr` realm role + their respective permissions, idempotent.
- [ ] Every successful AND failed grant/revoke call writes an `hr_actions`
      audit row (Slice 32).
- [ ] All references to `capabilities`/`capability` in bot and hr-service
      source code are renamed to `permissions`/`permission`. The MCP-protocol
      `capabilities` field is the only allowed remaining usage (and only if
      it actually appears).
- [ ] `discoverTools` filters by `requiredPermission` annotation against
      `ctx.permissions` map.
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- Permission-level direct grant (employee → permission, bypassing roles).
  Today, roles are the unit of grant. Future-add an `employee_permissions`
  direct-join table only when that need is real.
- Cross-tenant permission catalogs (a global "platform admin can do X in
  any tenant"). Today, permissions are tenant-scoped via roles.
- KC-side permission claim mapper (emit permissions array as a JWT claim).
  Server-side DB resolution is the source of truth this slice; JWT-based
  resolution is a future performance optimisation.
- Permission UI for HR reps (a frontend page to grant/revoke). MCP tools
  are the interface for now.

---

## Cross-Slice Notes

If Slice 32 hasn't run yet (realm roles `hr`/`employee` don't exist),
`assertPermission` calls that depend on the realm role check will need
adjustment — file a cross-slice note and continue. The permission layer is
independent of realm roles for the basic infrastructure; it just needs a
realm-role context for the HR-only grant/revoke tools.

If the existing `roles` table schema differs from what the migration
ALTER expects (e.g., it's missing `tenant_id` or `code` columns), file a
cross-slice note pointing at Slice 05A and the migration that introduced
the table.

If `findEmployeeByKeycloakId` doesn't yet exist in
`packages/hr-service/src/db/queries/employees.ts`, add it as part of this
slice (small standalone query — `SELECT id FROM employees WHERE
keycloak_id = $1 AND tenant_id = $2`). Don't pull in unrelated changes.

---

## Commit

```
slice(38): module-level permissions + permission management tools
```

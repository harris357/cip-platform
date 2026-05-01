# Slice 42B — Admin user bootstrap (PLATFORM_ADMIN_EMAIL → hr-service-admin role + `hr` realm role)

> **Prerequisite:** Slices 42A AND 42C complete. 42B builds on 42C's role layer + 42A's catalog/globs.
> **Package:** `@cip/hr-service`, `scripts/`, helm charts
> **Verify:** `pnpm -r run typecheck && bash scripts/bootstrap.sh && bash scripts/provision-tenant.sh ...`

---

## Why This Slice Exists

After 42A + 42C, every fresh cluster bootstrap leaves zero employees with admin permissions. To use any HR-admin tool, an operator has to manually:

1. Insert a row into `employee_role_assignments` linking themselves to a role with admin permissions
2. Hit Keycloak admin API to grant their KC user the `hr` realm role

We've run that pair of SQL/curl commands ~10 times this week. It's brittle, and worse, the same dance has to happen for every newly-provisioned production tenant.

42B closes the loop. **One env var (`PLATFORM_ADMIN_EMAIL`) drives admin elevation in any tenant where that email is provisioned.** Three idempotent paths apply it:

- `bootstrap.sh` — dev tenant on cluster bootstrap
- `provision-tenant.sh` — every newly-provisioned production tenant
- `sync_employee` MCP tool — auto-assigns on first sync as safety net (catches "operator forgot to seed before user signed in")

Defense-in-depth requires BOTH layers:
- **CIP role assignment** — gives the user permissions inside hr-service (the fine-grained gate)
- **KC realm role assignment** — puts `hr` in the JWT (the coarse gate)

Without one, the user fails one of the two checks and can't actually do anything. 42B does both.

**Per-tenant scope, per-tenant trigger.** The same email can be admin in some tenants and not provisioned in others. `PLATFORM_ADMIN_EMAIL` is a *condition checked in each tenant's provisioning path*, not a platform-wide auto-elevation. No super-admin blast radius.

---

## What 42B DOES

- Migration 013 seeds an `hr-service-admin` ROLE per tenant (and the four module-admin groups it contains), all using glob permissions
- `bootstrap.sh` and `provision-tenant.sh` ensure the admin email exists as an employee + assign the role + grant `hr` realm role via Keycloak Admin API
- `sync_employee` MCP tool auto-fires the same elevation on first sync if the email matches `PLATFORM_ADMIN_EMAIL`
- helm values + create-secrets.sh + .envrc operator instructions for `PLATFORM_ADMIN_EMAIL`

## What 42B DOES NOT do

- **No platform-wide super-admin.** Per-tenant only.
- **No new MCP tools.** Existing `employee.grant-permission` (now operates on roles per 42C) handles the assignment internally.
- **No additional KC realm roles.** Two existing roles (`hr`, `employee`) cover everything; admin gets `hr` (additive on top of `employee`).
- **No demotion / removal flow.** This slice only ADDS. To revoke admin: existing `employee.revoke-permission` MCP tool works (removes the role, and a future slice can add KC realm role revocation if needed).

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      013_hr_service_admin_role.sql           ← NEW: per-tenant admin role + 4 module-admin groups
  modules/employees/mcp-tools/
    sync-employee.ts                          ← MOD: auto-elevate on first sync if email matches
  services/
    keycloak-admin.ts                         ← (existing) used by sync-employee for realm role grant

scripts/
  bootstrap.sh                                ← MOD: new step "[8/8] Admin user elevation" (renumber existing steps)
  provision-tenant.sh                         ← MOD: new step "[7a/7] Admin user elevation"
  create-secrets.sh                           ← MOD: PLATFORM_ADMIN_EMAIL into hr-service-credentials

packages/hr-service/helm/
  values.yaml                                 ← MOD: PLATFORM_ADMIN_EMAIL env

slices/
  SLICE_42B_ADMIN_USER_BOOTSTRAP.md           ← this doc
```

---

## Read Before Writing

- `slices/SLICE_42A_PERMISSION_GROUPS_SCHEMA.md` — catalog + globs (foundation)
- `slices/SLICE_42C_ROLES_LAYER.md` — role/group/assignment shape (foundation)
- `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` — the auto-elevation hook lives here
- `packages/hr-service/src/services/keycloak-admin.ts` — `getKcAdmin` + `kcAdminRequest` helpers used by other MCP tools
- `packages/hr-service/src/modules/employees/mcp-tools/employee.assign-role.tool.ts` — example of calling KC Admin API to assign realm role
- `scripts/bootstrap.sh` — current dev tenant + employee seed; admin elevation goes at the end
- `scripts/provision-tenant.sh` — current tenant provisioning; admin elevation goes after virtual-key issuance

Do **not** modify `employee.assign-role.tool.ts` / `employee.revoke-role.tool.ts`. They handle KC realm roles for non-admin users — adjacent concern.

---

## Hard Rules (Seven Non-Negotiables)

1. **Per-tenant scope, per-tenant trigger.** The same email can be admin in tenant A and not provisioned in tenant B. Admin status flows only through tenants where the employee row exists. Never platform-wide.
2. **Both layers MUST be assigned together.** CIP role (DB) AND KC realm role (`hr` via Keycloak Admin API). Single-layer assignment leaves the user broken — passes one gate, fails the other.
3. **`PLATFORM_ADMIN_EMAIL` is the ONLY env var driving this.** Empty/unset = feature is a no-op (no auto-elevation, no errors). Lets dev clusters opt out.
4. **Idempotent at every layer.** Bootstrap, provisioning, and sync-employee all use ON CONFLICT DO NOTHING for the role assignment, and KC's `POST /role-mappings/realm` is naturally idempotent (HTTP 204 on re-add). Re-running any path is safe.
5. **The admin role uses globs.** `permissions: ['employee.*', 'cert.*', 'compliance.*', 'tenant.*']` — 4 entries leveraging 42A's expansion. Hard-coding the full permission list would silently rot when new permissions are added.
6. **Auto-assignment fires ONLY ON FIRST SYNC.** `sync_employee` runs every turn; the auto-elevate logic short-circuits if the employee row already existed (no re-firing). Otherwise revoking admin and the user re-signing in undoes the manual revocation.
7. **`tenantId` flows through every code path.** The admin role is tenant-scoped (one row per tenant). KC realm role assignment scopes to the tenant's KC realm (`getKcAdmin(tenantId)`).

---

## Migration: `013_hr_service_admin_role.sql`

The hr-service-admin role spans modules (employee + cert + compliance + tenant), so per the locked design it's a ROLE composing FOUR module-scoped admin groups, not one cross-module group.

```sql
BEGIN;

-- ─── 1. Per-module admin groups (4 per tenant) ───────────────────────────────
-- Each is single-module with a glob permission. Globs expand against the
-- catalog (Slice 42A) so new permissions are auto-included.

INSERT INTO permission_groups (
  tenant_id, service, module, code, label, permissions, is_system_role
)
SELECT
  t.id,
  'hr-service',
  m.module,
  'admin__' || m.module,                                  -- 'admin__cert', 'admin__employee', etc.
  upper(substring(m.module, 1, 1)) || substring(m.module, 2) || ' Module Admin',
  jsonb_build_array(m.module || '.*'),                    -- ['cert.*'] → glob-expanded at runtime
  true
FROM tenants t
CROSS JOIN (VALUES ('cert'), ('employee'), ('compliance'), ('tenant')) AS m(module)
ON CONFLICT (tenant_id, service, module, code) DO UPDATE
  SET permissions    = EXCLUDED.permissions,
      label          = EXCLUDED.label,
      is_system_role = true;

-- ─── 2. The hr-service-admin role per tenant ────────────────────────────────

INSERT INTO roles (
  tenant_id, code, label, description, keycloak_role, is_system_role
)
SELECT
  id,
  'hr-service-admin',
  'HR Service Administrator',
  'Cross-module admin: every permission in hr-service. Implies KC realm role hr.',
  'hr',
  true
FROM tenants
ON CONFLICT (tenant_id, code) DO UPDATE
  SET label = EXCLUDED.label,
      description = EXCLUDED.description,
      keycloak_role = EXCLUDED.keycloak_role,
      is_system_role = true;

-- ─── 3. Link the role to its 4 module-admin groups ──────────────────────────

INSERT INTO role_groups (role_id, group_id)
SELECT r.id, pg.id
FROM roles r
JOIN permission_groups pg
  ON pg.tenant_id = r.tenant_id
 AND pg.service   = 'hr-service'
 AND pg.code      LIKE 'admin\___%' ESCAPE '\'           -- matches admin__cert, admin__employee, etc.
WHERE r.code = 'hr-service-admin'
ON CONFLICT DO NOTHING;

COMMIT;
```

Result: every tenant has an `hr-service-admin` role containing 4 module-admin groups. Each group has 1 glob permission. Resolver expands → admin gets every permission in the catalog.

Re-runs are no-ops (everything ON CONFLICT). New permissions added to the catalog later are automatically picked up because the groups use globs.

---

## sync-employee.ts auto-elevation hook

Existing tool runs every turn. Add a fast-path that fires only when the employee row was just created.

Pseudocode:

```typescript
import { assignRoleToEmployee } from '../../../db/queries/roles.js';   // 42C helper
import { getKcAdmin, kcAdminRequest } from '../../../services/keycloak-admin.js';

const { employeeId, isNewlyCreated, kcUserId } = await syncEmployeeRow(...);
//   ^ existing logic; expose isNewlyCreated + kcUserId from syncEmployeeRow

const adminEmail = process.env['PLATFORM_ADMIN_EMAIL']?.toLowerCase().trim();
if (isNewlyCreated && adminEmail && email.toLowerCase().trim() === adminEmail) {
  // Step 1: assign the hr-service-admin CIP role (DB).
  // Idempotent ON CONFLICT inside the helper.
  await assignRoleToEmployee(client, tenantId, employeeId, 'hr-service-admin', /*grantedBy*/ null);

  // Step 2: grant the `hr` Keycloak realm role (defense-in-depth, JWT claim).
  // POST /role-mappings/realm is idempotent (204 on re-add).
  if (kcUserId) {
    try {
      const admin = await getKcAdmin(tenantId);
      const roleResp = await kcAdminRequest(admin, 'GET', `/roles/hr`);
      if (roleResp.ok) {
        const roleRep = await roleResp.json();
        await kcAdminRequest(admin, 'POST', `/users/${kcUserId}/role-mappings/realm`, [roleRep]);
      }
    } catch (err) {
      // Don't fail the sync if KC is briefly unavailable — log and continue.
      // The user will re-sync next turn; idempotent retry.
      console.warn(`[admin-elevate] KC realm role assignment failed: ${err}`);
    }
  }

  console.log(`[sync_employee] auto-elevated admin email=${email} tenantId=${tenantId}`);
}
```

Three details to get right:
- **`isNewlyCreated`** boolean — surface from the existing INSERT-or-UPDATE logic. New return field.
- **Lowercase + trim** both sides of email comparison. AAD/KC routinely vary case.
- **KC failure is logged, not fatal.** The sync turn shouldn't block on a KC API hiccup. Next turn re-fires (idempotent on both sides), so eventual consistency.

---

## bootstrap.sh — `[8/8] Admin user elevation`

The current `bootstrap.sh` ends at `[7/7]` (Langfuse seed from Slice 41 era). 42B adds `[8/8]`. Renumber existing labels.

```bash
# ── 8. Admin user elevation (Slice 42B) ──────────────────────────────────────
echo "[8/8] Elevating PLATFORM_ADMIN_EMAIL to hr-service-admin role..."
if [[ -z "${PLATFORM_ADMIN_EMAIL:-}" ]]; then
  echo "      WARNING: PLATFORM_ADMIN_EMAIL not in env — skipping admin elevation."
  echo "      Set it in .envrc to auto-elevate the dev admin user."
elif [[ -n "$POSTGRES_POD" && -n "${PG_USER_PASSWORD:-}" ]]; then
  # Step 1: DB-side — ensure employee + assign role.
  kubectl exec -i -n cip-infra "$POSTGRES_POD" -- \
    env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -v ON_ERROR_STOP=1 <<SQL 2>&1 \
      | sed 's/^/      /' || true
DO \$\$
DECLARE
  v_tenant_id   UUID := '00000000-0000-0000-0000-000000000001';
  v_email       TEXT := '${PLATFORM_ADMIN_EMAIL}';
  v_employee_id UUID;
  v_role_id     UUID;
BEGIN
  SELECT id INTO v_role_id
    FROM roles WHERE tenant_id = v_tenant_id AND code = 'hr-service-admin';

  IF v_role_id IS NULL THEN
    RAISE NOTICE 'hr-service-admin role not seeded for dev tenant — re-run migrations';
    RETURN;
  END IF;

  SELECT id INTO v_employee_id
    FROM employees WHERE tenant_id = v_tenant_id AND lower(email) = lower(v_email);

  IF v_employee_id IS NULL THEN
    INSERT INTO employees (tenant_id, email, full_name, identity_type, employment_type)
    VALUES (v_tenant_id, v_email, v_email, 'aad_federated', 'employee')
    RETURNING id INTO v_employee_id;
    RAISE NOTICE 'Created admin employee row id=%', v_employee_id;
  END IF;

  INSERT INTO employee_role_assignments (employee_id, role_id, granted_by)
  VALUES (v_employee_id, v_role_id, NULL)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'CIP role assignment complete: email=% tenant=% role=hr-service-admin', v_email, v_tenant_id;
END \$\$;
SQL

  # Step 2: KC-side — grant `hr` realm role to the matching KC user.
  # Re-uses the bootstrap script's existing KC port-forward + admin token.
  KC_USER_ID=$(curl -s "${KC_LOCAL}/admin/realms/cip-dev/users?email=${PLATFORM_ADMIN_EMAIL}" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
    | jq -r '.[0].id // empty')

  if [[ -n "$KC_USER_ID" ]]; then
    HR_ROLE_REP=$(curl -s "${KC_LOCAL}/admin/realms/cip-dev/roles/hr" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN")
    curl -s -o /dev/null -w "      KC hr realm role grant: HTTP %{http_code}\n" \
      -X POST "${KC_LOCAL}/admin/realms/cip-dev/users/${KC_USER_ID}/role-mappings/realm" \
      -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
      -H "Content-Type: application/json" \
      -d "[$HR_ROLE_REP]"
  else
    echo "      KC user not found for ${PLATFORM_ADMIN_EMAIL} — they'll get the realm role on first sync via sync_employee."
  fi
else
  echo "      WARNING: postgres pod or PG_USER_PASSWORD missing — skipping admin elevation"
fi
```

Note: bootstrap.sh runs the KC port-forward earlier (step 4); reuse the existing `$KC_ADMIN_TOKEN` and `$KC_LOCAL` if available, or open a fresh forward.

---

## provision-tenant.sh — `[7a/7] Admin user elevation`

Insert right after the existing virtual-key issuance step.

```bash
echo "[7a/7] Elevating admin email to hr-service-admin role for tenant $TENANT_ID..."
ADMIN_EMAIL_FOR_TENANT="${ADMIN_EMAIL:-${PLATFORM_ADMIN_EMAIL:-}}"

if [[ -z "$ADMIN_EMAIL_FOR_TENANT" ]]; then
  echo "      WARNING: neither --admin-email nor PLATFORM_ADMIN_EMAIL — skipping."
elif [[ -n "$POSTGRES_POD" && -n "${PG_USER_PASSWORD:-}" ]]; then
  # Same DO $$ block as bootstrap.sh, parameterised:
  #   v_tenant_id := $TENANT_ID
  #   v_email     := $ADMIN_EMAIL_FOR_TENANT
  # ...

  # KC-side: realm here is $REALM (per-tenant); admin user lookup by email
  # in the tenant's own realm.
  KC_USER_ID=$(curl -s "${KC_LOCAL}/admin/realms/${REALM}/users?email=${ADMIN_EMAIL_FOR_TENANT}" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" | jq -r '.[0].id // empty')
  # ... grant hr realm role same as bootstrap.sh ...
else
  echo "      WARNING: postgres pod or PG_USER_PASSWORD missing — skipping."
fi
```

Per-tenant precedence: explicit `--admin-email` (the customer's admin) wins; `PLATFORM_ADMIN_EMAIL` is a fallback for tenants where the operator forgot to specify.

---

## helm values + create-secrets

```yaml
# packages/hr-service/helm/values.yaml
env:
  ...
  # Slice 42B: email of the platform admin. When sync_employee runs for a
  # newly-created employee whose email matches (case-insensitive), they get
  # auto-assigned the hr-service-admin role + the `hr` Keycloak realm role.
  # Empty = feature off (no auto-elevation; admin must be assigned manually).
  PLATFORM_ADMIN_EMAIL: ""    # set per-deployment via .envrc + create-secrets
```

`create-secrets.sh`:

```bash
kubectl create secret generic hr-service-credentials \
  --namespace cip-app \
  ... existing entries ...
  --from-literal=PLATFORM_ADMIN_EMAIL="${PLATFORM_ADMIN_EMAIL:-}" \
  ...
```

`.envrc` (operator's responsibility):

```bash
export PLATFORM_ADMIN_EMAIL="aharris@idlevice.ca"
```

---

## Acceptance Criteria

- [ ] Migration `013_hr_service_admin_role.sql` applies cleanly. Each tenant has:
  - 4 permission_groups rows: `admin__cert`, `admin__employee`, `admin__compliance`, `admin__tenant` with glob permissions
  - 1 role: `hr-service-admin` with `keycloak_role='hr'`, `is_system_role=true`
  - 4 role_groups rows linking the role to the 4 module-admin groups
- [ ] Re-running migration 013 is a no-op (ON CONFLICT DO UPDATE keeps rows consistent; no duplicates).
- [ ] Bootstrap on a fresh cluster with `PLATFORM_ADMIN_EMAIL=aharris@idlevice.ca`:
  - Creates an employee row with that email in the dev tenant
  - Assigns the `hr-service-admin` role via `employee_role_assignments`
  - Grants the `hr` realm role to the matching KC user (verifiable via Keycloak admin console or `GET /role-mappings/realm`)
  - Logs both steps' completion
- [ ] Re-running bootstrap is idempotent — no errors, no duplicate assignments.
- [ ] Provisioning a new tenant with `--admin-email admin@acme.com`:
  - Creates the employee in the new tenant only (not in dev)
  - Assigns `hr-service-admin` role
  - Grants `hr` realm role in the tenant's KC realm
  - The same email signing into the bot for Acme has full HR-tool access
  - Same email signing into bot for dev (different `PLATFORM_ADMIN_EMAIL`) has no access UNLESS pre-provisioned
- [ ] **sync_employee auto-elevation**: starting from a clean state where the admin user has signed up via Teams but bootstrap hasn't elevated them yet:
  - First message: sync_employee creates the row. Auto-elevation fires: row in `employee_role_assignments` for `hr-service-admin`, `hr` realm role granted in KC.
  - Subsequent messages: `isNewlyCreated=false`, auto-elevation does NOT re-fire (verified via log line appearing exactly once across multiple turns).
- [ ] sync_employee auto-elevation does NOT trigger for emails not matching `PLATFORM_ADMIN_EMAIL`.
- [ ] When `PLATFORM_ADMIN_EMAIL` is empty, none of the three paths elevate anyone. Warning logged, no errors.
- [ ] Bot test: with admin elevated, after sign-in the classifier sees all six categories. "List all employees" routes through `cip-router-careful` and returns the employee list.
- [ ] **Defense-in-depth verified.** Manually revoke the `hr` realm role in KC. Bot turns immediately fail HR-only tools (coarse gate refuses). Re-run bootstrap to restore. Then revoke the `employee_role_assignments` row instead. HR tools fail at `assertPermission` (fine-grained gate refuses). Both gates work independently.
- [ ] `pnpm -r run typecheck` passes.
- [ ] `bash -n scripts/bootstrap.sh && bash -n scripts/provision-tenant.sh` pass.

---

## Out of Scope

- **Multiple admin emails per tenant.** `PLATFORM_ADMIN_EMAIL` is singular. If we ever need a list, future slice — env becomes comma-separated, SQL DO block iterates.
- **Demoting an existing admin.** This slice only adds. To remove admin: existing `employee.revoke-permission` MCP tool removes the role. Realm-role revocation would be its own micro-slice via `employee.revoke-role`.
- **Cross-tenant super-admin** for CIP staff. Per-tenant scope is a hard rule. If we eventually need cross-tenant read access for support, separate `super_admins` platform-scoped table — its own slice with audit story.
- **First-broker-login auto-default-role.** When a non-admin user first federates from AAD into KC, they currently land with NO realm role. Slice 42B doesn't change that — the `bot-auto-create` flow could be extended to assign `employee` by default, but that's a separate Keycloak-flow change. Defer.
- **MCP tool rename** (`employee_grant_permission` → `employee_assign_role`). Tool args are already `role` (accurate post-42C). The MCP tool NAME changes are a coordinated bot+hr-service rename for a future slice.
- **Admin role/group/permission CRUD MCP tools.** 42A adds read-only `permission_catalog_list`. 42C adds read-only `role_list`, `role_get`, `group_list`, `employee_get`. With the existing `employee_grant_permission`, `employee_revoke_permission`, `employee_create`, `employee_disable`, `employee_assign_role`, etc., that's enough for admins to manage users end-to-end via natural-language bot commands. CRUD tools for *defining new roles and groups* (`role_create`, `group_update`, `role_add_group`, …) are deferred to a future Slice 42D — today operators define roles via platform-core seed + ad-hoc SQL. Add 42D when SQL becomes painful.

---

## Cross-Slice Notes

- **Hard depends on Slice 42A and 42C.** Without 42C's `roles` and `role_groups` tables, migration 013 can't run. Without 42A's catalog + globs, the `cert.*` etc. glob entries don't expand.
- **No new cross-slice notes anticipated.** This slice only consumes 42A/42C primitives.

If `PLATFORM_ADMIN_EMAIL` is set to an email of a user who's already in another tenant's roles (e.g. `field_employee` from earlier testing), auto-elevation ADDS the `hr-service-admin` role — doesn't remove the existing one. Result: user has both roles in their tenant, permissions union (additive multi-role per Slice 42C). To clean up, manually remove the lower role.

---

## Commit

```
slice(42B): admin user bootstrap (PLATFORM_ADMIN_EMAIL → hr-service-admin role + hr realm role)

Migration 013 seeds an `hr-service-admin` role per tenant containing
four module-admin groups (cert, employee, compliance, tenant) — each
with a single glob permission ('cert.*', etc.) that 42A's resolver
expands at lookup time to all permissions in that module.

Three idempotent elevation paths driven by PLATFORM_ADMIN_EMAIL env:
1. bootstrap.sh — dev tenant
2. provision-tenant.sh — new production tenants (--admin-email
   takes precedence; falls back to PLATFORM_ADMIN_EMAIL)
3. sync_employee MCP tool — auto-elevates on FIRST sync if email
   matches (safety net for "operator forgot to seed beforehand")

Each path performs BOTH halves of defense-in-depth:
- CIP role assignment (employee_role_assignments → hr-service-admin)
- KC realm role assignment (POST /role-mappings/realm with `hr`)

Per-tenant scope, per-tenant trigger. No platform-wide super-admin.
The same email can be admin in some tenants and not provisioned in
others. Eliminates the recurring manual SQL+curl elevation step on
every fresh cluster bootstrap.

PLATFORM_ADMIN_EMAIL added to hr-service helm values + create-
secrets.sh + .envrc operator instructions.
```

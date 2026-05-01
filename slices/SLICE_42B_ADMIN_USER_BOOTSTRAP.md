# Slice 42B — Admin user bootstrap (PLATFORM_ADMIN_EMAIL → service-admin group)

> **Prerequisite:** Slice 42A (permission_groups + globs + catalog) complete.
> **Package:** `@cip/hr-service`, `scripts/`, helm charts
> **Verify:** `pnpm -r run typecheck && bash scripts/bootstrap.sh && bash scripts/provision-tenant.sh ...`

---

## Why This Slice Exists

Slice 42A introduced glob-aware permission groups but didn't change WHO has admin in any tenant. Today, on a fresh dev cluster, no employee has any permission until someone hand-grants `hr_standard` via SQL. Same for new tenants: provisioning creates the realm + groups + virtual key, but the admin email from `--admin-email` flag isn't tied to any actual employee row or group.

Two recurring pain points:
1. **Dev onboarding** — every fresh cluster bootstrap requires manually assigning permissions to test the bot. The pattern is so well-known we've run that SQL ~10 times this week.
2. **Production onboarding** — when a customer is provisioned, the operator has to do a separate SQL step to elevate their admin email to a usable group. Easy to forget, hard to verify.

Slice 42B closes the loop. **One env var (`PLATFORM_ADMIN_EMAIL`) drives admin elevation in any tenant where that email is provisioned.** The flow:

- New `hr-service-admin` system group seeded with cross-module globs (`employee.*, cert.*, compliance.*, tenant.*`) — Slice 42A's glob expansion makes this a 4-entry array instead of an enumerated list of 16.
- `bootstrap.sh` (dev) ensures the admin email exists as an employee in the dev tenant + assigns the admin group.
- `provision-tenant.sh` (prod) does the same for every newly-provisioned tenant.
- `sync_employee` MCP tool (the per-turn first-time-user creation path) auto-assigns the admin group to a freshly-synced employee whose email matches `PLATFORM_ADMIN_EMAIL`. This is the safety net for "operator forgot to seed."

**Per-tenant scope, per-tenant trigger** — confirmed Q5. The admin email is a *condition* checked in each tenant's provisioning path, not a platform-wide auto-elevation. An admin in Acme can't see Beta's data; they're only admin where they have a tenant-scoped employee row.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      012_hr_service_admin_group.sql          ← NEW: seed the cross-module admin group per tenant
  modules/employees/mcp-tools/
    sync-employee.ts                          ← MOD: auto-assign admin group on first sync if email matches
  index.ts                                    ← (no change — env var read at request time)

scripts/
  bootstrap.sh                                ← MOD: new step "[7/7] Admin user elevation"
  provision-tenant.sh                         ← MOD: new step "[7a/7] Admin user elevation"

packages/hr-service/helm/
  values.yaml                                 ← MOD: PLATFORM_ADMIN_EMAIL env

scripts/
  create-secrets.sh                           ← MOD: PLATFORM_ADMIN_EMAIL into hr-service-credentials

slices/
  SLICE_42B_ADMIN_USER_BOOTSTRAP.md           ← this doc
```

---

## Read Before Writing

- `slices/SLICE_42A_PERMISSION_GROUPS_SCHEMA.md` — fresh in scope from previous slice
- `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` — the auto-assignment hook lives here
- `scripts/bootstrap.sh` — current dev tenant + employee seed structure
- `scripts/provision-tenant.sh` — current tenant provisioning steps
- `packages/hr-service/src/db/migrations/008_role_permissions.sql` (now-renamed migration) for the seed pattern
- `packages/hr-service/src/db/queries/permissions.ts` — `assignGroupByCode` (renamed in 42A) is the helper for elevation

Do **not** modify `employee.assign-role.tool.ts` / `employee.revoke-role.tool.ts` — those are for KC realm roles, separate concern.

---

## Hard Rules (Seven Non-Negotiables)

1. **Per-tenant scope, per-tenant trigger.** The same email can be admin in tenant A and not provisioned in tenant B. Admin status only flows through to tenants where the employee row exists. Never platform-wide.
2. **`PLATFORM_ADMIN_EMAIL` is the ONLY env var driving this.** No additional configuration; if the var is empty, the slice's behaviour is a no-op (no auto-elevation, no errors). Lets dev clusters opt out.
3. **Idempotent at every layer.** Bootstrap, provisioning, and sync-employee all use ON CONFLICT DO NOTHING for the group assignment. Re-running any of them is safe.
4. **The admin group MUST use globs (per 42A).** Hard-coding the full permission list would silently rot every time a new permission is added. Use `permissions: ['employee.*', 'cert.*', 'compliance.*', 'tenant.*']`. Slice 42A's resolver expands these against the catalog.
5. **`tenantId` flows through every code path.** The admin group is tenant-scoped (one row per tenant). Auto-assignment scopes to the tenant the synced employee belongs to.
6. **Auto-assignment fires ONLY ON FIRST SYNC.** sync_employee runs every turn — the auto-elevate logic must short-circuit if the employee row already existed. Otherwise removing admin and the user re-signs in undoes the manual revocation.
7. **No new MCP tools.** Group assignment uses the existing `employee_grant_permission` (renamed internally to `assignGroupByCode` in 42A but the MCP tool name stays). Bootstrap/provisioning call the helper directly via SQL; the MCP path stays for HR-driven changes.

---

## Migration: `012_hr_service_admin_group.sql`

```sql
-- Slice 42B: seed the platform's hr-service admin group per tenant.
-- Cross-module: spans employee/cert/compliance/tenant. Uses globs (Slice
-- 42A) so new permissions added later are automatically inherited.
--
-- Idempotent: ON CONFLICT DO UPDATE (refresh permissions list on re-run).

INSERT INTO permission_groups (
  tenant_id, service, module, code, keycloak_role, label, permissions, is_system_role
)
SELECT
  t.id,
  'hr-service',
  'general',                  -- spans modules → 'general'
  'hr-service-admin',
  'hr',                       -- gates on hr realm role
  'HR Service Administrator',
  '["employee.*", "cert.*", "compliance.*", "tenant.*"]'::jsonb,
  true                        -- system group; operators shouldn't edit
FROM tenants t
ON CONFLICT (tenant_id, service, module, code) DO UPDATE
  SET permissions   = EXCLUDED.permissions,
      label         = EXCLUDED.label,
      keycloak_role = EXCLUDED.keycloak_role,
      is_system_role = true;
```

Run via `pnpm --filter @cip/hr-service run migrate` (the existing migration runner picks it up automatically).

---

## sync-employee.ts auto-assignment hook

The existing tool runs every turn. Add a fast-path that fires only when the employee row was just created (not on subsequent re-syncs). Pseudocode:

```typescript
const { employeeId, isNewlyCreated } = await syncEmployeeRow(...);

const adminEmail = process.env['PLATFORM_ADMIN_EMAIL']?.toLowerCase().trim();
if (isNewlyCreated && adminEmail && email.toLowerCase().trim() === adminEmail) {
  // Auto-assign the hr-service-admin group for THIS tenant.
  // Uses 42A's renamed helper. Idempotent ON CONFLICT.
  await assignGroupByCode(client, tenantId, employeeId, 'hr-service-admin', /*grantedBy*/ null);
  console.log(`[sync_employee] auto-elevated admin email=${email} tenantId=${tenantId}`);
}
```

The `isNewlyCreated` boolean is the new return field — the existing tool already does the upsert and knows whether INSERT fired vs UPDATE. Surface it.

Two important details:
- **Lowercase + trim** both sides before comparing — emails routinely show up with subtle case variations from different identity providers.
- **`grantedBy: null`** since the auto-elevate is a system action, not done by another employee. Audit trail still shows it via the timestamp + the log line.

---

## bootstrap.sh — `[7/7] Admin user elevation`

Renumber existing steps `[N/6]` → `[N/7]`. New step at the end:

```bash
# ── 7. Admin user elevation (Slice 42B) ──────────────────────────────────────
echo "[7/7] Elevating PLATFORM_ADMIN_EMAIL to hr-service-admin group..."
if [[ -z "${PLATFORM_ADMIN_EMAIL:-}" ]]; then
  echo "      WARNING: PLATFORM_ADMIN_EMAIL not in env — skipping admin elevation."
  echo "      Set it in .envrc to auto-elevate. Otherwise, manually grant via the bot."
elif [[ -n "$POSTGRES_POD" && -n "${PG_USER_PASSWORD:-}" ]]; then
  kubectl exec -i -n cip-infra "$POSTGRES_POD" -- \
    env PGPASSWORD="$PG_USER_PASSWORD" psql -U cipuser -d cip_hr -v ON_ERROR_STOP=1 <<SQL 2>&1 \
      | sed 's/^/      /' || true
DO \$\$
DECLARE
  v_employee_id UUID;
  v_group_id    UUID;
  v_tenant_id   UUID := '00000000-0000-0000-0000-000000000001';   -- dev tenant
  v_email       TEXT := '${PLATFORM_ADMIN_EMAIL}';
BEGIN
  -- Find the hr-service-admin group for the dev tenant (seeded by migration 012)
  SELECT id INTO v_group_id
    FROM permission_groups
   WHERE tenant_id = v_tenant_id AND service = 'hr-service' AND code = 'hr-service-admin';

  IF v_group_id IS NULL THEN
    RAISE NOTICE 'hr-service-admin group not seeded for dev tenant — re-run migrations';
    RETURN;
  END IF;

  -- Find or create the employee row.
  SELECT id INTO v_employee_id
    FROM employees WHERE tenant_id = v_tenant_id AND lower(email) = lower(v_email);

  IF v_employee_id IS NULL THEN
    INSERT INTO employees (tenant_id, email, full_name, identity_type, employment_type)
    VALUES (v_tenant_id, v_email, v_email, 'aad_federated', 'employee')
    RETURNING id INTO v_employee_id;
    RAISE NOTICE 'Created admin employee row id=%', v_employee_id;
  END IF;

  -- Assign the admin group (idempotent).
  INSERT INTO employee_group_assignments (employee_id, group_id, granted_by)
  VALUES (v_employee_id, v_group_id, NULL)
  ON CONFLICT DO NOTHING;

  RAISE NOTICE 'Admin elevation complete for email=% tenant=%', v_email, v_tenant_id;
END \$\$;
SQL
else
  echo "      WARNING: postgres pod or PG_USER_PASSWORD missing — skipping admin elevation"
fi
```

---

## provision-tenant.sh — `[7a/7] Admin user elevation`

Step inserted right after the existing virtual-key issuance. Same idempotent SQL block, but `v_tenant_id` comes from the `$TENANT_ID` shell variable being provisioned.

```bash
echo "[7a/7] Elevating admin email to hr-service-admin group for tenant $TENANT_ID..."
if [[ -z "${PLATFORM_ADMIN_EMAIL:-}" && -z "$ADMIN_EMAIL" ]]; then
  echo "      WARNING: neither PLATFORM_ADMIN_EMAIL nor --admin-email available — skipping."
else
  ADMIN_EMAIL_FOR_TENANT="${PLATFORM_ADMIN_EMAIL:-$ADMIN_EMAIL}"
  POSTGRES_POD=$(kubectl get pod -n cip-infra -l app.kubernetes.io/name=postgresql \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "")
  if [[ -n "$POSTGRES_POD" && -n "${PG_USER_PASSWORD:-}" ]]; then
    # Same DO $$ ... $$ block as bootstrap.sh, with v_tenant_id and v_email
    # parameterised from this script's environment.
    ...
  fi
fi
```

`provision-tenant.sh` accepts `--admin-email <addr>` as an existing arg. We use that as the per-tenant admin if it's set; fall back to `PLATFORM_ADMIN_EMAIL` if not. So:
- Dev → `PLATFORM_ADMIN_EMAIL` (single email seeded as admin in dev tenant)
- Production tenant Acme provisioned with `--admin-email admin@acme.com` → `admin@acme.com` is admin of the Acme tenant
- Customer also has `--admin-email` ALSO matching `PLATFORM_ADMIN_EMAIL` for cross-tenant CIP-staff access? Not by default — operator decides at provision time.

---

## helm values + create-secrets

Add `PLATFORM_ADMIN_EMAIL` to:
- `packages/hr-service/helm/values.yaml` env block
- `scripts/create-secrets.sh` — into `hr-service-credentials` secret (same pattern as PLATFORM_ADMIN_TOKEN)

```yaml
# packages/hr-service/helm/values.yaml
env:
  ...
  # Slice 42B: email of the platform admin. When sync_employee runs for a
  # newly-created employee whose email matches (case-insensitive), they get
  # auto-assigned the hr-service-admin group in their tenant. Empty = feature
  # off (no auto-elevation; admin must be assigned manually via SQL or MCP).
  PLATFORM_ADMIN_EMAIL: ""    # set per-deployment
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

- [ ] Migration `012_hr_service_admin_group.sql` applies cleanly. Each tenant in `tenants` table now has exactly one `hr-service-admin` permission group with `permissions: ['employee.*', 'cert.*', 'compliance.*', 'tenant.*']` and `is_system_role: true`.
- [ ] Re-running migration 012 is a no-op (ON CONFLICT DO UPDATE keeps the row consistent; no new versions).
- [ ] Bootstrap on a fresh cluster with `PLATFORM_ADMIN_EMAIL=aharris@idlevice.ca` set in `.envrc`:
  - Creates an employee row with that email in the dev tenant
  - Assigns the hr-service-admin group
  - Logs `Admin elevation complete for email=aharris@idlevice.ca tenant=00000000-...`
- [ ] Re-running bootstrap is idempotent — second run logs "Admin elevation complete" without errors, no duplicate assignments.
- [ ] Provisioning a new tenant with `--admin-email admin@acme.com`:
  - Creates the employee in the new tenant only (not in dev)
  - Assigns hr-service-admin
  - The same email signing into the bot for Acme has full HR-tool access
  - Same email signing into bot for dev (where `PLATFORM_ADMIN_EMAIL` differs) has no access UNLESS pre-provisioned
- [ ] sync_employee auto-elevation: starting from a clean state with no admin assignment, the user with email matching `PLATFORM_ADMIN_EMAIL` signs into the bot. After the first turn, `SELECT count(*) FROM employee_group_assignments WHERE employee_id = …` returns 1, and subsequent turns don't re-fire (verified by sync_employee log line appearing exactly once across multiple turns).
- [ ] sync_employee auto-elevation does NOT trigger for emails not matching `PLATFORM_ADMIN_EMAIL`.
- [ ] When `PLATFORM_ADMIN_EMAIL` is empty in env, none of the three paths (bootstrap/provisioning/sync) elevate anyone. They log a warning and continue.
- [ ] After the slice ships, the previously-needed manual SQL `INSERT INTO employee_group_assignments ... hr_standard ...` is never necessary again on a fresh cluster bootstrap.
- [ ] Bot test: with `PLATFORM_ADMIN_EMAIL` set and matching the user, after sign-in the classifier sees all six categories (cert_query, cert_action, hr_admin available because admin has all permissions). "List all employees" routes to `cip-router-careful` and returns the employee list.
- [ ] `pnpm -r run typecheck` passes.
- [ ] `bash -n scripts/bootstrap.sh && bash -n scripts/provision-tenant.sh` pass.

---

## Out of Scope

- **Multiple admin emails.** `PLATFORM_ADMIN_EMAIL` is singular. If we need a list, future slice — the env var becomes a comma-separated list and the SQL DO block iterates.
- **Demoting an existing admin.** This slice only adds. To remove admin from a user, use the existing `employee_revoke_permission` MCP tool (renamed internally to `removeGroupByCode` in 42A).
- **Cross-tenant super-admin.** Per-tenant scope is by design (Q5). A future slice could add a `super_admins` platform-scoped table if/when CIP staff need cross-tenant read access for support — but it'd be a Big Deal and have its own audit story.
- **Password / SSO / Keycloak realm-role assignment.** Slice 42B only handles permission group assignment in the CIP DB. The admin user still needs a Keycloak realm role (e.g., `hr`) to pass the bot's coarse gate. Bootstrap.sh already handles that for the dev tenant; provision-tenant.sh assumes the admin will sign in via AAD federation and bootstrap their own realm role. Worth verifying in the provisioning spec, separate slice.
- **Separating "admin" from a tenant role.** The admin group is per-tenant; the user IS in a tenant. CIP staff helping debug a customer would need to be a separate concern. Don't tackle in this slice.
- **MCP tool rename** (`employee_grant_permission` → `employee_assign_group`). Stays for a future coordinated rename slice.

---

## Cross-Slice Notes

- **Depends on Slice 42A.** Without 42A's `permission_groups` table + glob expansion, the admin group's `cert.*`/`employee.*` arrays don't expand and admin can't actually do anything. Hard prerequisite.
- **No new cross-slice notes anticipated.** This slice only consumes 42A primitives.

If `PLATFORM_ADMIN_EMAIL` is set to an email of a user who's already in tenants under multiple permission groups (e.g., `field_employee` from earlier testing), the auto-elevation ADDS the admin group — doesn't replace. Result: user is in both groups. That's the intended additive behaviour. To clean up, manually remove the lower group via `employee_revoke_permission`.

---

## Commit

```
slice(42B): admin user bootstrap via PLATFORM_ADMIN_EMAIL → hr-service-admin group

Migration 012 seeds an `hr-service-admin` permission group per tenant
with cross-module glob permissions (Slice 42A's expansion machinery
makes this `['employee.*', 'cert.*', 'compliance.*', 'tenant.*']`
instead of an enumerated list).

Three elevation paths, all idempotent:
1. bootstrap.sh — dev tenant, admin from PLATFORM_ADMIN_EMAIL
2. provision-tenant.sh — new tenants, admin from --admin-email or
   PLATFORM_ADMIN_EMAIL fallback
3. sync_employee MCP tool — auto-assigns admin group on FIRST sync
   when email matches PLATFORM_ADMIN_EMAIL (safety net)

Per-tenant scope: the same email can be admin in some tenants and
not provisioned in others. No platform-wide super-admin.

Eliminates the recurring "manually grant hr_standard via SQL" step
on every fresh cluster bootstrap.

PLATFORM_ADMIN_EMAIL added to hr-service helm values + create-
secrets.sh + .envrc operator instructions.
```

# Slice 70 — Temporal-ize provisioning (Phase A: data-side activities)

> **Why this exists:** Phase 8 (final) of Arc 1, completing 57E. The 562-line `scripts/provision-tenant.sh` does 8 things across 5 external systems (Keycloak, Kubernetes, AAD, LiteLLM, Postgres). The existing `TenantProvisioningWorkflow` covers ~50% — what's missing is admin user elevation, LiteLLM virtual key persistence, KC realm metadata + protocol mapper + confidential clients, per-tenant K8s secrets, and AAD IDP federation.
>
> **Honest scoping:** the external-system activities (K8s API, AAD federation, KC client management) are 600+ LOC each with non-trivial runtime semantics that can't be cleanly tested without a real cluster. Slice 70 covers **data-side activities only** — the ones that operate on Postgres tables we already own. KC client management, K8s secrets, and AAD federation become **slice 71** (follow-up).
>
> **What slice 70 (Phase A) delivers:**
> - `elevateAdminUserActivity` — DB-side admin user + Employee row + role assignment (replaces bash section 7a)
> - `persistLiteLLMVirtualKeyActivity` — writes the issued vkey to `cip_platform.tenant_settings.litellm_virtual_key` (replaces the silent gap where the bash script's vkey wasn't persisted)
> - `updateTenantIdpSecretRefActivity` — DB UPDATE on `cip_platform.tenant_identity_providers.secret_ref` (replaces bash section 5b; takes the secret_ref name as input — actual K8s secret creation stays in bash for now)
> - `TenantProvisioningWorkflow` updated to call all three after the existing chain
> - `provision-tenant.sh` keeps the K8s/AAD/KC-client steps but DELEGATES admin elevation + vkey persist + secret_ref update to the workflow path

> **Slice 71 (drafted, not implemented here):** the remaining bash sections — KC realm attributes + protocol mapper + clients (sections 3, 4, 5), per-tenant K8s secret create (section 5a), AAD IDP federation (section 6), KC admin role grant (part of 7a). Estimated ~600-800 LOC + K8s API client + retry/compensation logic.

---

## Files in scope

```
# ── New activities (data-side) ──────────────────────────────────────────
packages/platform-core/src/activities/elevate-admin-user.activity.ts            NEW (~120 LOC)
packages/platform-core/src/activities/persist-litellm-vkey.activity.ts          NEW (~50 LOC)
packages/platform-core/src/activities/update-tenant-idp-secret-ref.activity.ts  NEW (~50 LOC)
packages/platform-core/src/activities/index.ts                                  MOD (export new activities)

# ── Workflow update ─────────────────────────────────────────────────────
packages/platform-core/src/workflows/tenant-provisioning.workflow.ts            MOD (chain new activities; pass adminEmail through; persist vkey before notify)

# ── Workflow input shape ─────────────────────────────────────────────────
packages/shared/src/types/workflow.ts                                            MOD (add optional adminUserId to TenantProvisioningInput; backwards-compatible)

# ── Bash script: stop doing the things the workflow now owns ────────────
scripts/provision-tenant.sh                                                      MOD (drop section 7a admin DB elevation; still does K8s secret + AAD; calls platform-core POST /tenants which fires the workflow)
```

~250 LOC of new activity code + ~50 LOC of workflow plumbing.

---

## Hard rules

1. **Each new activity is idempotent.** Re-running with the same input is a no-op (or an upsert where applicable). Temporal retries on transient failure must be safe.

2. **Each activity has Zod-validated input AND output.** Per CLAUDE.md non-negotiable #5: every Activity that produces domain data calls `.parse()` on a Zod schema before returning.

3. **No K8s API access in this slice.** That goes in slice 71. `updateTenantIdpSecretRefActivity` takes the secret_ref NAME as a string argument; the actual K8s secret creation stays in the bash path for now.

4. **`provision-tenant.sh` STAYS** but admin elevation + vkey persist + secret_ref UPDATE move out of bash. The bash script becomes thinner (still ~400 lines vs the original 562). Slice 71 deletes it entirely once K8s + AAD activities land.

5. **Compensating actions** in the workflow: if `elevateAdminUser` fails, the workflow continues to `persistLiteLLMVirtualKey` and `provisionCompleteNotify` (admin elevation can be retried later via the bot's first-sync auto-elevation; not a hard failure). If `persistLiteLLMVirtualKey` fails, that IS a hard failure (LLM calls won't work without the key).

6. **Workflow ID pattern unchanged**: `TenantProvision-{tenantId}-{tenantId}` (already in place).

---

## Activity sketches

### `elevateAdminUserActivity`

```typescript
// packages/platform-core/src/activities/elevate-admin-user.activity.ts
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { getPool } from '../db/index.js';

const InputSchema = z.object({
  tenantId:    z.string().uuid(),
  adminEmail:  z.string().email(),
  adminFullName: z.string().min(1).optional(),
});
const OutputSchema = z.object({
  userId:      z.string().uuid(),
  employeeId:  z.string().uuid(),
  created:     z.boolean(),
});

export async function elevateAdminUserActivity(input: unknown): Promise<z.infer<typeof OutputSchema>> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.current_tenant_id', $1, true)`, [parsed.tenantId]);

    // Idempotent: find existing user by email; create if missing.
    let userIdRow = await client.query<{ id: string }>(
      `SELECT id FROM cip_platform.users WHERE tenant_id = $1 AND email = $2 LIMIT 1`,
      [parsed.tenantId, parsed.adminEmail],
    );
    let userId: string;
    let created = false;
    if (userIdRow.rows[0]) {
      userId = userIdRow.rows[0].id;
    } else {
      userId = randomUUID();
      created = true;
      await client.query(
        `INSERT INTO cip_platform.users (id, tenant_id, email, full_name, identity_type)
         VALUES ($1, $2, $3, $4, 'aad_federated')`,
        [userId, parsed.tenantId, parsed.adminEmail, parsed.adminFullName ?? parsed.adminEmail],
      );
    }

    // Idempotent employee row — ON CONFLICT DO NOTHING via UNIQUE(user_id) post-slice-65.
    await client.query(
      `INSERT INTO employees (id, tenant_id, user_id, employment_type, onboarding_source)
       VALUES ($1, $2, $1, 'employee', 'admin')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, parsed.tenantId],
    );

    // Idempotent role assignment — uses cip_platform tables post-slice-68.
    await client.query(
      `INSERT INTO cip_platform.user_role_assignments (user_id, role_id, tenant_id)
       SELECT $1, id, $2 FROM cip_platform.roles
        WHERE tenant_id = $2 AND code = 'hr-service-admin'
       ON CONFLICT DO NOTHING`,
      [userId, parsed.tenantId],
    );

    await client.query('COMMIT');
    return OutputSchema.parse({ userId, employeeId: userId, created });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
```

### `persistLiteLLMVirtualKeyActivity`

```typescript
// packages/platform-core/src/activities/persist-litellm-vkey.activity.ts
import { z } from 'zod';
import { getPool } from '../db/index.js';

const InputSchema = z.object({
  tenantId:           z.string().uuid(),
  litellmVirtualKey:  z.string().min(1),
});
const OutputSchema = z.object({ persisted: z.literal(true) });

export async function persistLiteLLMVirtualKeyActivity(input: unknown): Promise<z.infer<typeof OutputSchema>> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    // Upsert into tenant_settings (one row per tenant, unique on tenant_id).
    await client.query(
      `INSERT INTO cip_platform.tenant_settings (tenant_id, litellm_virtual_key)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE
         SET litellm_virtual_key = EXCLUDED.litellm_virtual_key,
             updated_at          = NOW()`,
      [parsed.tenantId, parsed.litellmVirtualKey],
    );
    return OutputSchema.parse({ persisted: true });
  } finally {
    client.release();
  }
}
```

### `updateTenantIdpSecretRefActivity`

```typescript
// packages/platform-core/src/activities/update-tenant-idp-secret-ref.activity.ts
import { z } from 'zod';
import { getPool } from '../db/index.js';

const InputSchema = z.object({
  tenantId:  z.string().uuid(),
  alias:     z.string().min(1).default('aad'),
  secretRef: z.string().min(1),
});
const OutputSchema = z.object({ updated: z.literal(true) });

export async function updateTenantIdpSecretRefActivity(input: unknown): Promise<z.infer<typeof OutputSchema>> {
  const parsed = InputSchema.parse(input);
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query(
      `UPDATE cip_platform.tenant_identity_providers
          SET secret_ref = $3, updated_at = NOW()
        WHERE tenant_id = $1 AND alias = $2`,
      [parsed.tenantId, parsed.alias, parsed.secretRef],
    );
    return OutputSchema.parse({ updated: true });
  } finally {
    client.release();
  }
}
```

### Workflow chain

```typescript
export async function TenantProvisioningWorkflow(input: TenantProvisioningInput): Promise<void> {
  await createKeycloakRealm({ tenantId: input.tenantId, tenantName: input.tenantName });
  await createTemporalNamespace({ tenantId: input.tenantId });
  await createNatsStreams({ tenantId: input.tenantId });
  await createObjectStoreBuckets({ tenantId: input.tenantId });
  await initTenantDatabase({ tenantId: input.tenantId });

  const litellmVirtualKey = await issueLiteLLMVirtualKey({
    tenantId:       input.tenantId,
    tier:           input.tier,
    budgetLimitUsd: input.budgetLimitUsd,
  });

  // Slice 70 NEW: persist vkey to tenant_settings before any service that
  // reads it boots up.
  await persistLiteLLMVirtualKey({
    tenantId:          input.tenantId,
    litellmVirtualKey,
  });

  // Slice 70 NEW: admin user elevation. Replaces bash section 7a's
  // direct DB INSERT. Non-fatal — bash retains a fallback path.
  try {
    await elevateAdminUser({
      tenantId:   input.tenantId,
      adminEmail: input.adminEmail,
    });
  } catch (err) {
    // Compensating: log + continue. First-sync auto-elevate (sync_employee
    // post-slice-66) covers the failure mode if admin signs in before
    // operators fix it.
    console.warn('[TenantProvisioningWorkflow] elevateAdminUser failed; bot first-sync will retry:', err);
  }

  await provisionCompleteNotify({
    tenantId:          input.tenantId,
    tenantName:        input.tenantName,
    adminEmail:        input.adminEmail,
    litellmVirtualKey,
  });
}
```

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean.**
2. **`pnpm --filter @cip/platform-core build` clean** — `dist/activities/elevate-admin-user.activity.js` etc. present.
3. **Workflow worker registers the new activities** at boot (visible in worker logs).
4. **Provisioning a new tenant** via `POST /tenants` auto-creates the admin user + Employee + role + persists vkey, with no manual SQL needed.
5. **Re-running the workflow on an existing tenant** is a no-op (idempotent INSERTs).

---

## Forward refs

- **Slice 71 — Temporal-ize KC + K8s + AAD** (the rest of provision-tenant.sh):
  - `createKeycloakRealmAttributesActivity` — sets cip_admin_email / cip_tier / cip_aad_tenant_id
  - `createKeycloakProtocolMapperActivity` — tenantId mapper at realm level
  - `createKeycloakClientsActivity` — teams-bot + hr-service confidential clients; captures secrets
  - `createK8sSecretActivity` — `tenant-aad-<tenantId>` with the captured KC client secret. Requires K8s API client + ServiceAccount permissions.
  - `createAadIdpFederationActivity` — KC POST /identity-provider/instances + OIDC mapper. Conditional on aadTenantId.
  - `grantKcAdminRealmRoleActivity` — KC realm role grant for the admin user (replaces bash section 7a's KC half).
  - Once all these land, `provision-tenant.sh` deletes entirely.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**platform-core (new activities):**
- `packages/platform-core/src/activities/elevate-admin-user.activity.ts` — find-or-create User; find-or-create Employee with `onboarding_source='admin'`; idempotent role assignment to `hr-service-admin`. RLS-scoped via `app.current_tenant_id`.
- `packages/platform-core/src/activities/persist-litellm-vkey.activity.ts` — `INSERT ... ON CONFLICT (tenant_id) DO UPDATE` for `tenant_settings.litellm_virtual_key`.
- `packages/platform-core/src/activities/update-tenant-idp-secret-ref.activity.ts` — `UPDATE` for `tenant_identity_providers.secret_ref` by (tenant_id, alias). Returns `rowsAffected` so caller can detect missing IDP rows.

**platform-core (modified):**
- `packages/platform-core/src/activities/index.ts` — exports the 3 new activities so the worker registers them.
- `packages/platform-core/src/workflows/tenant-provisioning.workflow.ts` — chain extended: after `issueLiteLLMVirtualKey`, calls `persistLiteLLMVirtualKey` (mandatory) and `elevateAdminUser` (best-effort, non-fatal). Then `provisionCompleteNotify`.

**Verification:**
- ✅ `pnpm -r run typecheck` clean (all 7 packages)
- ✅ `pnpm -r run build` clean
- ⏳ Runtime: a fresh tenant provisioning via `POST /tenants` should now persist the vkey to `tenant_settings` and elevate the admin user without any manual SQL. Slice 71 (KC clients + K8s + AAD) will close out the rest of `provision-tenant.sh`.

---

## Locked decisions

1. **Phase A (this slice) covers data-side activities only** — DB-bound work that operates on tables platform-core already owns.
2. **Phase B (slice 71) covers external-system activities** — KC client management, K8s secrets, AAD federation.
3. **`provision-tenant.sh` stays for slice 70**; gets thinner (sections 7a moves out). Deleted entirely in slice 71.
4. **Compensating action: elevateAdminUser failure is non-fatal** — bot's first-sync auto-elevation covers the worst case.
5. **persistLiteLLMVirtualKey failure IS fatal** — without the key, LLM calls don't work; bash had a manual fallback that we're surfacing as a workflow failure now.

Slice is locked. Proceeding to implementation.

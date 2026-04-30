# Slice 35 — Tenants Table + Tenant Identity Providers

> **Prerequisite:** Slices 23 (HR persistence + migration runner) and 27 (Tenant provisioning workflow) complete.
> **Package:** `@cip/shared`, `@cip/hr-service`, `@cip/platform-core`
> **Verify:** `pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/platform-core typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Today there is no canonical record that "tenant X exists" anywhere in the
system. `POST /tenants` on platform-core generates a random UUID and fires a
provisioning workflow but never persists it. The `tenant_settings` table is
config sidecar, not a tenant ledger. KC realms get created without any DB-side
counterpart. This means:

- Listing tenants requires scanning KC realms (slow, no domain metadata).
- Suspending a tenant has no single place to flip a flag.
- The bot, on receiving a Teams message, has no way to look up *which* CIP
  tenant the message belongs to without parsing AAD claims and asking KC.
- Different tenants will use different auth methods (AAD federation, Google
  Workspace, SMS magic-link for field ops, local credentials). There is no
  table that says "tenant Y supports auth method Z".

This slice adds two tables and a thin set of HTTP endpoints to expose them.
It does **not** modify the bot (Slice 36 does that) and does **not** rewrite
the existing TenantProvisioningWorkflow — it adds a row-insert step *before*
the workflow fires.

---

## What You Are Building

```
packages/hr-service/src/
  db/
    migrations/
      004_tenants.sql                    ← NEW: tenants + tenant_identity_providers
    schema.ts                            ← MODIFY: add Drizzle definitions for both tables
    queries/
      tenants.ts                         ← NEW: tenant queries (no RLS — platform-scope)
      tenant-identity-providers.ts       ← NEW: IDP queries
  routes/
    admin-tenants.ts                     ← NEW: 4 endpoints (see below)
  server.ts                              ← MODIFY: mount adminTenantsRouter

packages/shared/src/
  types/
    tenant.ts                            ← MODIFY: add Tenant + TenantIdentityProvider Zod schemas
                                                   plus IdentityProviderType + TenantStatus enums

packages/platform-core/src/
  routes/
    tenant.ts                            ← MODIFY: call hr-service /admin/tenants
                                                    BEFORE starting workflow
```

---

## Read Before Writing

- `packages/hr-service/src/db/migrations/002_domain_model.sql` (style reference)
- `packages/hr-service/src/db/migrations/` (for next free 00X number — should be 004)
- `packages/hr-service/src/db/schema.ts` (Drizzle conventions for column types)
- `packages/hr-service/src/db/queries/workers.ts` and `employees.ts` if present (query style)
- `packages/hr-service/src/server.ts` (router mount pattern)
- `packages/hr-service/src/routes/health.ts` (router pattern)
- `packages/shared/src/types/tenant.ts` (existing Tenant interface — extend, don't replace)
- `packages/platform-core/src/routes/tenant.ts` (existing POST /tenants)
- `docs/users-roles-auth-normalization-plan.md` § "Identity migration" (background — same shape applied at the org level)

Do **not** read or modify the bot. Slice 36 owns those changes.

---

## Hard Rules (Seven Non-Negotiables)

- `tenants.id` is the canonical tenant identifier. It is **also the KC realm
  name** when the tenant has a realm. One identifier across systems.
- `tenants` does **not** have a `tenant_id` column (it IS the tenant) and does
  **not** enable RLS — these are platform-level rows, not tenant data.
- `tenant_identity_providers` does **not** enable RLS for the same reason: the
  bot needs to look up "which CIP tenant matches this Entra GUID" across all
  rows. Treat as a registry.
- Secrets do **not** live in `tenant_identity_providers.config`. The column
  `secret_ref` holds a K8s secret name; secret values are fetched separately
  by services that need them.
- Zod `.parse()` validates every DB-layer return value before crossing into
  business logic.
- No `@anthropic-ai/sdk` imports.
- No raw NATS subjects (this slice doesn't publish events).
- Stubs forbidden — every function ships with a working body.

---

## Migration: `004_tenants.sql`

```sql
-- Platform-level tables: NOT tenant-scoped, NO RLS.
-- This is the canonical tenant ledger; everything else references tenants.id.

CREATE TABLE IF NOT EXISTS tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','suspended','deleted')),
  tier          TEXT NOT NULL DEFAULT 'standard'
                  CHECK (tier IN ('standard','enterprise','trial')),
  admin_email   TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  suspended_at  TIMESTAMPTZ,
  deleted_at    TIMESTAMPTZ
);
CREATE INDEX idx_tenants_status ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_identity_providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider_type   TEXT NOT NULL
                    CHECK (provider_type IN (
                      'aad_oidc','google_oidc','generic_oidc',
                      'saml','sms_otp','local_password'
                    )),
  alias           TEXT NOT NULL,                -- KC realm-scoped IDP alias
  enabled         BOOLEAN NOT NULL DEFAULT true,
  config          JSONB NOT NULL DEFAULT '{}',  -- type-specific, no secrets
  secret_ref      TEXT,                         -- K8s secret name only
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, alias)
);
CREATE INDEX idx_tip_tenant_enabled ON tenant_identity_providers(tenant_id) WHERE enabled = true;

-- Reverse-lookup index: bot resolves "which CIP tenant matches this Entra GUID?"
-- on every Teams message. Partial index keeps it small (only AAD rows).
CREATE INDEX idx_tip_aad_lookup
  ON tenant_identity_providers((config ->> 'aad_tenant_id'))
  WHERE provider_type = 'aad_oidc' AND enabled = true;
```

---

## Drizzle Schema Additions (`packages/hr-service/src/db/schema.ts`)

Append two `pgTable` definitions:

```typescript
export const tenants = pgTable('tenants', {
  id:           uuid('id').primaryKey().defaultRandom(),
  displayName:  text('display_name').notNull(),
  status:       text('status').notNull().default('active'),
  tier:         text('tier').notNull().default('standard'),
  adminEmail:   text('admin_email').notNull(),
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:    timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  suspendedAt:  timestamp('suspended_at', { withTimezone: true }),
  deletedAt:    timestamp('deleted_at',   { withTimezone: true }),
});

export const tenantIdentityProviders = pgTable('tenant_identity_providers', {
  id:            uuid('id').primaryKey().defaultRandom(),
  tenantId:      uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  providerType:  text('provider_type').notNull(),
  alias:         text('alias').notNull(),
  enabled:       boolean('enabled').notNull().default(true),
  config:        jsonb('config').notNull().default({}),
  secretRef:     text('secret_ref'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

---

## Shared Types (`packages/shared/src/types/tenant.ts`)

Replace any existing `Tenant` interface with this Zod-first shape:

```typescript
import { z } from 'zod';

export const TenantStatusSchema = z.enum(['active','suspended','deleted']);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantTierSchema = z.enum(['standard','enterprise','trial']);
export type TenantTier = z.infer<typeof TenantTierSchema>;

export const IdentityProviderTypeSchema = z.enum([
  'aad_oidc','google_oidc','generic_oidc','saml','sms_otp','local_password',
]);
export type IdentityProviderType = z.infer<typeof IdentityProviderTypeSchema>;

export const TenantSchema = z.object({
  id:           z.string().uuid(),
  displayName:  z.string().min(1),
  status:       TenantStatusSchema,
  tier:         TenantTierSchema,
  adminEmail:   z.string().email(),
  createdAt:    z.string(),
  updatedAt:    z.string(),
  suspendedAt:  z.string().nullable(),
  deletedAt:    z.string().nullable(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const TenantIdentityProviderSchema = z.object({
  id:            z.string().uuid(),
  tenantId:      z.string().uuid(),
  providerType:  IdentityProviderTypeSchema,
  alias:         z.string().min(1),
  enabled:       z.boolean(),
  config:        z.record(z.unknown()),
  secretRef:     z.string().nullable(),
  createdAt:     z.string(),
  updatedAt:     z.string(),
});
export type TenantIdentityProvider = z.infer<typeof TenantIdentityProviderSchema>;
```

If `TenantConfig` (used by `BotAuthContext`) exists elsewhere, leave it alone —
it's runtime config, not the canonical record. Add the new types alongside.

---

## Queries (`packages/hr-service/src/db/queries/tenants.ts`)

```typescript
import type { PoolClient } from 'pg';
import { TenantSchema, type Tenant } from '@cip/shared/src/types/tenant.js';

const TENANT_COLUMNS = `
  id, display_name AS "displayName", status, tier, admin_email AS "adminEmail",
  created_at AS "createdAt", updated_at AS "updatedAt",
  suspended_at AS "suspendedAt", deleted_at AS "deletedAt"
`;

export async function findTenantById(client: PoolClient, id: string): Promise<Tenant | null> {
  const r = await client.query(`SELECT ${TENANT_COLUMNS} FROM tenants WHERE id = $1`, [id]);
  return r.rows[0] ? TenantSchema.parse(r.rows[0]) : null;
}

export async function listTenants(client: PoolClient): Promise<Tenant[]> {
  const r = await client.query(`SELECT ${TENANT_COLUMNS} FROM tenants ORDER BY created_at DESC`);
  return r.rows.map((row: unknown) => TenantSchema.parse(row));
}

export async function insertTenant(
  client: PoolClient,
  input: { id: string; displayName: string; tier: string; adminEmail: string },
): Promise<Tenant> {
  const r = await client.query(
    `INSERT INTO tenants (id, display_name, tier, admin_email)
     VALUES ($1, $2, $3, $4)
     RETURNING ${TENANT_COLUMNS}`,
    [input.id, input.displayName, input.tier, input.adminEmail],
  );
  return TenantSchema.parse(r.rows[0]);
}

export async function updateTenantStatus(
  client: PoolClient,
  id: string,
  status: 'active' | 'suspended' | 'deleted',
): Promise<Tenant | null> {
  const ts = status === 'suspended' ? 'suspended_at' :
             status === 'deleted'   ? 'deleted_at'   : null;
  const setClause = ts
    ? `status = $2, ${ts} = NOW(), updated_at = NOW()`
    : `status = $2, suspended_at = NULL, deleted_at = NULL, updated_at = NOW()`;
  const r = await client.query(
    `UPDATE tenants SET ${setClause} WHERE id = $1 RETURNING ${TENANT_COLUMNS}`,
    [id, status],
  );
  return r.rows[0] ? TenantSchema.parse(r.rows[0]) : null;
}
```

These take `PoolClient` like the others, but **callers do NOT need to wrap in
`withTenantRLS`** — the table has no RLS. Use a plain `pool.connect()` flow.

---

## Queries (`packages/hr-service/src/db/queries/tenant-identity-providers.ts`)

```typescript
import type { PoolClient } from 'pg';
import {
  TenantIdentityProviderSchema,
  type TenantIdentityProvider,
} from '@cip/shared/src/types/tenant.js';

const TIP_COLUMNS = `
  id, tenant_id AS "tenantId", provider_type AS "providerType",
  alias, enabled, config, secret_ref AS "secretRef",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

export async function listProvidersForTenant(
  client: PoolClient,
  tenantId: string,
): Promise<TenantIdentityProvider[]> {
  const r = await client.query(
    `SELECT ${TIP_COLUMNS} FROM tenant_identity_providers
     WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );
  return r.rows.map((row: unknown) => TenantIdentityProviderSchema.parse(row));
}

export async function findActiveAadTenant(
  client: PoolClient,
  aadTenantId: string,
): Promise<{ tenant: { id: string; status: string }; provider: TenantIdentityProvider } | null> {
  // Single query: join tenants + IDP, return only if both active.
  const r = await client.query(
    `SELECT t.id AS "t_id", t.status AS "t_status",
            tip.id, tip.tenant_id AS "tenantId", tip.provider_type AS "providerType",
            tip.alias, tip.enabled, tip.config, tip.secret_ref AS "secretRef",
            tip.created_at AS "createdAt", tip.updated_at AS "updatedAt"
     FROM tenants t
     JOIN tenant_identity_providers tip ON tip.tenant_id = t.id
     WHERE tip.provider_type = 'aad_oidc'
       AND tip.config->>'aad_tenant_id' = $1
       AND tip.enabled = true
       AND t.status = 'active'
     LIMIT 1`,
    [aadTenantId],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0] as Record<string, unknown>;
  const provider = TenantIdentityProviderSchema.parse({
    id: row['id'], tenantId: row['tenantId'], providerType: row['providerType'],
    alias: row['alias'], enabled: row['enabled'], config: row['config'],
    secretRef: row['secretRef'], createdAt: row['createdAt'], updatedAt: row['updatedAt'],
  });
  return {
    tenant: { id: row['t_id'] as string, status: row['t_status'] as string },
    provider,
  };
}

export async function insertProvider(
  client: PoolClient,
  input: {
    tenantId:      string;
    providerType:  string;
    alias:         string;
    config:        Record<string, unknown>;
    secretRef?:    string;
    enabled?:      boolean;
  },
): Promise<TenantIdentityProvider> {
  const r = await client.query(
    `INSERT INTO tenant_identity_providers
       (tenant_id, provider_type, alias, enabled, config, secret_ref)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)
     RETURNING ${TIP_COLUMNS}`,
    [
      input.tenantId, input.providerType, input.alias,
      input.enabled ?? true, JSON.stringify(input.config),
      input.secretRef ?? null,
    ],
  );
  return TenantIdentityProviderSchema.parse(r.rows[0]);
}
```

---

## HTTP Endpoints (`packages/hr-service/src/routes/admin-tenants.ts`)

Four endpoints. **All four are platform-scoped (no tenant in URL)** so they
sit *outside* the `tenantAuthMiddleware` chain. Auth is by a shared platform
admin token in the `X-Platform-Admin-Token` header for now.

```typescript
import { Router, type IRouter } from 'express';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { getDb } from '../db/index.js';
import { insertTenant, listTenants, findTenantById, updateTenantStatus } from '../db/queries/tenants.js';
import { insertProvider, listProvidersForTenant, findActiveAadTenant } from '../db/queries/tenant-identity-providers.js';
import {
  TenantTierSchema, IdentityProviderTypeSchema,
} from '@cip/shared/src/types/tenant.js';

export const adminTenantsRouter: IRouter = Router();

// Simple shared-token auth — replace with proper platform-admin role in a
// future slice when there's a master/platform realm in KC.
adminTenantsRouter.use((req, res, next) => {
  const expected = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const got = req.header('x-platform-admin-token') ?? '';
  if (!expected || expected !== got) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
});

const CreateTenantSchema = z.object({
  displayName:  z.string().min(1),
  adminEmail:   z.string().email(),
  tier:         TenantTierSchema.optional(),
  identityProviders: z.array(z.object({
    providerType: IdentityProviderTypeSchema,
    alias:        z.string().min(1),
    config:       z.record(z.unknown()).default({}),
    secretRef:    z.string().optional(),
    enabled:      z.boolean().optional(),
  })).default([]),
});

adminTenantsRouter.post('/admin/tenants', async (req, res) => {
  const parse = CreateTenantSchema.safeParse(req.body);
  if (!parse.success) {
    res.status(400).json({ error: 'validation', issues: parse.error.issues });
    return;
  }
  const id = randomUUID();
  const pool = getDb();      // see "Db client" below
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tenant = await insertTenant(client, {
      id, displayName: parse.data.displayName,
      adminEmail: parse.data.adminEmail,
      tier: parse.data.tier ?? 'standard',
    });
    const providers = [];
    for (const idp of parse.data.identityProviders) {
      providers.push(await insertProvider(client, {
        tenantId: id, providerType: idp.providerType, alias: idp.alias,
        config: idp.config, ...(idp.secretRef ? { secretRef: idp.secretRef } : {}),
        ...(idp.enabled !== undefined ? { enabled: idp.enabled } : {}),
      }));
    }
    await client.query('COMMIT');
    res.status(201).json({ tenant, identityProviders: providers });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
});

adminTenantsRouter.get('/admin/tenants', async (_req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    res.json({ tenants: await listTenants(client) });
  } finally {
    client.release();
  }
});

adminTenantsRouter.get('/admin/tenants/:id', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const tenant = await findTenantById(client, req.params['id']!);
    if (!tenant) { res.status(404).json({ error: 'not_found' }); return; }
    const idps = await listProvidersForTenant(client, tenant.id);
    res.json({ tenant, identityProviders: idps });
  } finally {
    client.release();
  }
});

// Lookup endpoint used by the bot in Slice 36.
// Returns 404 if no active tenant matches; bot rejects the message in that case.
adminTenantsRouter.get('/admin/tenants/by-aad/:aadTenantId', async (req, res) => {
  const pool = getDb();
  const client = await pool.connect();
  try {
    const result = await findActiveAadTenant(client, req.params['aadTenantId']!);
    if (!result) { res.status(404).json({ error: 'not_found' }); return; }
    res.json(result);
  } finally {
    client.release();
  }
});
```

---

## Db client

If `getDb()` already exists in `hr-service/src/db/index.ts` and returns a
Drizzle instance, fine — but the queries above use raw `pool.connect()`. The
simplest path: export the `Pool` itself alongside the Drizzle instance:

```typescript
// packages/hr-service/src/db/index.ts (modify existing)
let _pool: Pool | null = null;
let _db:   Db   | null = null;

export function getPool(): Pool {
  if (!_pool) _pool = new Pool({ connectionString: process.env['DATABASE_URL_HR'] });
  return _pool;
}

export function getDb(): Db {
  if (!_db) _db = drizzle(getPool(), { schema });
  return _db;
}
```

Then queries import `getPool` (the routes above use `getDb()` for shape but
mean the underlying Pool — adjust signatures to take Pool/PoolClient
consistently).

---

## Mount the router (`packages/hr-service/src/server.ts`)

```typescript
import { adminTenantsRouter } from './routes/admin-tenants.js';
// ...
app.use(healthRouter);
app.use(adminTenantsRouter);   // BEFORE tenantAuthMiddleware — platform-scoped, has its own auth
app.use(tenantAuthMiddleware);
```

---

## Modify platform-core's `POST /tenants`

The existing route generates a UUID and starts a workflow. Change it to:
1. POST to hr-service's `/admin/tenants` first.
2. Use the returned tenant id for the workflow.
3. If the hr-service insert fails, return the error to the caller and DO NOT
   start the workflow.

```typescript
// packages/platform-core/src/routes/tenant.ts
tenantRouter.post('/tenants', async (req, res) => {
  const body = req.body as {
    tenantName: string;
    adminEmail: string;
    tier?: 'standard'|'enterprise'|'trial';
    aadTenantId?: string;
    budgetLimitUsd?: number;
  };

  // 1. Insert tenant + IDP rows via hr-service
  const hrUrl = process.env['HR_SERVICE_URL'] ?? 'http://hr-service.cip-app.svc.cluster.local:3000';
  const hrAdminToken = process.env['PLATFORM_ADMIN_TOKEN'] ?? '';
  const createBody = {
    displayName: body.tenantName,
    adminEmail:  body.adminEmail,
    tier:        body.tier ?? 'standard',
    identityProviders: body.aadTenantId
      ? [{ providerType: 'aad_oidc', alias: 'aad',
           config: { aad_tenant_id: body.aadTenantId } }]
      : [],
  };
  const createResp = await fetch(`${hrUrl}/admin/tenants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json',
               'X-Platform-Admin-Token': hrAdminToken },
    body: JSON.stringify(createBody),
  });
  if (!createResp.ok) {
    const text = await createResp.text();
    res.status(createResp.status).json({ error: 'tenant_create_failed', detail: text });
    return;
  }
  const { tenant } = await createResp.json() as { tenant: { id: string } };

  // 2. Start the existing provisioning workflow with the persisted UUID
  try {
    const client = await createTemporalClient();
    const handle = await client.workflow.start('TenantProvisioningWorkflow', {
      taskQueue: process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] ?? 'cip-platform-tasks',
      // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
      workflowId: `TenantProvision-${tenant.id}-${tenant.id}`,
      args: [{
        tenantId: tenant.id, tenantName: body.tenantName,
        adminEmail: body.adminEmail,
        tier: body.tier ?? 'standard',
        budgetLimitUsd: body.budgetLimitUsd ?? 100,
      }],
    });
    res.status(202).json({ tenantId: tenant.id, workflowId: handle.workflowId });
  } catch {
    res.status(500).json({ error: 'Failed to start provisioning workflow' });
  }
});
```

Add `HR_SERVICE_URL` and `PLATFORM_ADMIN_TOKEN` to `platform-core/helm/values.yaml`.

---

## Required env vars

| Variable | Where | Purpose |
|---|---|---|
| `PLATFORM_ADMIN_TOKEN` | hr-service + platform-core | Shared bearer token for `/admin/tenants*` endpoints. Same value in both. |
| `HR_SERVICE_URL` | platform-core | URL of hr-service in-cluster (`http://hr-service.cip-app.svc.cluster.local:3000`) |
| `DATABASE_URL_HR` | hr-service | Already set; tenants live in this DB |

The token should be a long random string in `.envrc` (and a corresponding K8s
secret). Document this in the slice's "manual ops" footnote.

---

## Acceptance Criteria

- [ ] Migration `004_tenants.sql` creates both tables with the exact schema
      shown, indexes included.
- [ ] Drizzle schema entries for both tables exist in `db/schema.ts`.
- [ ] Zod schemas + types exported from `@cip/shared/src/types/tenant.ts`.
- [ ] All four endpoints work:
      - `POST /admin/tenants` returns 201 with the new tenant + IDPs (validation 400, auth 401)
      - `GET  /admin/tenants` returns the list
      - `GET  /admin/tenants/:id` returns tenant + IDPs (404 if missing)
      - `GET  /admin/tenants/by-aad/:aadTenantId` returns 200 with `{tenant,provider}` for active matches; 404 otherwise
- [ ] All endpoints reject without `X-Platform-Admin-Token` header.
- [ ] `POST /tenants` in platform-core inserts the row before starting the workflow
      and returns the row's UUID as the `tenantId`.
- [ ] On hr-service insert failure, platform-core does NOT start the workflow.
- [ ] All Zod schemas `.parse()` (not `.safeParse()`) on persistence boundaries.
- [ ] Typecheck passes for `@cip/shared`, `@cip/hr-service`, `@cip/platform-core`.
- [ ] Full repo `pnpm -r run typecheck` passes.

---

## Out of Scope

- Bot changes — Slice 36.
- Reconciliation activity that compares tenant_identity_providers rows to KC
  IDP state — future slice.
- KC platform-admin realm/role replacing the shared `PLATFORM_ADMIN_TOKEN` —
  future slice.
- Per-tenant K8s secret management automation — operator-driven for now.
- Module-level auth policies (`module_auth_policies` table) — future slice.

---

## Cross-Slice Notes

If `getDb()` doesn't expose a Pool (only Drizzle), the route handlers can't
use raw `client.connect() → BEGIN → ROLLBACK`. Two acceptable resolutions:
1. Modify `db/index.ts` to also export `getPool()` (recommended; small change).
2. Use Drizzle's `db.transaction()` API and rewrite the queries against Drizzle.
   Bigger change; do this only if Drizzle transactions are the established pattern.

If platform-core has no HTTP client utility, just use the global `fetch()`
(Node 18+). Don't add a new HTTP-client dependency.

If a `Tenant` type already exists in `@cip/shared/src/types/tenant.ts` with
a different shape, keep it temporarily as `LegacyTenant` (for `BotAuthContext.tenantConfig`)
and add the new schemas alongside; log a cross-slice note pointing at any
file that imports the old shape so a future slice can clean it up.

---

## Commit

```
slice(35): tenants table + tenant_identity_providers + admin endpoints
```

# Slice 10 — Platform Core

> **Prerequisite:** Slices 01–03 complete.
> **Package:** `@cip/platform-core`
> **Verify:** `pnpm --filter @cip/platform-core typecheck`

---

## What You Are Building

```
packages/platform-core/src/
  index.ts
  server.ts
  routes/
    health.ts
    tenant.ts                           ← POST /tenants
  workers/
    temporal-worker.ts
  workflows/
    tenant-provisioning.workflow.ts
  activities/
    create-keycloak-realm.activity.ts
    create-temporal-namespace.activity.ts
    create-nats-streams.activity.ts
    create-object-store-buckets.activity.ts
    init-tenant-database.activity.ts    ← seeds roles, lookup tables, tenant_settings
    issue-litellm-virtual-key.activity.ts
    provision-complete-notify.activity.ts
```

---

## `TenantProvisioningWorkflow` — Execution Order

```
1. createKeycloakRealm(tenantId, tenantName)
2. createTemporalNamespace(tenantId)
3. createNatsStreams(tenantId)
4. createObjectStoreBuckets(tenantId)
5. initTenantDatabase(tenantId)          ← seeds all per-tenant data
6. issueLiteLLMVirtualKey(tenantId)      → litellmVirtualKey: string
7. provisionCompleteNotify(tenantId, adminEmail, litellmVirtualKey)
```

Every activity is idempotent — checks if the resource already exists before creating it.

Workflow ID:
```typescript
// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
workflowId: `TenantProvision-${tenantId}-${tenantId}`
```

---

## `initTenantDatabase` — What It Seeds

This activity runs SQL against the tenant's DB context. It must seed:

**System roles** (5 rows in `roles` table):

| keycloak_role | label | capabilities |
|---|---|---|
| `hr_admin` | HR Administrator | all capabilities true |
| `field_operations` | Field Operations | uploadCertForOthers, viewTeamCerts, resolveHitl |
| `field_employee` | Field Employee | uploadCertForSelf, viewOwnCerts |
| `compliance_manager` | Compliance Manager | viewAllCerts, viewCostReports |
| `site_manager` | Site Manager | viewTeamCerts, allocateEmployees |

**Empty tenant_settings row:**
```sql
INSERT INTO tenant_settings (tenant_id, channel_config)
VALUES ($1, '{}')
ON CONFLICT (tenant_id) DO NOTHING
```

**Certificate library stubs** — empty; tenant admin populates after provisioning. Insert one placeholder `certificate_types` row so the library is non-empty for the bot's help text.

All seeds use `ON CONFLICT ... DO NOTHING` — idempotent.

---

## Tenant Route

```typescript
// POST /tenants
// Body: { tenantName, adminEmail, tier, budgetLimitUsd }
router.post('/tenants', async (req, res) => {
  const tenantId = randomUUID()
  const client = await createTemporalClient()
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const handle = await client.workflow.start(tenantProvisioningWorkflow, {
    workflowId: `TenantProvision-${tenantId}-${tenantId}`,
    taskQueue: process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] ?? 'cip-platform-tasks',
    args: [{ tenantId, ...req.body }],
  })
  res.status(202).json({ tenantId, workflowId: handle.workflowId })
})
```

---

## Acceptance Criteria

- [ ] All 7 activities are stubs throwing `new Error('not implemented')` except where noted
- [ ] `initTenantDatabase` seeds the 5 system roles with correct capabilities JSONB
- [ ] `initTenantDatabase` inserts an empty `tenant_settings` row (idempotent)
- [ ] Workflow ID follows `{workflowType}-{tenantId}-{entityId}` with comment
- [ ] Task queue from env var — not hardcoded
- [ ] `issueLiteLLMVirtualKey` returns the key as its output (to be stored)
- [ ] `pnpm --filter @cip/platform-core typecheck` passes

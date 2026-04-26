# CIP Platform — Cross-Slice Notes

> Log issues discovered during a slice session that require a fix in an earlier slice.
> Resolve using `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` before starting the next slice.

---

## Template

```
### CS-NNN
- **Logged in:** Slice NN (name)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN
- **Issue:** One sentence.
- **Why it matters:** Which downstream slices or runtime behaviours break.
- **Fix:** Exact change required.
```

---

## Open Notes

### CS-001
- **Logged in:** Consistency review (env var audit)
- **Affects:** Slice 05A (HR Domain Schema), Slice 02 (Shared Types), Slice 07, Slice 14
- **File:** `packages/hr-service/src/db/migrations/002_domain_model.sql`, `packages/shared/src/types/tenant.ts`
- **Status:** OPEN
- **Issue:** `TenantConfig.litellmVirtualKey` has no persistent storage path — `tenant_settings` has no `litellm_virtual_key` column, so the key issued by `TenantProvisioningWorkflow` step 6 is lost after the workflow completes.
- **Why it matters:** Slices 07, 14 currently use a shared `LITELLM_VIRTUAL_KEY` env var (single key for all tenants). Per-tenant key isolation is impossible without a storage column. The bot already references `ctx.tenantConfig.litellmVirtualKey` — that field has no DB source.
- **Fix:**
  1. Add `litellm_virtual_key TEXT` column to `tenant_settings` in `002_domain_model.sql`
  2. Update `initTenantDatabase` (Slice 10) to accept and store the key from provisioning workflow output
  3. In Slices 07 and 14, replace `process.env['LITELLM_VIRTUAL_KEY']` with a DB lookup via `withTenantRLS`: `SELECT litellm_virtual_key FROM tenant_settings WHERE tenant_id = $tenantId`
  4. Update `TenantConfig` in `packages/shared/src/types/tenant.ts` to confirm `litellmVirtualKey` source is `tenant_settings.litellm_virtual_key`

---

## Resolved Notes

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

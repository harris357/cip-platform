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

_(none)_

---

## Resolved Notes

### CS-001
- **Logged in:** Consistency review (env var audit)
- **Affects:** Slice 05A (HR Domain Schema), Slice 02 (Shared Types), Slice 07, Slice 14
- **Status:** RESOLVED 2026-04-26
- **Fix applied:**
  1. Created `packages/hr-service/src/db/migrations/002_domain_model.sql` — `tenant_settings` table with `litellm_virtual_key TEXT NOT NULL` and RLS policy
  2. Updated `initTenantDatabase` to accept `litellmVirtualKey` and upsert into `tenant_settings`
  3. Reordered `TenantProvisioningWorkflow`: step 5 now issues the key, step 6 inits DB + stores the key
  4. `nodes.ts` (Slice 07): replaced `process.env['LITELLM_VIRTUAL_KEY']` with `withTenantRLS` DB lookup
  5. `bot.ts` (Slice 14): replaced `process.env['LITELLM_VIRTUAL_KEY']` with `withTenantRLS` DB lookup
  6. Confirmed `litellmVirtualKey` source comment in `TenantConfig`
  7. Fixed pre-existing shared type gaps found during typecheck: `TenantProvisioningInput`, `CertProcessingInput`, `CertUploadedEvent`, `CertProcessedEvent`, `CertExpiredEvent`, `Certification`, `Worker`, aligned `ExtractionResult` schema with consuming code

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

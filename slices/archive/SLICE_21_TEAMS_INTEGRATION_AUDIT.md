# Slice 21 — Teams Integration Audit

> **Prerequisite:** Slices 18, 19, 20 complete.
> **Package:** Cross-package read-only audit. Fixes only where a gap is trivial and blocking.
> **Verify:** `pnpm -r run typecheck` after any fixes.

---

## What You Are Doing

Slices 17–20 built and configured the Teams bot in isolation. This slice reads across
all four packages — `@cip/teams-bot`, `@cip/hr-service`, `@cip/platform-core`, `@cip/shared` —
and the Helm charts to verify that every integration point is correctly wired.

The output is:
1. A written audit report in your response (findings, gaps, status per integration point)
2. Cross-slice notes in `slices/CROSS_SLICE_NOTES.md` for any gap that requires a code fix
3. Trivial fixes applied inline (env var name typos, missing Helm keys, wrong constant names)
4. A clean `pnpm -r run typecheck` after any changes

Do NOT refactor, improve, or add features. Audit only.

---

## Integration Points to Audit

Work through these in order. For each point: read the relevant files, check the contract
is satisfied on both sides, and either confirm ✅ or log a cross-slice note.

---

### 1. MCP Tool Contract — Bot ↔ hr-service

The bot calls MCP tools from `hr-service`. Verify:

| Tool called by bot | Must exist in hr-service | Where |
|---|---|---|
| `get_employee_capabilities` | `packages/hr-service/src/modules/employees/mcp-tools/get-employee-capabilities.ts` | registered in `mcp-server/index.ts` |
| `get_tenant_channel_config` | `packages/hr-service/src/modules/settings/mcp-tools/get-tenant-channel-config.ts` | registered in `mcp-server/index.ts` |
| `process_document` | `packages/hr-service/src/modules/certifications/mcp-tools/process-document.ts` | registered in `mcp-server/index.ts` |

**Also check:** Does the bot's `resolve-context.ts` call `sync_employee` before
`get_employee_capabilities`? The Slice 17 spec requires it. If the call is missing,
log a cross-slice note — the employee record may not exist when capabilities are queried.

**Check:** Does every registered tool have `annotations.requiredCapability` set?
(Empty string is valid for unrestricted tools — but the key must be present so
`discoverTools` in `tool-discovery.ts` can filter correctly.)

---

### 2. Proactive Messaging — hr-service → teams-bot

The hr-service `notify-hitl.activity.ts` must send proactive messages to the teams-bot
`POST /proactive` endpoint. Verify:

- `notify-hitl.activity.ts` calls `fetch('${TEAMS_BOT_URL}/proactive', ...)` or equivalent
- `TEAMS_BOT_URL` is defined in `packages/hr-service/helm/values.yaml`
- The body matches the `POST /proactive` schema: `{ tenantId, channelType, card }`

If `notify-hitl.activity.ts` still throws `not implemented` that is expected (Slice 06 stub).
Check only that the URL env var is present in the Helm values — log a note if missing.

---

### 3. Teams SSO → Keycloak Token Exchange

The bot calls `exchangeAadForKeycloak` (moved to `bot.ts` in Slice 18). Verify:

- The Keycloak token exchange URL is:
  `${KEYCLOAK_URL}/realms/${tenantId}/protocol/openid-connect/token`
  Note: `tenantId` here is the Teams `channelData.tenant.id` (the Azure tenant GUID),
  and it is used as the Keycloak **realm name**. Verify that this assumption is documented
  in the function — it requires each Azure tenant to have a matching Keycloak realm.
- `KEYCLOAK_CLIENT_ID` and `KEYCLOAK_CLIENT_SECRET` are referenced correctly in `bot.ts`
  and present (via secret ref) in `packages/teams-bot/helm/values.yaml`
- `KEYCLOAK_URL` and `KEYCLOAK_REALM` in Helm values match the platform-core provisioning
  convention (realm name = tenantId from `TenantProvisioningWorkflow`)

---

### 4. MCP Server URL — Bot → hr-service

Verify:
- `MCP_SERVER_URL` is set in `packages/teams-bot/helm/values.yaml`
- The URL format matches how `packages/hr-service` exposes the MCP server
  (check `packages/hr-service/src/mcp-server/index.ts` for the mount path and port)
- `packages/hr-service/helm/values.yaml` exposes the MCP server on a consistent port
  and path that the bot's `MCP_SERVER_URL` references

---

### 5. Object Store Bucket + S3 Credentials Consistency

The bot uploads to the object store (Slice 19). The hr-service `fetch-document.activity.ts`
downloads from the same store. Verify:

- Both use the same bucket name env var (`OBJECT_STORE_BUCKET`)
- Both use the same S3 endpoint (`AWS_ENDPOINT_URL`) and region (`AWS_REGION`)
- Both use `forcePathStyle: true` (required for OVH S3)
- The key path written by the bot (`{tenantId}/{employeeId}/{uuid}/{filename}`) is
  readable by `fetch-document.activity.ts` without transformation

---

### 6. Teams App Manifest ↔ Azure Bot Registration

Verify that the manifest's `webApplicationInfo.resource` URI format matches what
Azure requires:
- Must be: `api://{BOT_DOMAIN}/{BOT_APP_ID}`
- `BOT_DOMAIN` must match the ingress host in `packages/teams-bot/helm/values.yaml`
  (currently `bot.dev.cip.idlevice.ca`)
- Confirm the BUILD.md Azure AD steps instruct the developer to register the correct
  Application ID URI (must match the manifest exactly)

---

### 7. Helm Chart Secrets Audit

Check every `secretKeyRef` and `envFrom.secretRef` across:
- `packages/teams-bot/helm/templates/deployment.yaml`
- `packages/hr-service/helm/templates/deployment.yaml`
- `packages/platform-core/helm/templates/deployment.yaml`

For each secret name referenced, confirm:
1. The secret name matches the naming convention in `scripts/create-secrets.sh`
   (or document that `create-secrets.sh` needs to be updated — log as cross-slice note)
2. Every key the application reads from env is either in `values.yaml env:` block
   or sourced from a secret that has that key defined

---

### 8. `sync_employee` MCP Tool — Missing Call in `resolve-context.ts`

This is a known candidate issue from the Slice 17 spec. If the bot's `resolve-context.ts`
does not call `sync_employee` before querying `get_employee_capabilities`, the query will
fail for first-time users because no employee record exists.

**Check:** Does `sync_employee` exist in `packages/hr-service/src/modules/employees/mcp-tools/`?
**Check:** Does `resolve-context.ts` call it before `get_employee_capabilities`?

If either is missing, log a cross-slice note with:
- Slice: 21 (Teams Integration Audit)
- Affects: Slice 18 (Teams Bot Auth) and Slice 09 (MCP Server)
- Fix: exactly what needs to be added and where

---

### 9. Channel Registry Persistence

The bot's `channel-registry.ts` stores conversation references in memory (24h TTL).
If the bot pod restarts, all registered channels are lost — proactive messages will
return 404 until the channel re-sends a message.

**This is a known architectural limitation, not a bug.** Do NOT fix it in this slice.
Log it as a cross-slice note marked **DEFERRED** (not OPEN) so it is tracked without
requiring resolution before launch.

---

## Cross-Slice Note Format

For every gap found, write a note in `slices/CROSS_SLICE_NOTES.md`:

```
### CS-NNN
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN   ← or DEFERRED for non-blocking known limitations
- **Issue:** One sentence describing what is wrong.
- **Why it matters:** Which runtime behaviour breaks if not fixed.
- **Fix:** Exact change required — or "Architectural decision required" for DEFERRED items.
```

Use the next available CS number after the highest existing resolved note.

---

## Acceptance Criteria

- [ ] All 9 integration points assessed — each confirmed ✅ or has a logged cross-slice note
- [ ] At least the following are explicitly confirmed ✅:
  - `get_employee_capabilities`, `get_tenant_channel_config`, `process_document` all registered in hr-service MCP
  - `MCP_SERVER_URL` in teams-bot Helm values resolves to the hr-service MCP endpoint
  - `BOT_DOMAIN` in teams-app manifest matches ingress host in teams-bot Helm values
  - `OBJECT_STORE_BUCKET` is consistent between teams-bot and hr-service Helm values
- [ ] Any trivial inline fixes applied and typechecked
- [ ] All new cross-slice notes written in correct format in `slices/CROSS_SLICE_NOTES.md`
- [ ] `pnpm -r run typecheck` passes (or failures are only in packages touched by other open slices)
- [ ] Audit report in session response covers every integration point with a clear ✅ or ⚠️

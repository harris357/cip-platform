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
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 19 (Teams Bot Object Store) + Slice 09 (MCP Server)
- **File:** `packages/teams-bot/helm/values.yaml` + `packages/hr-service/helm/values.yaml` + `packages/hr-service/helm/templates/service.yaml`
- **Status:** OPEN
- **Issue:** The bot's `MCP_SERVER_URL` points to port `4001`, but the hr-service MCP server defaults to `MCP_PORT ?? 3001`; additionally the hr-service Kubernetes Service only exposes port `3000` (the main REST API), so the MCP port is unreachable in-cluster regardless of which port is used.
- **Why it matters:** Every MCP call from the bot (`get_employee_capabilities`, `get_tenant_channel_config`, `process_document`) will fail at runtime with a connection refused error — the entire bot is non-functional.
- **Fix:** (1) Define `MCP_PORT: 4001` in `packages/hr-service/helm/values.yaml` so the MCP express app binds on 4001. (2) Add a second named port to `packages/hr-service/helm/templates/service.yaml` exposing `4001 → 4001` alongside the existing `3000` port. Alternative: consolidate both the REST API and MCP handler onto port `3000` under separate paths (requires changes to `mcp-server/index.ts` and the main express entry point — architectural decision required).

### CS-002
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 18 (Teams Bot SSO Auth) + Slice 09 (MCP Server / Employee Module)
- **File:** `packages/hr-service/src/modules/employees/mcp-tools/` + `packages/teams-bot/src/auth/resolve-context.ts`
- **Status:** OPEN
- **Issue:** The `sync_employee` MCP tool does not exist in hr-service, and `resolve-context.ts` calls `get_employee_capabilities` directly without first upsert-syncing the employee record from Azure AD claims.
- **Why it matters:** First-time users (no existing employee row) will receive an empty capabilities set, causing all `requiredCapability` checks to fail and the bot to offer no tools.
- **Fix:** (1) Create `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts` — a tool with empty args schema that upserts an employee row from `authInfo.token` claims (aadOid, email, displayName) and registers it in `registerEmployeeTools`. (2) In `packages/teams-bot/src/auth/resolve-context.ts`, call `sync_employee` via `client.callTool({ name: 'sync_employee', arguments: {} })` before the `get_employee_capabilities` call.

### CS-003
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 19 (Teams Bot Object Store) + future fetch-document implementation
- **File:** `packages/hr-service/helm/values.yaml` + `scripts/create-secrets.sh`
- **Status:** OPEN
- **Issue:** The hr-service `fetch-document.activity.ts` will need S3 env vars when implemented, but `OBJECT_STORE_BUCKET`, `AWS_ENDPOINT_URL`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, and `AWS_SECRET_ACCESS_KEY` are absent from both `packages/hr-service/helm/values.yaml` and the `hr-service-credentials` secret in `scripts/create-secrets.sh`.
- **Why it matters:** When `fetchDocumentActivity` is implemented and the certification workflow runs, the activity will fail with missing-env-var errors instead of fetching the document the bot uploaded.
- **Fix:** Add to `packages/hr-service/helm/values.yaml` env block: `OBJECT_STORE_BUCKET: cip-uploads`, `AWS_ENDPOINT_URL: https://s3.bhs.io.cloud.ovh.net`, `AWS_REGION: BHS`. Add to the `hr-service-credentials` secret in `scripts/create-secrets.sh`: `--from-literal=AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-}"` and `--from-literal=AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-}"`.

### CS-004
- **Logged in:** Slice 21 (Teams Integration Audit)
- **Affects:** Slice 17 (Teams Bot Core) — known architectural limitation
- **File:** `packages/teams-bot/src/teams-protocol/channel-registry.ts`
- **Status:** DEFERRED
- **Issue:** The channel registry stores conversation references in a process-local in-memory Map with a 24-hour TTL; all registered channels are lost on pod restart.
- **Why it matters:** After a restart, `POST /proactive` will return 404 for every previously registered channel until each user sends a new message to re-register — proactive HITL notifications will be silently dropped in the interim.
- **Fix:** Architectural decision required — options are: Redis-backed registry (new infra dependency), NATS key-value store (already in-cluster), or PostgreSQL table in hr-service. Resolve before production launch.

---

## Resolved Notes

_(prior resolved notes archived to slices/archive/CROSS_SLICE_NOTES.md)_

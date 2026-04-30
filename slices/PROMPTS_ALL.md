# CIP Platform — Session Prompts

One prompt per slice. Copy verbatim into Claude Code to start the session.
Each prompt is self-contained — do not load any file not listed under "Read before writing."

---

_(new prompts will be added here as slices are defined)_

---

## PROMPT Slice 32 — Realm Roles + Auth Context + HR Audit Table

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 32 — Realm Roles `hr`/`employee`, Auth Context, HR Audit
Package: @cip/shared, @cip/hr-service, plus scripts/bootstrap.sh
Verify: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_32_REALM_ROLES_AND_AUDIT.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md   §§ "Decisions resolved", "Audit"

Goal: Plumbing only — create realm roles `hr` and `employee` in KC, change
Slice 25's default-role assignment to `employee`, extend `AuthContext` with
`roles[]`, add `requireRealmRole(role)` middleware, add `hr_actions` table +
`recordHrAction` wrapper. No new MCP tools. No new workflows.

Files to modify:
- packages/shared/src/utils/tenant-context.ts
- packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts
- scripts/bootstrap.sh

Files to create:
- packages/hr-service/src/db/migrations/00X_hr_actions.sql   (use next free 00X)
- packages/hr-service/src/db/queries/hr-actions.ts
- packages/hr-service/src/services/audit.ts

Hard rules (Seven Non-Negotiables):
- tenantId on every domain interface — `hr_actions.tenant_id` is NOT NULL with RLS
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body
- recordHrAction must NOT throw on DB write failure (logs only)

Acceptance: see "Acceptance Criteria" in SLICE_32_REALM_ROLES_AND_AUDIT.md.

If a finding requires changing earlier slice output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(32): hr/employee realm roles, auth-context roles[], hr_actions audit table
```

---

## PROMPT Slice 33 — HR MCP Tools + Identity Migration + Disable Workflows

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 33 — HR MCP Tools, Identity Migration, Disable Workflows
Package: @cip/hr-service
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md
- docs/identity-and-auth-architecture.md

STEP 0 BEFORE ANY HANDLER CODE:

  Investigate the @modelcontextprotocol/sdk version pinned in this repo and
  determine whether it exposes structuredContent natively or only content[].
  Look at how existing tools under
  packages/hr-service/src/modules/certifications/mcp-tools/ shape their
  results. Then PAUSE and post a brief report to the user containing:
    - SDK version
    - structuredContent supported (yes/no)
    - what existing tools do today
    - your recommended envelope shape (default proposal:
        { ok, code?, data?, message })
    - your recommended carrier (native structuredContent OR JSON-in-text)
  Wait for user confirmation. Then implement uniformly across all 7 tools.

  Workflows + activities below can be written in parallel with the
  investigation; only the seven `*.tool.ts` handlers wait on the answer.

Goal: Expose 7 HR MCP tools gated by 'hr' realm role; add the
EmployeeIdentityMigrationWorkflow and EmployeeDisableWorkflow with their
activities; extract Slice 31's onboarding logic into a shared service so
employee.create and POST /admin/employees share the same code path; write
hr_actions audit rows for every tool call.

Files to create / modify: see SLICE_33 spec § "What You Are Building".
There are 12 new files (3 services, 2 workflows, 10 activities, 7 MCP tools,
1 tool registry) and a handful of modifications (worker registration, mcp
server mount, route handler thinning).

Hard rules (Seven Non-Negotiables):
- tenantId from authInfo.token (MCP) / req.auth (HTTP), never input schemas
- Workflow ID patterns:
    EmployeeIdentityMigrationWorkflow → EmployeeMigrate-${tenantId}-${employeeId}
    EmployeeDisableWorkflow            → EmployeeDisable-${tenantId}-${employeeId}
  with the // Workflow ID pattern: ... comment line above each start call
- Every activity producing domain data validates output via Zod .parse()
- No @anthropic-ai/sdk imports
- NATS subjects only via Subjects.* — log a cross-slice note if you need to
  add new subjects to @cip/shared
- Stubs forbidden — every function ships with a working body
  (Step 0 investigation does not count as a stub; tool handlers are written
  AFTER the envelope is confirmed)

Acceptance: see "Acceptance Criteria" in SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md.

If a finding requires changing earlier slice output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(33): hr mcp tools, identity migration workflows, disable workflow, audit wiring
```

---

## PROMPT Slice 31 — Employee Admin Provisioning Endpoint

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 31 — Employee Admin Provisioning Endpoint
Package: @cip/hr-service (plus scripts/bootstrap.sh)
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md                       (check for any open notes that touch hr-service)
- docs/identity-and-auth-architecture.md            (background — three-store identity model + JWT AG provisioning rule)
- docs/users-roles-auth-normalization-plan.md       (role model — `hr` is the gate, not `admin`)

Prerequisite: Slice 32 must be complete. This slice consumes its outputs:
  - `requireRealmRole('hr')` middleware from @cip/shared
  - `recordHrAction` from packages/hr-service/src/services/audit.ts
  - `hr` and `employee` realm roles seeded in KC

Goal: Add authenticated POST /admin/employees on hr-service that inserts an
employees row, starts EmployeeOnboardingWorkflow, and records an hr_actions
audit row. Extract the provisioning logic into services/employee-onboarding.ts
so Slice 33's employee.create MCP tool can reuse it. Add the oid → BROKER_ID
mapper to the aad IDP in scripts/bootstrap.sh so JWT AG can match users
provisioned by this endpoint.

Files to create:
- packages/hr-service/src/types/employee.ts
- packages/hr-service/src/db/queries/employees.ts
- packages/hr-service/src/services/employee-onboarding.ts   (the actual logic)
- packages/hr-service/src/routes/admin-employees.ts          (thin route wrapper)

Files to modify:
- packages/hr-service/src/server.ts                 (mount the new router)
- scripts/bootstrap.sh                              (add aad-oid-as-user-id mapper)

Optional (do iff scope allows; otherwise log a cross-slice note for Slice 25):
- packages/hr-service/src/modules/employees/activities/  (add persistKeycloakIdActivity)
- packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts (call it)

Hard rules (Seven Non-Negotiables):
- tenantId comes from req.auth, never from request body
- Endpoint is gated on `hr` realm role (NOT `admin` — see normalization plan)
- Workflow ID pattern + comment line above the start call
- Zod .parse() on persistence boundaries
- No @anthropic-ai/sdk imports
- No raw NATS subjects
- Stubs forbidden — every function has a working body
- Every successful AND failed onboardEmployee call writes an hr_actions row

Acceptance: see "Acceptance Criteria" in SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md.

If a finding requires changing an earlier slice's output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(31): admin employee provisioning endpoint + AAD oid mapper
```

---

## PROMPT Slice 35 — Tenants + Tenant Identity Providers Tables

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 35 — Tenants Table + Tenant Identity Providers
Package: @cip/shared, @cip/hr-service, @cip/platform-core
Verify: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/platform-core typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md                          (check for any open notes)
- docs/users-roles-auth-normalization-plan.md          (background)

Goal: Add `tenants` and `tenant_identity_providers` tables (cip_hr DB,
no RLS — platform-level). Drizzle schema, Zod types in @cip/shared,
queries, four admin endpoints on hr-service guarded by a shared
PLATFORM_ADMIN_TOKEN header, and a modification to platform-core's
POST /tenants so it inserts the tenant row BEFORE starting the
existing TenantProvisioningWorkflow.

Files to create:
- packages/hr-service/src/db/migrations/004_tenants.sql
- packages/hr-service/src/db/queries/tenants.ts
- packages/hr-service/src/db/queries/tenant-identity-providers.ts
- packages/hr-service/src/routes/admin-tenants.ts

Files to modify:
- packages/hr-service/src/db/schema.ts
- packages/hr-service/src/db/index.ts            (export getPool() if not present)
- packages/hr-service/src/server.ts              (mount adminTenantsRouter)
- packages/shared/src/types/tenant.ts            (Zod schemas + types)
- packages/platform-core/src/routes/tenant.ts    (insert via hr-service before workflow)
- packages/platform-core/helm/values.yaml        (HR_SERVICE_URL, PLATFORM_ADMIN_TOKEN env)
- packages/hr-service/helm/values.yaml           (PLATFORM_ADMIN_TOKEN env)

Hard rules (Seven Non-Negotiables):
- tenants.id IS the canonical tenant identifier (= KC realm name)
- tenants and tenant_identity_providers do NOT have RLS — platform-scope
- Secrets do NOT live in tenant_identity_providers.config — secret_ref names a K8s secret
- Zod .parse() on every DB-layer return value
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body

Acceptance: see "Acceptance Criteria" in SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(35): tenants table + tenant_identity_providers + admin endpoints
```

---

## PROMPT Slice 36 — Multi-Tenant Teams Bot

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 36 — Multi-Tenant Teams Bot (in-code tenant routing)
Package: @cip/teams-bot
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck

Prerequisite: Slice 35 must be complete. This slice consumes its
GET /admin/tenants/by-aad/:aadTenantId endpoint.

Read before writing:
- CLAUDE.md
- slices/SLICE_36_MULTI_TENANT_BOT.md   (this slice's full spec)
- slices/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md   § "HTTP Endpoints"
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md

Goal: Bot resolves the AAD tenant ID on each incoming activity, looks up
the matching CIP tenant via hr-service, binds a TenantContext for that
request, and uses per-realm KC client secrets for the JWT-AG exchange.
Reject messages from unknown or inactive tenants with [security] log
lines. Six-step pipeline: extract → resolve → validate → bind → exchange
→ downstream.

Files to create:
- packages/teams-bot/src/auth/tenant-resolver.ts
- packages/teams-bot/src/auth/keycloak-secrets.ts

Files to modify:
- packages/teams-bot/src/bot.ts
    onMessage: resolve tenant BEFORE token check
    onSigninInvokeActivity: resolve tenant BEFORE token exchange
    handleAuthenticatedMessage: take TenantContext as a parameter
    exchangeAadForKeycloak: signature change, takes TenantContext (no env)
- packages/teams-bot/src/auth/resolve-context.ts
    Take TenantContext, use ctx.cipTenantId (NOT channelData.tenant.id)
- packages/teams-bot/helm/values.yaml
    Add HR_SERVICE_URL, KEYCLOAK_REALM_FALLBACK; document KEYCLOAK_CLIENT_SECRETS
    JSON-map secret + PLATFORM_ADMIN_TOKEN secret

Hard rules (Seven Non-Negotiables):
- AAD tenant ID (from activity.channelData.tenant.id) is NOT the CIP tenant ID
- Reject every failure mode: missing AAD tenant, no matching CIP tenant,
  inactive tenant, no enabled aad_oidc provider, no client secret available
- 5-minute cache TTL on the tenant lookup; key = AAD tenant ID
- All log lines in the message-handling pipeline include cipTenantId
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body

Acceptance: see "Acceptance Criteria" in SLICE_36_MULTI_TENANT_BOT.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(36): multi-tenant bot — AAD tenant resolution + per-realm KC secrets
```

---

## PROMPT Slice 37 — Per-Tenant KC Client Secrets via K8s Secrets

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 37 — Per-Tenant KC Client Secrets via K8s Secrets + Bot Dynamic Loading
Package: @cip/teams-bot, scripts/provision-tenant.sh
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck

Prerequisite: Slices 35 and 36 must be complete. This slice consumes
tenant_identity_providers.secret_ref (Slice 35 schema) and replaces the
KEYCLOAK_CLIENT_SECRETS JSON-map env (Slice 36 placeholder) with K8s
secret reads via the bot's ServiceAccount.

Read before writing:
- CLAUDE.md
- slices/SLICE_37_PER_TENANT_KC_SECRETS.md   (this slice's full spec)
- slices/SLICE_36_MULTI_TENANT_BOT.md         § "Per-realm secrets"
- slices/CROSS_SLICE_NOTES.md
- docs/identity-and-auth-architecture.md      § "Configuration reference"

Goal: replace the env-var JSON-map for per-tenant KC client secrets with
real K8s secrets named `tenant-aad-<cipTenantId>`, read by the bot
dynamically via its ServiceAccount on cache miss (5-minute TTL).
Keep KEYCLOAK_CLIENT_SECRETS map + KEYCLOAK_CLIENT_SECRET single-value
env as dev-only fallback paths. provision-tenant.sh now creates the
K8s secret AND updates tenant_identity_providers.secret_ref so the bot
picks it up without a pod restart.

Files to create:
- packages/teams-bot/src/auth/k8s-secret-loader.ts
- packages/teams-bot/helm/templates/service-account.yaml

Files to modify:
- packages/teams-bot/src/auth/keycloak-secrets.ts   (resolveKcClientSecret async fn)
- packages/teams-bot/src/auth/tenant-resolver.ts    (call new resolver, new error variants)
- packages/teams-bot/helm/values.yaml               (POD_NAMESPACE downward API + SA toggle)
- packages/teams-bot/helm/templates/deployment.yaml (serviceAccountName)
- packages/teams-bot/package.json                   (add @kubernetes/client-node)
- scripts/provision-tenant.sh                       (create K8s secret + update secret_ref)

Hard rules (Seven Non-Negotiables):
- secret_ref naming convention: tenant-aad-<cipTenantId> (lowercase UUID)
- Bot ServiceAccount RBAC scoped to namespace cip-app, secrets:get only
- 5-minute in-memory cache for K8s secret reads
- Failure modes return typed errors: 'k8s_secret_not_found', 'k8s_secret_read_failed'
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Existing dev path (KEYCLOAK_CLIENT_SECRET fallback) must keep working
  for the existing dev tenant (no secret_ref set in DB)

Acceptance: see "Acceptance Criteria" in SLICE_37_PER_TENANT_KC_SECRETS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(37): per-tenant KC client secrets via K8s secrets + bot dynamic loading
```

---

## PROMPT Slice 38 — Module-Level Permissions

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 38 — Module-Level Permissions + Permission Management Tools
Package: @cip/teams-bot, @cip/hr-service
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Prerequisite: Slice 32 (realm roles 'hr' and 'employee') must be complete.
Independent of Slices 31/33/35/36/37.

Read before writing:
- CLAUDE.md
- slices/SLICE_38_PERMISSIONS.md   (this slice's full spec)
- slices/SLICE_32_REALM_ROLES_AND_AUDIT.md
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md  (background — two-layer model)

Goal: Replace the empty `capabilities` plumbing with a working two-layer
access model. Realm role (Slice 32) gates which service the user can call;
permission (this slice) gates which TOOL within that service. Bot's
discoverTools filters tools by requiredPermission annotation against the
user's permission map; tool handlers also assert server-side (defense
in depth).

THIS SLICE INCLUDES A RENAME: every reference to "capabilities" /
"capability" in bot and hr-service source code becomes "permissions" /
"permission". The word "capability" must not appear in deliverables
(except in any comment that explicitly references the MCP protocol's
unrelated `capabilities` field — these are protocol-level, not auth-level).

Files to create:
- packages/hr-service/src/db/migrations/00X_role_permissions.sql
- packages/hr-service/src/db/queries/permissions.ts
- packages/hr-service/src/modules/employees/mcp-tools/get-employee-permissions.tool.ts
    (replaces / renames any existing get-employee-capabilities tool stub)
- packages/hr-service/src/modules/employees/mcp-tools/employee.grant-permission.tool.ts
- packages/hr-service/src/modules/employees/mcp-tools/employee.revoke-permission.tool.ts

Files to modify:
- packages/teams-bot/src/auth/resolve-context.ts
    rename ctx.capabilities → ctx.permissions; call get_employee_permissions
- packages/teams-bot/src/mcp/tool-discovery.ts
    annotation lookup key requiredCapability → requiredPermission
- packages/teams-bot/src/bot.ts (if it references the field directly)
- packages/hr-service/src/mcp-server/auth.ts
    add assertPermission(authInfo, code) helper (DB-backed)
- packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts
    doc-comment update
- packages/hr-service/src/modules/employees/mcp-tools/index.ts
    register new tools, drop old get_employee_capabilities registration

Hard rules (Seven Non-Negotiables):
- Permission code format: <resource>.<action>, lowercase, dots not colons
- tenantId flows through unchanged; permissions are tenant-scoped
- Defense in depth: bot discoverTools filter (UX) AND tool handler
  assertPermission (security) — both required
- Zod-validated outputs from new MCP tools
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Don't touch Slice 33's MCP tool implementations (those don't exist
  yet); when Slice 33 runs, it will declare requiredPermission against
  this slice's catalog

Acceptance: see "Acceptance Criteria" in SLICE_38_PERMISSIONS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(38): module-level permissions + permission management tools
```

---

## PROMPT CROSS-SLICE

```
You are working on the CIP Platform TypeScript monorepo.

Session: CROSS-SLICE — Resolve outstanding cross-slice notes

Read before writing:
- slices/CROSS_SLICE_NOTES.md
- Each file listed under "File:" in every OPEN note

For each OPEN note:
1. Apply the exact fix described in the note
2. Run typecheck on the affected package: pnpm --filter @cip/<package> typecheck
3. Mark the note RESOLVED with today's date and a one-line "Fix applied:" summary

Do not fix DEFERRED notes. Do not touch files not listed in an open note.
Finish with: pnpm -r run typecheck
```

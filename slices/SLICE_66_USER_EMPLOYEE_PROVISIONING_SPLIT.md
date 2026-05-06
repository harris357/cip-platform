# Slice 66 — User/Employee provisioning split

> **Why this exists:** Today (and through slices 64-65), `sync_employee` auto-creates BOTH a User and an Employee on the bot's first sync per user. That conflates two concepts: "this person has a verified identity" (User) vs. "this person has an employment relationship in this tenant's HR module" (Employee). After Arc 1 the platform supports multiple modules — a tenant's CFO accessing financial dashboards is a User but probably not an HR Employee.
>
> **What this slice does:**
> - Splits the auto-sync into two operations: `sync_user` (platform-core) and `ensure_employee` (hr-service)
> - Bot's resolve-context.ts calls `sync_user` always, `ensure_employee` only when an HR tool is invoked
> - New `tenant_settings.auto_onboard_employees` boolean (default `true` for backwards compat)
> - Documents three onboarding paths and which is used when:
>   - **Admin-driven**: existing `employee.create` MCP tool kicks `EmployeeOnboardingWorkflow`
>   - **Workflow-driven**: HRIS integration calls `EmployeeOnboardingWorkflow` directly with batches
>   - **Self-onboarding**: `auto_onboard_employees=true` makes `ensure_employee` auto-create on first HR access
>
> **First MCP server on platform-core.** Slice 66 is when `packages/platform-core/src/mcp-server/` is created. Initially exposes only `sync_user`. Slice 69 expands it with user/role/tenant tools.
>
> Hard cut on the bot side. The old `sync_employee` MCP tool retires; bot stops calling it. hr-service's MCP server keeps tool plumbing for backwards compat with any other caller, but the tool's behavior moves to "ensure_employee" semantics (lookup-or-conditionally-create).

---

## Files in scope

```
# ── platform-core: first MCP server + sync_user tool ────────────────────
packages/platform-core/src/mcp-server/                                     NEW directory
├── index.ts                                                               NEW (~80 LOC — express + StreamableHTTPServerTransport, attachBearerAuth)
├── auth.ts                                                                NEW (~70 LOC — extractAuthContext from JWT)
└── tools/
    └── sync-user.ts                                                       NEW (~140 LOC — JWT-driven user + identity-link upsert)

packages/platform-core/src/index.ts                                        MOD (start MCP server alongside HTTP + Temporal)

# ── platform-core: tenant_settings auto_onboard_employees ───────────────
packages/platform-core/src/db/migrations/006_auto_onboard_employees.sql    NEW (~10 LOC — ADD COLUMN auto_onboard_employees BOOLEAN NOT NULL DEFAULT true)
packages/platform-core/src/db/schema.ts                                    MOD (+ autoOnboardEmployees on tenantSettings)

# ── hr-service: ensure_employee replaces sync_employee semantics ────────
packages/hr-service/src/modules/employees/mcp-tools/ensure-employee.ts     NEW (~150 LOC — find employee by user_id; if absent and tenant.auto_onboard=true, create; otherwise return not_provisioned)
packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts       MOD (DELETED — replaced by ensure-employee.ts)
packages/hr-service/src/modules/employees/mcp-tools/index.ts               MOD (register ensureEmployee, drop syncEmployee)
packages/hr-service/src/modules/employees/mcp-tools/employee.create.tool.ts  MOD (verify path uses platform-core for User creation; explicit Employee insert if user already exists)

# ── hr-service: read tenant.auto_onboard_employees ──────────────────────
packages/hr-service/src/db/queries/tenant-settings.ts                       NEW (~40 LOC — getTenantAutoOnboard reads cip_platform.tenant_settings.auto_onboard_employees)

# ── teams-bot: resolve-context.ts switches to two-call pattern ──────────
packages/teams-bot/src/auth/resolve-context.ts                              MOD (call platform-core sync_user always; call hr-service ensure_employee opportunistically)
packages/teams-bot/src/mcp/multi-server-client.ts                           MOD (verify platform-core MCP endpoint registered)
packages/teams-bot/helm/values.yaml                                          MOD (PLATFORM_CORE_MCP_URL env)

# ── shared types ────────────────────────────────────────────────────────
packages/shared/src/types/tenant.ts                                          MOD (+ autoOnboardEmployees on TenantSettingsSchema)
packages/shared/src/types/onboarding.ts                                      NEW (~30 LOC — OnboardingSourceSchema enum: 'admin'|'workflow'|'self'; OnboardingResultSchema)

# ── docs / runbook ──────────────────────────────────────────────────────
docs/operations/employee-onboarding.md                                       NEW (~80 lines — three paths documented; per-tenant config rationale)
```

~400-600 LOC of new code. ~10 files modified.

---

## Hard rules

1. **Two-stage provisioning is the new normal.** Bot ALWAYS calls `sync_user` (platform-core). Bot calls `ensure_employee` (hr-service) ONLY when an HR-flavored tool is in the candidate set OR explicitly when an HR-tool execution returns `not_provisioned`. Never both implicitly.

2. **`sync_user` is idempotent and reads only the JWT.** No args from caller. Same shape as the slice-64 sync-employee triple-write but only writes user + identity links — no employee row.

3. **`ensure_employee` is the single authority on Employee creation from the bot's path.** It does NOT create platform-core Users — that's `sync_user`'s job. If `ensure_employee` finds no User row by `user_id`, it returns a structured error (`user_not_found` — bot retries `sync_user` first). If User exists but Employee doesn't:
   - If tenant has `auto_onboard_employees=true`: create Employee with default fields (employmentType='employee'), kick `EmployeeOnboardingWorkflow` for downstream side effects (KC role assignment, welcome notification)
   - If `auto_onboard_employees=false`: return `not_provisioned_in_hr` — admin must run the explicit onboarding path

4. **Old `sync_employee` MCP tool is removed entirely.** Hard cut per D9. No backwards compat shim. Bot's resolve-context.ts changes in this slice; the hr-service MCP server stops registering `sync_employee`. Any external caller hitting it gets `tool_not_found`.

5. **Three onboarding paths are documented and tested:**

   | Path | Trigger | Effect |
   |---|---|---|
   | Admin-driven | `employee.create` MCP tool (existing) | Calls EmployeeOnboardingWorkflow directly. Always creates Employee regardless of tenant flag. |
   | Workflow-driven | HRIS integration calls `EmployeeOnboardingWorkflow.start(...)` | Same as admin-driven; intended for batch imports. |
   | Self-onboarding | First `ensure_employee` call from the bot when `auto_onboard_employees=true` | Auto-creates Employee + EmployeeOnboardingWorkflow. |

6. **`tenant_settings.auto_onboard_employees` defaults to `true` to preserve current behavior.** Existing tenants don't change behavior on slice 66 deploy. New behavior is opt-out per tenant.

7. **`EmployeeOnboardingWorkflow` is the canonical post-creation orchestrator.** Whether onboarding is admin/workflow/self-driven, the workflow runs the same downstream steps: KC realm role assignment, welcome notification, default role grant, etc. Slice 66 doesn't change the workflow itself; only what triggers it.

8. **`onboarding_source` audit field.** Each Employee insert records how it was provisioned (`'admin' | 'workflow' | 'self'`). Future eval / compliance reporting can ask "how many self-onboards last quarter vs. admin-onboards." New column on `cip_hr.employees`. ~3 LOC migration.

9. **No platform-core MCP write-side beyond `sync_user`.** Slice 66 lays the MCP server but only adds one tool. Slice 69 expands. Resist adding "while we're here" tools.

---

## SQL migrations

### `cip_platform/006_auto_onboard_employees.sql`

```sql
-- Slice 66: per-tenant gate for auto-onboarding employees on first HR access.
-- Default: true (preserves current behavior). Operators flip false for tenants
-- where Employee = explicit HR onboarding (e.g., financial users shouldn't
-- become employees).

BEGIN;

ALTER TABLE cip_platform.tenant_settings
  ADD COLUMN IF NOT EXISTS auto_onboard_employees BOOLEAN NOT NULL DEFAULT true;

COMMIT;
```

### `cip_hr/049_employees_onboarding_source.sql`

```sql
-- Slice 66: track how each employee was provisioned for compliance / eval.
-- Backfill existing rows as 'unknown' (pre-66 history).

BEGIN;

ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS onboarding_source TEXT
    CHECK (onboarding_source IN ('admin', 'workflow', 'self', 'unknown'))
    NOT NULL DEFAULT 'unknown';

COMMIT;
```

---

## `sync_user` MCP tool (platform-core)

```typescript
// packages/platform-core/src/mcp-server/tools/sync-user.ts
//
// Slice 66: JWT-driven user upsert. Writes ONLY to cip_platform — does not
// create or update any cip_hr.employees row. Bot calls this on every turn
// before any other MCP work.

server.tool(
  'sync_user',
  'Internal — re-reads the caller\'s JWT and upserts their User + identity links. ' +
  'Takes NO arguments. Idempotent. Fails closed if JWT has no derivable identity link.',
  {},
  { requiredPermission: null, sideEffectLevel: 'write', whenToUse: ['Internal — bot first call per turn'], whenNotToUse: ['User-facing'], commonNextTools: ['get_my_permissions'], outputSchema: { ... } } as any,
  async (_args, context) => {
    const claims = parseJwtClaims(context.authInfo?.token ?? '')
    const linkValues = []
    if (claims.keycloakSub) linkValues.push({ provider: 'keycloak', subject: claims.keycloakSub })
    if (claims.aadOid)      linkValues.push({ provider: 'aad',      subject: claims.aadOid })
    // future providers plug in here
    if (linkValues.length === 0) {
      throw new Error('sync_user: JWT has no identity link — refusing to create orphan user')
    }

    const result = await withTenantRLS(getDb(), claims.tenantId, async (tx) => {
      // 1. Look up by canonical link
      const linkRow = await tx
        .select({ userId: userIdentityLinks.userId })
        .from(userIdentityLinks)
        .where(and(
          eq(userIdentityLinks.tenantId, claims.tenantId),
          eq(userIdentityLinks.provider, 'keycloak'),
          eq(userIdentityLinks.subject, claims.keycloakSub),
        ))
        .limit(1)

      let userId: string
      if (linkRow.length > 0) {
        userId = linkRow[0]!.userId
        await tx.update(users).set({ email, fullName, givenName, surname, updatedAt: sql`NOW()` }).where(eq(users.id, userId))
      } else {
        userId = randomUUID()
        await tx.insert(users).values({ id: userId, tenantId: claims.tenantId, email, fullName, givenName, surname, identityType: 'aad_federated' })
      }

      // 2. Upsert N identity links
      for (const { provider, subject } of linkValues) {
        await tx.insert(userIdentityLinks).values({ userId, tenantId: claims.tenantId, provider, subject })
          .onConflictDoUpdate({ target: [userIdentityLinks.userId, userIdentityLinks.provider], set: { subject, updatedAt: sql`NOW()` } })
      }

      return { userId }
    })

    return jsonResponse({ data: { userId: result.userId } })
  },
)
```

Note: post-slice-65, `cip_platform.users` no longer has `keycloakId`/`aadOid` columns. The values come from JWT but only land in `user_identity_links`.

---

## `ensure_employee` MCP tool (hr-service, replaces sync_employee)

```typescript
// packages/hr-service/src/modules/employees/mcp-tools/ensure-employee.ts

server.tool(
  'ensure_employee',
  'Internal — confirms the caller has an Employee row in this tenant; creates if tenant.auto_onboard_employees=true. ' +
  'Takes NO arguments. Idempotent. Returns {employeeId, source, created}.',
  {},
  { ... } as any,
  async (_args, context) => {
    const { tenantId, keycloakId } = parseJwtClaims(context.authInfo?.token ?? '')

    return await withTenantRLS(getDb(), tenantId, async (tx) => {
      // 1. Find user by canonical link (set by platform-core's sync_user)
      const linkRow = await tx
        .select({ userId: userIdentityLinks.userId })
        .from(userIdentityLinks)
        .where(and(
          eq(userIdentityLinks.tenantId, tenantId),
          eq(userIdentityLinks.provider, 'keycloak'),
          eq(userIdentityLinks.subject, keycloakId),
        ))
        .limit(1)

      if (linkRow.length === 0) {
        return jsonError('user_not_found', 'sync_user must run first')
      }
      const userId = linkRow[0]!.userId

      // 2. Find existing employee
      const existing = await tx
        .select({ id: employees.id, onboardingSource: employees.onboardingSource })
        .from(employees)
        .where(eq(employees.userId, userId))
        .limit(1)
      if (existing.length > 0) {
        return jsonResponse({ data: { employeeId: existing[0]!.id, source: existing[0]!.onboardingSource, created: false } })
      }

      // 3. Decide auto-onboard vs. refuse
      const settings = await getTenantAutoOnboard(tx, tenantId)
      if (!settings.autoOnboardEmployees) {
        return jsonError('not_provisioned_in_hr', 'tenant disables self-onboarding; admin must run employee.create')
      }

      // 4. Self-onboard: create employee + kick onboarding workflow
      await tx.insert(employees).values({
        id: userId,
        tenantId,
        userId,
        employmentType: 'employee',
        onboardingSource: 'self',
      })

      // 5. Trigger downstream side effects (KC role, welcome notification, etc.)
      void startEmployeeOnboardingWorkflow({ tenantId, userId, source: 'self' })
        .catch(err => console.warn('[ensure_employee] background workflow start failed:', err))

      return jsonResponse({ data: { employeeId: userId, source: 'self', created: true } })
    })
  },
)
```

---

## Bot resolve-context.ts (the new two-call shape)

```typescript
// packages/teams-bot/src/auth/resolve-context.ts
//
// Slice 66: every turn now calls platform-core sync_user (always). hr-service
// ensure_employee is called on demand: when the candidate tool list contains
// an HR-flavored tool, OR when an HR tool execution returns 'not_provisioned'.

const platformMcp = getMcpClient(jwt, 'platform-core')
const userResp = await platformMcp.callTool({ name: 'sync_user', arguments: {} })
const { userId } = parseUserSyncResponse(userResp)

// permissions still come from hr-service for now (slice 67/68 may move)
const permResp = await hrMcp.callTool({ name: 'get_my_permissions', arguments: {} })
const { permissions, roles } = parseGetMyPermissionsResponse(permResp)

return { tenantId, userId, permissions, roles, ...rest }

// Inside the bot's tool-executor, when a candidate tool is in the hr-service
// catalog, call ensure_employee BEFORE the tool. If ensure_employee returns
// not_provisioned_in_hr, surface a hint to the user ('You're not onboarded
// in HR — ask your admin to run /onboard') instead of executing.
```

---

## Three onboarding paths — runbook

`docs/operations/employee-onboarding.md` (NEW) documents:

### Path 1 — Admin-driven (existing, no code change)

Admin runs:
```
/onboard
  email: alice@acme.com
  fullName: Alice
  identityType: aad_federated
```

Bot calls `employee.create` MCP tool which kicks `EmployeeOnboardingWorkflow`. Always creates Employee regardless of `auto_onboard_employees`.

Use when: admin explicitly onboards a new hire.

### Path 2 — Workflow-driven (existing, integration boundary)

HRIS or onboarding integration calls Temporal directly:
```typescript
await temporalClient.workflow.start('EmployeeOnboardingWorkflow', {
  workflowId: `EmployeeOnboarding-${tenantId}-${userId}`,
  args: [{ tenantId, userId, source: 'workflow', payload }],
})
```

Use when: batch import from external HRIS, or integration with corporate identity sync.

### Path 3 — Self-onboarding (new in slice 66)

Bot user opens Teams for the first time. Bot calls platform-core `sync_user` (creates User). When user invokes their first HR tool (e.g., "show my certs"), bot calls `ensure_employee`.

- If `tenant_settings.auto_onboard_employees=true` (default): Employee auto-created with `source: 'self'`; `EmployeeOnboardingWorkflow` runs in background.
- If `false`: bot surfaces "you're not yet onboarded — ask your admin to run /onboard."

Use when: tenant treats Teams users as employees by default. Disable for tenants where Employee is reserved for HR-managed personnel.

---

## Acceptance criteria

1. **`pnpm -r run typecheck` clean.**

2. **`pnpm --filter @cip/platform-core migrate`** applies 006 cleanly. **`pnpm --filter @cip/hr-service migrate`** applies 049 cleanly.

3. **platform-core MCP server listens** on the expected port; `tools/list` returns `sync_user` (and only that, for slice 66).

4. **`sync_user` happy path**: bot calls with valid JWT; new user inserted into cip_platform.users; identity link inserted; tx idempotent on retry.

5. **`sync_user` rejection**: JWT with no identity claim (no `sub`, no `oid`) returns 4xx error with `'no_identity_link'` code. No User row written.

6. **`ensure_employee` auto-onboard ON**: tenant flag default `true`; new user calls `ensure_employee`; Employee row inserted with `onboarding_source='self'`; `EmployeeOnboardingWorkflow` started; `created: true` returned.

7. **`ensure_employee` auto-onboard OFF**: flip tenant flag to `false`; new user (without Employee yet) calls `ensure_employee`; returns `not_provisioned_in_hr`; no Employee row inserted.

8. **`ensure_employee` user not synced**: call `ensure_employee` for a tenant with no `sync_user` having run for this user; returns `user_not_found`.

9. **Bot end-to-end**: send Teams message; resolve-context calls `sync_user` then `get_my_permissions`. If user invokes "show my certs", bot calls `ensure_employee` first; tool runs only if Employee exists.

10. **Admin-driven path**: `/onboard alice@acme.com` runs `employee.create` → `EmployeeOnboardingWorkflow`. Resulting `employees.onboarding_source='admin'`.

11. **`sync_employee` removed**: `grep -r "sync_employee\|syncEmployee" packages/hr-service/src` returns zero matches.

12. **Backwards compat for existing employees**: pre-66 employees have `onboarding_source='unknown'`; query works; no schema migration breaks the existing row.

---

## Test plan

- **Unit**:
  - `sync_user` claim parsing (happy + missing identity)
  - `ensure_employee` decision matrix: (user_found, employee_found, tenant_flag) → expected outcome
  - `getTenantAutoOnboard` reads default true / overridden false correctly

- **Integration (local DB)**:
  1. Migrate; verify 006 + 049 applied
  2. Send simulated Teams JWT to platform-core sync_user; assert User + link created
  3. Set tenant `auto_onboard_employees=false` for a test tenant
  4. Call `ensure_employee` for a new user in that tenant; assert `not_provisioned_in_hr`
  5. Set flag back to `true`; same call; assert Employee created with `source='self'`
  6. Run `employee.create` for a different user; assert `source='admin'`

- **Migration safety**: existing employees' `onboarding_source='unknown'` is queryable and doesn't break any existing queries.

---

## Forward refs

- **Slice 67** — `@cip/auth` package + `/auth/resolve` endpoint. After this slice the bot already calls platform-core for `sync_user`; slice 67 consolidates auth context resolution under `@cip/auth` and a single resolve call.
- **Slice 68** — Permission ownership migration. `user_role_assignments` populated by the platform-core MCP server (eventually); for now they continue to live in cip_hr until that slice.
- **Slice 69** — Per-module MCP servers + platform-core MCP expansion. Slice 66's tiny platform-core MCP grows into the user/role/tenant tool surface.
- **`EmployeeOnboardingWorkflow` enhancements** — current workflow assumes admin trigger. Slice 66 adds a `source` arg; downstream slices may differentiate (e.g., self-onboarding skips welcome email).

---

## Risks

- **Risk**: `sync_user` becomes a hot path; platform-core's MCP server is brand new and may have unexpected latency.
  - **Mitigation**: same drizzle stack as the existing route. Cache opportunity exists (5-min cache like the bot's tenant resolver) but defer until measured.

- **Risk**: tenant flips `auto_onboard_employees=false` after some users have already been auto-onboarded. Those users keep their Employee row (correct), but new users hit the wall. Audit can show via `onboarding_source`.
  - **Mitigation**: the flag only affects future provisioning; existing employees unchanged. Document this in the runbook.

- **Risk**: bot's two-call pattern (`sync_user` then `ensure_employee` opportunistically) doubles the per-turn round-trips for HR queries.
  - **Mitigation**: 5-min cache on the bot side keyed by `userId` for "I already ensured the employee this session." Add if measurement shows the cost. For slice 66 MVP, naive per-turn calls are acceptable.

- **Risk**: deleting the old `sync_employee` MCP tool breaks any caller other than the bot we're aware of.
  - **Mitigation**: `grep` confirms only the bot calls it. Hard cut per D9. No external integrations call `sync_employee` directly.

- **Risk**: `EmployeeOnboardingWorkflow.start` from inside `ensure_employee` is fire-and-forget (`void startEmployeeOnboardingWorkflow(...).catch(...)`). If the workflow fails, the user has an Employee row but downstream steps (KC role, welcome notif) didn't happen.
  - **Mitigation**: workflow is idempotent and re-runnable; ops can re-kick from Temporal UI on failure. For MVP, the failure mode is logged + visible.

- **Risk**: `cip_platform` MCP server listens on a new port; helm value addition needed.
  - **Mitigation**: piggyback on the existing platform-core service port (3001). MCP routes mounted at `/mcp/platform`. No new pod, no new service object.

---

## Cross-slice notes

- After slice 66, `sync_employee` is gone. Slice 65's read-site migrations remain valid (they use `findEmployeeWithUser` helpers which join on `user_id`). No re-migration needed.
- Slice 67 (auth API) may further consolidate by having `/auth/resolve` call `sync_user` internally — TBD when 67 lands.
- Slice 68 (permission ownership) shifts `user_role_assignments` to cip_platform; admin-driven onboarding (path 1) updates to write there. Until 68, hr-service still owns the assignments table.
- Per-tenant `auto_onboard_employees=false` is the right default for tenants that integrate via HRIS (Path 2 dominates) — slice 66 shipping with default `true` keeps current tenants working unchanged.

---

## Implementation status

**Implemented in commit-pending state on 2026-05-06.** Files touched:

**platform-core (new):**
- `packages/platform-core/src/mcp-server/auth.ts` — JWT claim extraction (separate from hr-service's; no permission resolution)
- `packages/platform-core/src/mcp-server/index.ts` — `mountMcpServer(app)` mounts `/mcp/platform` on the existing HTTP app
- `packages/platform-core/src/mcp-server/tools/sync-user.ts` — JWT-driven user upsert + identity-link upsert; transactional with `app.current_tenant_id` GUC
- `packages/platform-core/src/db/migrations/006_auto_onboard_employees.sql` — adds `auto_onboard_employees BOOLEAN NOT NULL DEFAULT true`
- `packages/platform-core/src/db/schema.ts` — `tenantSettings.autoOnboardEmployees` field

**platform-core (modified):**
- `packages/platform-core/package.json` — added `@modelcontextprotocol/sdk: ^1.0.0`
- `packages/platform-core/src/server.ts` — `mountMcpServer(app)` between admin routes and JWT middleware

**hr-service (new):**
- `packages/hr-service/src/db/migrations/049_employees_onboarding_source.sql` — adds `onboarding_source TEXT CHECK ('admin'|'workflow'|'self'|'unknown') NOT NULL DEFAULT 'unknown'`
- `packages/hr-service/src/db/queries/tenant-settings.ts` — `getTenantAutoOnboard` reads `cip_platform.tenant_settings`
- `packages/hr-service/src/modules/employees/mcp-tools/ensure-employee.ts` — replaces sync_employee. Look-up by KC link → existing employee returns; missing → check tenant flag; auto-onboard or refuse with `not_provisioned_in_hr`. Auto-elevate runs for both new and existing rows.

**hr-service (modified):**
- `packages/hr-service/src/db/schema.ts` — `employees.onboardingSource` field
- `packages/hr-service/src/modules/employees/mcp-tools/index.ts` — registers `ensure_employee`, drops `sync_employee` import
- DELETED: `packages/hr-service/src/modules/employees/mcp-tools/sync-employee.ts`

**teams-bot (modified):**
- `packages/teams-bot/src/mcp/multi-server-client.ts` — `ServerName` extended with `'platform-core'`; resolveServers gets `PLATFORM_CORE_MCP_URL` with cluster default
- `packages/teams-bot/src/auth/resolve-context.ts` — two-call pattern: `platform-core sync_user` always; `hr-service ensure_employee` always (logs `error` if `user_not_found`/`not_provisioned_in_hr`); then `get_employee_permissions`. Per-step timing logged.
- `packages/teams-bot/helm/values.yaml` — added `PLATFORM_CORE_MCP_URL`

**Verification:**
- ✅ `pnpm -r run typecheck` clean
- ✅ `pnpm --filter @cip/platform-core build` clean (`dist/mcp-server/...` present)
- ✅ `pnpm --filter @cip/hr-service build` clean (`dist/modules/employees/mcp-tools/ensure-employee.js` present)
- ⏳ Runtime DB-level verification: requires applying 006 + 049, calling sync_user via MCP, then ensure_employee.

## Locked decisions

1. **`sync_user` location** — first MCP tool on platform-core's new MCP server. Bot invokes via MCP, consistent with how it calls hr-service tools today.
2. **Pre-66 `onboarding_source` backfill** — `'unknown'` for all existing rows. No back-classification attempted; history is what it is.
3. **`ensure_employee` background workflow** — fire-and-forget with `.catch()` log. Workflow is idempotent and re-runnable from Temporal UI on failure.
4. **Bot caching of `ensure_employee`** — none in MVP. Naive per-turn calls. Add cache only if measurement shows it matters.
5. **`sync_employee` removal** — full hard cut. Tool deleted from hr-service MCP registry. No deprecated alias.

Slice is locked. Ready for implementation kickoff.

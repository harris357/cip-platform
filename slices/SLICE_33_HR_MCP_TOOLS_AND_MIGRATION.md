# Slice 33 — HR MCP Tools, Identity Migration, and Disable Workflows

> **Prerequisite:** Slice 31 complete (HTTP endpoint + IDP mapper) and Slice 32 complete (realm roles + audit table + middleware).
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

Slice 31 gave us a single HTTP endpoint to provision an employee. Slice 32
established the realm-role model and audit table. This slice closes the loop:

- **HR reps manage employees from inside Teams** by calling MCP tools — the
  bot's intent router can dispatch these from natural-language requests.
- **Employees can change identity_type over their career** (field worker
  promoted to office acquires an Entra account; office worker reassigned to
  field loses theirs). One person → one employees row → identity mechanism
  reshapes underneath, history preserved.
- **Employees can be disabled** when they leave the organisation, with all
  KC sessions invalidated and the audit trail intact.

All seven tools share a single `hr` realm-role gate and write `hr_actions`
audit rows on every call (success or failure). `employee.create` shares its
underlying service code with Slice 31's HTTP endpoint, so there's exactly one
provisioning code path.

---

## Step 0 — MCP Result Envelope Decision (do this FIRST)

Before writing any tool handler, determine the response shape:

1. **Find the SDK version.** Inspect:
   - `packages/hr-service/package.json` for `@modelcontextprotocol/sdk`
   - any shared MCP setup under `packages/shared/`
   - the existing tool implementations under
     `packages/hr-service/src/modules/certifications/mcp-tools/` for the
     pattern they already use

2. **Check the SDK's tool-result type.** Open `node_modules/@modelcontextprotocol/sdk/types.d.ts`
   (or the equivalent path for the pinned version). Determine:
   - Does `CallToolResult` (or `ToolResult`) expose a `structuredContent` field
     natively?
   - Or only `content[]` of `{type:'text',text:string}`?

3. **Pause and surface a report to the user.** Format:

   > **MCP envelope investigation**
   > - SDK version: `@modelcontextprotocol/sdk@X.Y.Z`
   > - `structuredContent` supported: yes / no
   > - Existing tools (e.g. `certifications.*`) currently return: `{shape}`
   > - Recommended envelope shape:
   >   ```json
   >   { "ok": true|false, "code": "string?", "data": {...}|null, "message": "string" }
   >   ```
   > - Recommended carrier: `structuredContent` (if supported) / JSON-in-text (else)
   > - Awaiting confirmation before implementing tool handlers.

4. **Wait for user confirmation.** Then implement uniformly across all seven
   tools.

The investigation is **non-blocking for everything else**. Files under
`workflows/` and `activities/` (below) can be written before the envelope is
locked in. Only the seven `mcp-tools/*.tool.ts` files depend on the answer.

---

## What You Are Building

```
packages/hr-service/src/

  services/
    employee-onboarding.ts                       ← MOVE/EXTRACT from Slice 31's route handler
    employee-migration.ts                        ← NEW: starts EmployeeIdentityMigrationWorkflow
    employee-disable.ts                          ← NEW: starts EmployeeDisableWorkflow

  modules/employees/

    workflows/
      employee-onboarding.workflow.ts            ← (exists, no change in this slice)
      employee-identity-migration.workflow.ts    ← NEW
      employee-disable.workflow.ts               ← NEW

    activities/
      validate-migration-preconditions.activity.ts   ← NEW
      attach-aad-federation.activity.ts              ← NEW
      detach-aad-federation.activity.ts              ← NEW
      clear-local-credentials.activity.ts            ← NEW
      setup-otp-required-actions.activity.ts         ← NEW
      update-employee-identity.activity.ts           ← NEW (UPDATE employees row)
      invalidate-user-sessions.activity.ts           ← NEW (used by both migration + disable)
      disable-keycloak-user.activity.ts              ← NEW
      update-employee-status.activity.ts             ← NEW (UPDATE employees.active=false)
      send-identity-changed-notification.activity.ts ← NEW
      index.ts                                       ← MODIFY: re-export new activities

    mcp-tools/
      employee.create.tool.ts                    ← NEW
      employee.list.tool.ts                      ← NEW
      employee.find.tool.ts                      ← NEW
      employee.assign-role.tool.ts               ← NEW
      employee.revoke-role.tool.ts               ← NEW (refuses 'employee')
      employee.migrate-identity.tool.ts          ← NEW
      employee.disable.tool.ts                   ← NEW
      index.ts                                   ← NEW: tool registry

  workers/
    temporal-worker.ts                           ← MODIFY: register new activities + workflows

  mcp-server/
    index.ts                                     ← MODIFY: mount the new tool registry

  routes/
    admin-employees.ts                           ← MODIFY: thin wrapper now; calls services/employee-onboarding
```

---

## Read Before Writing

- [docs/users-roles-auth-normalization-plan.md](../docs/users-roles-auth-normalization-plan.md)
  §§ "Identity migration", "Audit", and the Slice 33 spec block.
- [docs/identity-and-auth-architecture.md](../docs/identity-and-auth-architecture.md)
  for the three-store model and the federation-key (oid) decision.
- `packages/hr-service/src/routes/admin-employees.ts` (Slice 31) — extract its
  inline service logic into `services/employee-onboarding.ts`.
- `packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts`
  — pattern for KC admin-API calls (service-account token, error handling).
- `packages/hr-service/src/modules/certifications/mcp-tools/` — existing tool
  patterns (registration, schema, handler shape).
- `packages/hr-service/src/services/audit.ts` (Slice 32) — `recordHrAction` API.
- `packages/shared/src/utils/tenant-context.ts` (Slice 32) — `requireRealmRole`,
  `AuthContext.roles`.
- `packages/hr-service/src/workers/temporal-worker.ts` — pattern for registering
  workflows and activities.

Do **not** read other modules (`certifications`, `compliance`, `settings`)
beyond confirming an MCP-tool pattern. This slice is contained to the
`employees` module.

---

## Hard Rules (Seven Non-Negotiables)

- `tenantId` is read from `authInfo.token` for MCP tools and from `req.auth`
  for HTTP. **Never** in tool input schemas (Non-Negotiable #6).
- Every Temporal Activity that produces domain data validates output with Zod
  `.parse()` before returning.
- Workflow IDs:
  - `EmployeeIdentityMigrationWorkflow` — `EmployeeMigrate-${tenantId}-${employeeId}`
  - `EmployeeDisableWorkflow` — `EmployeeDisable-${tenantId}-${employeeId}`
  - Each `workflow.start()` call has the
    `// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}` comment on the line above.
- No `@anthropic-ai/sdk` imports.
- Stubs forbidden — every function ships with a working body. (Step 0
  investigation excepted; tool handlers may be authored last but must ship in
  this slice.)
- NATS subjects only via `Subjects.*` (this slice publishes
  `Subjects.employeeIdentityMigrated` and `Subjects.employeeDisabled` from
  the workflows — define them in `@cip/shared/src/utils/subject-builder.ts`
  if not present, log a cross-slice note pointing back to the shared package
  if you need to add them).

---

## Service Layer (extracted from Slice 31)

### `services/employee-onboarding.ts`

Move the handler logic of `routes/admin-employees.ts` into this file as a
named exported function:

```typescript
export interface OnboardEmployeeInput {
  tenantId:       string;
  email:          string;
  fullName:       string;
  identityType:   'aad_federated' | 'field_employee';
  aadOid?:        string;
  phone?:         string;
  employmentType?: 'employee' | 'contractor';
  actorEmployeeId: string;            // who initiated this (for audit)
}

export interface OnboardEmployeeResult {
  employeeId: string;
  workflowId: string;
}

export async function onboardEmployee(input: OnboardEmployeeInput): Promise<OnboardEmployeeResult> {
  // 1. Validate (already Zod-validated upstream; assert invariants here).
  // 2. INSERT employees row (withTenantRLS).
  // 3. Start EmployeeOnboardingWorkflow.
  // 4. recordHrAction(action_type='employee.create', result='success').
  // 5. Return { employeeId, workflowId }.
  // On any failure: recordHrAction(result='failed', errorCode/message), then rethrow.
}
```

Then `routes/admin-employees.ts` becomes a thin wrapper:

```typescript
adminEmployeesRouter.post(
  '/admin/employees',
  requireRealmRole('hr'),
  async (req, res) => {
    const parse = AdminEmployeeCreateSchema.safeParse(req.body);
    if (!parse.success) return res.status(400).json({ error: 'validation', issues: parse.error.issues });
    try {
      const result = await onboardEmployee({
        tenantId:        req.auth!.tenantId,
        actorEmployeeId: req.auth!.employeeId,    // see "Auth context" below
        ...parse.data,
      });
      return res.status(201).json({ ...result, status: 'onboarding' });
    } catch (err) {
      // Map known errors to status codes; default to 500.
      // See "Error mapping" table below.
    }
  },
);
```

The MCP tool `employee.create` calls the same `onboardEmployee` function with
the `actorEmployeeId` derived from the MCP `authInfo.token`.

### `services/employee-migration.ts`

```typescript
export interface MigrateIdentityInput {
  tenantId:            string;
  actorEmployeeId:     string;
  employeeId:          string;
  targetIdentityType:  'aad_federated' | 'field_employee';
  aadOid?:             string;       // required if target='aad_federated'
  phone?:              string;       // required if target='field_employee'
}

export interface MigrateIdentityResult {
  workflowId: string;
}

export async function migrateEmployeeIdentity(input: MigrateIdentityInput): Promise<MigrateIdentityResult> {
  // 1. Validate target ≠ current (no-op error).
  // 2. Validate the right field is present for the target direction.
  // 3. Start EmployeeIdentityMigrationWorkflow with workflowId pattern.
  // 4. recordHrAction.
}
```

### `services/employee-disable.ts`

```typescript
export async function disableEmployee(input: {
  tenantId:        string;
  actorEmployeeId: string;
  employeeId:      string;
  reason?:         string;
}): Promise<{ workflowId: string }> {
  // 1. Look up employees row; if already inactive, recordHrAction success-noop and return.
  // 2. Start EmployeeDisableWorkflow.
  // 3. recordHrAction.
}
```

---

## Workflows

### `employee-identity-migration.workflow.ts`

```typescript
export interface EmployeeIdentityMigrationInput {
  tenantId:           string;
  employeeId:         string;
  targetIdentityType: 'aad_federated' | 'field_employee';
  aadOid?:            string;
  phone?:             string;
}

const {
  validateMigrationPreconditionsActivity,
  attachAadFederationActivity,
  detachAadFederationActivity,
  clearLocalCredentialsActivity,
  setupOtpRequiredActionsActivity,
  updateEmployeeIdentityActivity,
  invalidateUserSessionsActivity,
  sendIdentityChangedNotificationActivity,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export async function EmployeeIdentityMigrationWorkflow(
  input: EmployeeIdentityMigrationInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `EmployeeMigrate-${input.tenantId}-${input.employeeId}`

  const { keycloakId, currentIdentityType } = await validateMigrationPreconditionsActivity({
    tenantId:           input.tenantId,
    employeeId:         input.employeeId,
    targetIdentityType: input.targetIdentityType,
  });

  if (input.targetIdentityType === 'aad_federated') {
    await attachAadFederationActivity({
      keycloakId,
      aadOid: input.aadOid!,
    });
    await clearLocalCredentialsActivity({ keycloakId });
  } else {
    await detachAadFederationActivity({ keycloakId });
    await setupOtpRequiredActionsActivity({
      keycloakId,
      phone: input.phone!,
    });
  }

  await updateEmployeeIdentityActivity({
    tenantId:     input.tenantId,
    employeeId:   input.employeeId,
    identityType: input.targetIdentityType,
    aadOid:       input.aadOid ?? null,
    phone:        input.phone  ?? null,
  });

  await invalidateUserSessionsActivity({ keycloakId });

  await sendIdentityChangedNotificationActivity({
    tenantId:    input.tenantId,
    employeeId:  input.employeeId,
    fromType:    currentIdentityType,
    toType:      input.targetIdentityType,
  });
}
```

### `employee-disable.workflow.ts`

```typescript
export interface EmployeeDisableInput {
  tenantId:   string;
  employeeId: string;
  reason?:    string;
}

export async function EmployeeDisableWorkflow(
  input: EmployeeDisableInput,
): Promise<void> {
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  // workflowId: `EmployeeDisable-${input.tenantId}-${input.employeeId}`

  const { keycloakId } = await disableKeycloakUserActivity({
    tenantId:   input.tenantId,
    employeeId: input.employeeId,
  });
  await invalidateUserSessionsActivity({ keycloakId });
  await updateEmployeeStatusActivity({
    tenantId:   input.tenantId,
    employeeId: input.employeeId,
    active:     false,
  });
}
```

---

## Activities — Implementation Notes

For each new activity below, follow the pattern from
`create-keycloak-user.activity.ts`: Zod-typed input/output, `getServiceAccountToken`
helper for KC admin calls, `withTenantRLS` for any DB writes, validate output
with `.parse()` before returning.

| Activity | KC API call (if any) | DB write (if any) |
|---|---|---|
| `validateMigrationPreconditions` | `GET /admin/realms/{realm}/users/{kcId}` (verify exists, verify `enabled=true`) | `SELECT identity_type, keycloak_id FROM employees WHERE id=$1` |
| `attachAadFederation` | `POST /admin/realms/{realm}/users/{kcId}/federated-identity/aad` | none |
| `detachAadFederation` | `DELETE /admin/realms/{realm}/users/{kcId}/federated-identity/aad` | none |
| `clearLocalCredentials` | `GET .../credentials` then `DELETE .../credentials/{credId}` per credential; `PUT .../users/{kcId}` with `requiredActions=[]` | none |
| `setupOtpRequiredActions` | `PUT .../users/{kcId}` with `requiredActions=['CONFIGURE_TOTP','UPDATE_PASSWORD']`, `attributes.phoneNumber=[<phone>]` | none |
| `updateEmployeeIdentity` | none | `UPDATE employees SET identity_type=$1, aad_oid=$2, phone=$3, updated_at=NOW() WHERE id=$4` |
| `invalidateUserSessions` | `POST /admin/realms/{realm}/users/{kcId}/logout` | none |
| `disableKeycloakUser` | `PUT /admin/realms/{realm}/users/{kcId}` with `enabled=false`; also fetches and returns `keycloakId` for the next step | `SELECT keycloak_id FROM employees WHERE id=$1` (resolve) |
| `updateEmployeeStatus` | none | `UPDATE employees SET active=$1, updated_at=NOW() WHERE id=$2`. **Note:** if `employees.active` column doesn't exist yet, log a cross-slice note for Slice 05A schema and use a `disabled_at TIMESTAMPTZ` instead. |
| `sendIdentityChangedNotification` | none | publish `Subjects.employeeIdentityChanged(tenantId)` event with `{employeeId, fromType, toType}` payload (Zod-validated) |

KC admin API endpoint `realms/{realm}/users/{id}/logout` is the documented
session-invalidation call (KC ≥ 18). Verify against the running KC version
before relying on it.

---

## MCP Tools

All tools live in `packages/hr-service/src/modules/employees/mcp-tools/` and
follow the result envelope locked in by Step 0. Each tool:

1. Asserts `requireRealmRole('hr')` against the auth context. (For MCP, this
   means inspecting `authInfo.token` — the helper to pull `realm_access.roles`
   from a KC token may need to be added to `@cip/shared` if not present;
   parallel to the HTTP `requireRealmRole` middleware. If you have to add it,
   keep the function signature `assertRealmRole(token, role): void` and reuse
   the same middleware-supporting helper underneath.)
2. Runs its service call.
3. Writes an `hr_actions` audit row via `recordHrAction` (Slice 32) — both on
   success and on caught failure.
4. Returns the locked-in envelope shape.

### Tool inventory

| Tool name | Inputs | Service call | Result `data` |
|---|---|---|---|
| `employee.create` | `email, fullName, identityType, aadOid?, phone?, employmentType?, roles?: ('hr'\|'employee')[]` | `onboardEmployee(...)` plus optional `assignRoleActivity` for any `hr` extras | `{employeeId, workflowId}` |
| `employee.list` | `filter?: {role?, identityType?, status?}, cursor?, limit?` (default 50, cap 200) | DB query joined with KC role lookup (paginate by `created_at`) | `{employees: Array<...>, nextCursor?: string}` |
| `employee.find` | `email` | DB lookup + KC role fetch | `{employee, kcUserId, roles[]}` or `null` if not found |
| `employee.assign_role` | `employeeId, role: 'hr'\|'employee'` | `POST /admin/.../users/{id}/role-mappings/realm` (idempotent — duplicate is fine) | `{employeeId, role}` |
| `employee.revoke_role` | `employeeId, role` | If `role==='employee'` → return `{ok:false, code:'cannot_revoke_baseline', message:'Use employee.disable instead.'}`. Otherwise `DELETE /admin/.../role-mappings/realm`. | `{employeeId, role}` |
| `employee.migrate_identity` | `employeeId, targetIdentityType, aadOid?, phone?` | `migrateEmployeeIdentity(...)` | `{workflowId}` |
| `employee.disable` | `employeeId, reason?` | `disableEmployee(...)` | `{workflowId}` |

### Tool authorization (key pattern)

```typescript
// Sketch — actual import path matches Step 0's findings.
export async function handle(args: Args, ctx: McpToolContext) {
  assertRealmRole(ctx.authInfo.token, 'hr');   // throws → MCP error envelope
  // ... service call, audit, return envelope
}
```

`assertRealmRole` throws a typed error caught by the MCP framework and
mapped to `{ok:false, code:'forbidden', message:'...'}`.

### Error mapping (HTTP and MCP both)

| Failure | HTTP status | MCP `code` |
|---|---|---|
| Validation (Zod) | 400 | `validation` |
| Caller missing `hr` role | 403 | `forbidden` |
| Conditional field missing (no aadOid for AAD direction, etc.) | 422 | `missing_required_field` |
| Duplicate `(tenant_id, email)` | 409 | `duplicate_email` |
| Migration target == current | 409 | `migration_no_op` |
| Revoking baseline `employee` role | 409 | `cannot_revoke_baseline` |
| Employee not found | 404 | `not_found` |
| KC admin API failure | 502 | `keycloak_unavailable` |
| Anything else | 500 | `internal` |

The HTTP route reuses the same mapping (the `onboardEmployee`/etc. service
functions throw typed errors; both the route handler and the MCP wrapper
catch and translate).

---

## Auth Context — `actorEmployeeId`

`hr_actions.actor_employee_id` is `NOT NULL`. The actor is the HR rep
performing the action. To populate it, the auth context needs to resolve the
KC user id (`sub`) → `employees.id` for the calling tenant.

The KC token already carries `cip_worker_id` as a claim (per the architecture
doc § "Configuration reference"). **If that mapper is configured**, the auth
context can read `cip_worker_id` directly — that IS the `employees.id`.

If it isn't yet configured (the architecture doc lists this as an open
follow-up), do one of:

1. Configure the KC `cip_worker_id` user-attribute → token-claim mapper as
   part of this slice (it's a small `bootstrap.sh` addition; preferable).
2. Resolve `sub` → `employees.keycloak_id = sub` → `employees.id` via a DB
   lookup on every call (one extra SELECT per HR action; acceptable).

Recommendation: option 1, mirroring the AAD `oid` mapper in Slice 31. Add it
to `bootstrap.sh` after the realm + clients exist, before the `aad` IDP
configuration.

---

## Acceptance Criteria

- [ ] Step 0 envelope investigation report posted to user; user confirms
      shape and carrier.
- [ ] `services/employee-onboarding.ts` exists; `routes/admin-employees.ts`
      is a thin wrapper around it; both compile.
- [ ] `EmployeeIdentityMigrationWorkflow` and `EmployeeDisableWorkflow`
      registered in `temporal-worker.ts`.
- [ ] All 10 new activities exported from `activities/index.ts` and
      registered in `temporal-worker.ts`.
- [ ] All 7 MCP tools registered and discoverable via MCP `listTools`.
- [ ] Each tool refuses without `hr` realm role.
- [ ] `employee.create` end state matches `POST /admin/employees` end state
      (single shared service path).
- [ ] `employee.migrate_identity` field→AAD adds federation link, removes
      credentials, updates DB row, invalidates sessions.
- [ ] `employee.migrate_identity` AAD→field removes federation link, sets
      requiredActions, updates DB row, invalidates sessions.
- [ ] `employee.disable` sets `enabled=false` in KC, invalidates sessions,
      sets `active=false` in DB.
- [ ] `employee.revoke_role('employee')` returns `cannot_revoke_baseline`
      without modifying anything.
- [ ] Every successful AND failed tool call produces an `hr_actions` row.
- [ ] `cip_worker_id` token claim mapper is configured in `bootstrap.sh`
      (if option 1 chosen) OR `actor_employee_id` is resolved by DB lookup
      in the auth context (if option 2).
- [ ] Workflow IDs follow the pattern with the comment line.
- [ ] All activity outputs Zod-validated before return.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- MS Graph integration to autoresolve `email → oid` (Slice 34, optional).
- Bulk employee operations (`employee.bulk_create`, `employee.bulk_disable`).
- Re-enabling a previously disabled employee — possible to add later as
  `employee.reenable`; we don't need it yet.
- Email change (`employee.update_email`) — explicitly separated from
  migration to keep audit trails clean. Defer until a tenant asks.
- Removing the legacy `field_operations` / `field_employee` realm roles.
  Slice 32 left them in place; this slice doesn't touch them either.
- A frontend admin UI on top of these tools (the future Tier-3 slice).

---

## Cross-Slice Notes

Likely candidates that may surface during implementation:

- `employees.active` column may not exist (the migration in Slice 05A might
  use `disabled_at` or a status enum). If so, log a cross-slice note
  pointing at `db/migrations/002_domain_model.sql` and use whichever column
  exists.
- `Subjects.employeeIdentityChanged` and `Subjects.employeeDisabled` may
  not exist in `@cip/shared/utils/subject-builder.ts`. Adding them is a
  one-liner each; if you do, log a cross-slice note pointing at
  `@cip/shared` so other modules can subscribe.
- The `cip_worker_id` token claim mapper choice (Option 1 vs Option 2 above)
  may need to be revisited if a parallel slice has already configured it
  differently. Read `bootstrap.sh` carefully before adding.

---

## Commit

Single commit covering the full slice — Slice 33 is large but its pieces are
tightly coupled (workflows depend on activities, tools depend on workflows
and services, audit threads through everything).

```
slice(33): hr mcp tools, identity migration workflows, disable workflow, audit wiring
```

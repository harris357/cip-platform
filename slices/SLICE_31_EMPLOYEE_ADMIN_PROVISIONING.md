# Slice 31 — Employee Admin Provisioning Endpoint

> **Prerequisite:** Slices 23, 25 complete (HR persistence + onboarding workflow), and Slice 32 complete (realm roles, `requireRealmRole`, `hr_actions` audit table, `recordHrAction`).
> **Package:** `@cip/hr-service` (plus `scripts/bootstrap.sh`)
> **Verify:** `pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck`

---

## Why This Slice Exists

JWT Authorization Grant (RFC 7523) — the grant we use to exchange a Teams-supplied AAD
access token for a Keycloak token — requires the user to be **already linked** to the
external IDP in KC before exchange. KC docs are explicit:

> "The user in Keycloak should be previously linked to the Identity Provider."

This is intentional: it makes provisioning an explicit step, prevents unauthorized
identities from auto-creating themselves, and maps cleanly onto our domain rule that
**every Teams user is an employee** of one of our customer organisations.

We already have `EmployeeOnboardingWorkflow` (Slice 25) which calls `createKeycloakUser`
+ `assignDefaultRole`. What's missing is **the trigger** — a way for an admin (today)
or an HR-system integration (later) to fire the workflow without using `temporal` CLI.

This slice adds a thin authenticated HTTP endpoint on `hr-service` that:

1. Inserts a row in `employees` (the canonical record)
2. Starts `EmployeeOnboardingWorkflow` (which provisions the KC user + role)
3. Returns the new employee id and workflow id

It is the **Tier 2** admin tool described in `docs/identity-and-auth-architecture.md`
§ "Admin onboarding tool". Tier 3 (form UI) is a later slice.

---

## What You Are Building

```
packages/hr-service/src/
  db/queries/
    employees.ts                  ← NEW: upsertEmployee, findEmployeeByEmail
  routes/
    admin-employees.ts            ← NEW: thin route handler (parses, calls service)
  services/
    employee-onboarding.ts        ← NEW: onboardEmployee() — the actual logic
  types/
    employee.ts                   ← NEW: Employee domain type + Zod schema
  server.ts                       ← MODIFY: mount adminEmployeesRouter

scripts/
  bootstrap.sh                    ← MODIFY: add oid→userId mapper to aad IDP
```

The route handler stays thin and delegates to `services/employee-onboarding.ts`.
This split exists so Slice 33's `employee.create` MCP tool can call the same
service function with the same semantics — no duplicate provisioning logic.

No changes to `modules/employees/` — the existing workflow + activities stay as-is.
The route + service live at the service edge; they do not belong inside a feature
module because they are cross-cutting plumbing (admin/system).

---

## Read Before Writing

- `packages/hr-service/src/server.ts`
- `packages/hr-service/src/routes/health.ts`
- `packages/hr-service/src/db/queries/workers.ts` (mirror this style for employees.ts)
- `packages/hr-service/src/db/schema.ts` (existing `employees` Drizzle table)
- `packages/hr-service/src/db/migrations/002_domain_model.sql` (lines 86–116, employees + employee_roles)
- `packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts`
- `packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts`
- `packages/hr-service/src/nats/watcher.ts` (existing example of `client.workflow.start`)
- `packages/shared/src/clients/temporal.ts` (`createTemporalClient`)
- `packages/shared/src/utils/tenant-context.ts` (Slice 32 has added `AuthContext.roles`, `requireRealmRole`)
- `packages/hr-service/src/services/audit.ts` (Slice 32 has added `recordHrAction`)
- `scripts/bootstrap.sh` (existing AAD IDP config block — section 4; Slice 32 has added `hr` and `employee` realm role creation)

Do **not** read packages outside `@cip/hr-service` and `@cip/shared` beyond confirming
the helpers above exist.

---

## Hard Rules (Seven Non-Negotiables)

- `tenantId: string` is required on every input — comes from `req.auth.tenantId`,
  never from the request body.
- Workflow ID follows `EmployeeOnboard-${tenantId}-${employeeId}` with the comment
  `// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}` on the line above.
- Endpoint output and DB-write input must be Zod-validated (`.parse()`).
- No imports from `@anthropic-ai/sdk`.
- No raw NATS subjects (route does not publish, but if you add publishing, use
  `Subjects.*`).
- MCP input schemas — N/A this slice (no MCP tools added).
- Stubs forbidden: every function has a working body.

---

## API Contract

```
POST /admin/employees
Authorization: Bearer <KC token with realm role 'hr'>
Content-Type: application/json

Request body (Zod-validated):
{
  "email":        string,                         // required, lowercased server-side
  "fullName":     string,                         // required
  "identityType": "aad_federated" | "field_employee",
  "aadOid":       string?,                        // required iff identityType=aad_federated
  "phone":        string?,                        // required iff identityType=field_employee
  "employmentType": "employee" | "contractor"?    // optional, default "employee"
}

Response 201:
{
  "employeeId": string,                            // UUID
  "workflowId": string,                            // EmployeeOnboard-<tenantId>-<employeeId>
  "status":     "onboarding"
}

Response 400:  validation error (Zod issues array)
Response 401:  missing/invalid token
Response 403:  authenticated but lacks `hr` realm role
Response 409:  duplicate email for this tenant (DB unique violation)
Response 422:  identityType-specific field missing (aadOid or phone)
```

The endpoint is **fire-and-forget for KC provisioning** — it returns 201 once the
employee row is written and the workflow is started. The workflow updates
`employees.keycloak_id` from a follow-up activity (see "Workflow change" below).

---

## Files to Create

### `packages/hr-service/src/types/employee.ts`

```typescript
import { z } from 'zod';

export const IdentityTypeSchema = z.enum(['aad_federated', 'field_employee']);
export type IdentityType = z.infer<typeof IdentityTypeSchema>;

export const EmploymentTypeSchema = z.enum(['employee', 'contractor']);
export type EmploymentType = z.infer<typeof EmploymentTypeSchema>;

export const EmployeeSchema = z.object({
  id:             z.string().uuid(),
  tenantId:       z.string().uuid(),
  email:          z.string().email(),
  fullName:       z.string().min(1),
  givenName:      z.string().nullable(),
  surname:        z.string().nullable(),
  phone:          z.string().nullable(),
  aadOid:         z.string().nullable(),
  keycloakId:     z.string().nullable(),
  identityType:   IdentityTypeSchema,
  employmentType: EmploymentTypeSchema,
  createdAt:      z.string(),
  updatedAt:      z.string(),
});
export type Employee = z.infer<typeof EmployeeSchema>;

// Input shape for upsertEmployee — DB-side defaults fill the rest.
export const EmployeeUpsertSchema = EmployeeSchema.pick({
  id: true, tenantId: true, email: true, fullName: true,
  identityType: true, employmentType: true,
}).extend({
  givenName: z.string().nullable().optional(),
  surname:   z.string().nullable().optional(),
  phone:     z.string().nullable().optional(),
  aadOid:    z.string().nullable().optional(),
  keycloakId: z.string().nullable().optional(),
});
export type EmployeeUpsert = z.infer<typeof EmployeeUpsertSchema>;
```

### `packages/hr-service/src/db/queries/employees.ts`

Mirror `workers.ts`. Two functions: `findEmployeeByEmail`, `upsertEmployee`. Both take
`PoolClient` (caller wraps in `withTenantRLS`). `upsertEmployee` uses
`ON CONFLICT (tenant_id, email) DO UPDATE` — matches the unique constraint in
`002_domain_model.sql:105`.

`findEmployeeByEmail` returns the full row (or `null`) so the route can detect
duplicates before doing the workflow start.

### `packages/hr-service/src/services/employee-onboarding.ts`

The actual provisioning logic. Slice 33's `employee.create` MCP tool will call
the same function — that's the whole reason for extracting it.

```typescript
export interface OnboardEmployeeInput {
  tenantId:        string;
  actorEmployeeId: string;                // for audit row
  email:           string;
  fullName:        string;
  identityType:    'aad_federated' | 'field_employee';
  aadOid?:         string;
  phone?:          string;
  employmentType?: 'employee' | 'contractor';
}

export interface OnboardEmployeeResult {
  employeeId: string;
  workflowId: string;
}

export async function onboardEmployee(
  input: OnboardEmployeeInput,
): Promise<OnboardEmployeeResult> {
  // 1. Conditional-required fields by identityType
  //      throw a typed error (e.g. AppError('missing_required_field', 422, ...))
  //      rather than returning — the route handler maps errors to status codes.
  // 2. Insert employees row inside withTenantRLS (id generated server-side).
  // 3. Start EmployeeOnboardingWorkflow (workflow ID pattern + comment).
  // 4. recordHrAction({ tenantId, actorEmployeeId, action_type:'employee.create',
  //                     target_employee_id: id, payload: {...input}, result:'success' })
  // 5. Return { employeeId, workflowId }.
  // On any thrown error: recordHrAction({ result:'failed', error_code, error_message }),
  // then rethrow.
}
```

### `packages/hr-service/src/routes/admin-employees.ts`

Express Router. Thin handler that parses, calls the service, and maps errors to
status codes:

```typescript
adminEmployeesRouter.post('/admin/employees', requireRealmRole('hr'), async (req, res) => {
  const parse = AdminEmployeeCreateSchema.safeParse(req.body);
  if (!parse.success) return res.status(400).json({ error: 'validation', issues: parse.error.issues });

  try {
    const result = await onboardEmployee({
      tenantId:        req.auth!.tenantId,
      actorEmployeeId: req.auth!.employeeId,   // see "actorEmployeeId resolution" below
      ...parse.data,
    });
    return res.status(201).json({ ...result, status: 'onboarding' });
  } catch (err) {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.code, message: err.message });
    console.error('[admin-employees] unexpected error:', err);
    return res.status(500).json({ error: 'internal' });
  }
});
```

The Zod request schema:

```typescript
const AdminEmployeeCreateSchema = z.object({
  email:          z.string().email(),
  fullName:       z.string().min(1),
  identityType:   IdentityTypeSchema,
  aadOid:         z.string().min(8).optional(),
  phone:          z.string().min(7).optional(),
  employmentType: EmploymentTypeSchema.optional(),
});
```

`requireRealmRole('hr')` is shipped by Slice 32 (`@cip/shared/utils/tenant-context`).
Do not add it here — Slice 32 owns that helper.

### `actorEmployeeId` resolution

`hr_actions.actor_employee_id` is `NOT NULL` (Slice 32 schema). The actor is
the HR rep performing the action. The KC token includes `cip_worker_id` as a
claim only if the corresponding token-claim mapper is configured.

For this slice:

- If a `cip_worker_id` mapper already exists on the `teams-bot` client (added
  by a prior bootstrap run or another slice): read it from
  `req.auth.cipWorkerId` and pass through.
- If not: resolve `req.auth.kcUserId (= sub) → employees.keycloak_id → employees.id`
  via a single SELECT inside the `onboardEmployee` service. Cache result on the
  request scope if multiple HR actions could happen in one request (not yet a
  thing).

Slice 33 covers the `cip_worker_id` mapper formally — adding it here as well
is fine if you have time, but the DB-lookup fallback is acceptable.

---

## Files to Modify

### `packages/hr-service/src/server.ts`

Mount the new router after `tenantAuthMiddleware`:

```typescript
import { adminEmployeesRouter } from './routes/admin-employees.js';
// ...
app.use(tenantAuthMiddleware);
app.use(adminEmployeesRouter);
```

### `scripts/bootstrap.sh` — AAD IDP user-identifier mapper

Today, `create-keycloak-user.activity.ts` writes the federation link with
`userId = aadOid`. JWT AG, however, looks the user up by the **`sub` claim of the
incoming AAD assertion** — and Entra v2 access tokens have a per-app pairwise `sub`,
not the global `oid`. Without a mapper, federation links written with `oid` won't be
found by JWT AG and we get "User not found" even after onboarding.

Fix: configure the `aad` IDP with an Identity Provider Mapper of type
`oidc-username-idp-mapper` (or the v26 equivalent for "User Attribute" /
"Brokered identity") that uses the `oid` claim as the **External User Identifier**.
This makes KC use `oid` as the federation key for both interactive OIDC login AND
JWT AG, so the value our admin tool stores matches what KC sees on every later token.

Add this to the existing IDP config block in `bootstrap.sh` (after the IDP exists
and JWT AG settings have been applied — order matters because mappers reference
the IDP):

```bash
# Configure oid → External User Identifier mapper on aad IDP (idempotent).
# Default OIDC behaviour uses `sub`, but Entra v2 `sub` is pairwise per app.
# `oid` is global per tenant and what we capture during admin provisioning.
_MAPPER_NAME="aad-oid-as-user-id"
_MAPPER_EXISTS=$(curl -s \
  "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad/mappers" \
  -H "Authorization: Bearer $KC_ADMIN_TOKEN" 2>/dev/null \
  | jq -r --arg n "$_MAPPER_NAME" '.[] | select(.name==$n) | .name' || echo "")

if [[ -z "$_MAPPER_EXISTS" ]]; then
  curl -s -o /dev/null -w "      AAD oid mapper: HTTP %{http_code}\n" \
    -X POST "${KC_LOCAL}/admin/realms/cip-dev/identity-provider/instances/aad/mappers" \
    -H "Authorization: Bearer $KC_ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"${_MAPPER_NAME}\",
      \"identityProviderAlias\": \"aad\",
      \"identityProviderMapper\": \"oidc-username-idp-mapper\",
      \"config\": {
        \"template\":  \"\${CLAIM.oid}\",
        \"target\":    \"BROKER_ID\",
        \"syncMode\":  \"FORCE\"
      }
    }" 2>/dev/null
else
  echo "      AAD oid mapper already exists (skipped)."
fi
```

Verify: after running bootstrap, KC admin UI → Identity Providers → aad → Mappers
shows `aad-oid-as-user-id` of type `Username Template Importer` with template
`${CLAIM.oid}`.

---

## Workflow Change (Optional — defer to a follow-up if scope creeps)

The existing `EmployeeOnboardingWorkflow` does not write back the `keycloak_id` it
receives from `createKeycloakUserActivity` to the `employees` row. Add a fifth
activity `persistKeycloakIdActivity(tenantId, employeeId, keycloakId)` that does a
simple `withTenantRLS → UPDATE employees SET keycloak_id = $1 WHERE id = $2`. Wire
it into the workflow after `createKeycloakUserActivity`.

If this would push the slice over scope, log a cross-slice note for Slice 25 instead
and finish here.

---

## Acceptance Criteria

- [ ] `POST /admin/employees` returns 201 with `{ employeeId, workflowId }` for a
      well-formed `aad_federated` request.
- [ ] Returns 422 when `identityType=aad_federated` and `aadOid` missing.
- [ ] Returns 422 when `identityType=field_employee` and `phone` missing.
- [ ] Returns 403 when caller token lacks the `hr` realm role.
- [ ] Returns 409 on duplicate `(tenantId, email)`.
- [ ] `employees` row is written **before** the workflow is started — and the row
      contains `keycloak_id = NULL` (filled in by the workflow).
- [ ] Workflow id matches `EmployeeOnboard-${tenantId}-${employeeId}` and the line
      above the call has the required pattern comment.
- [ ] All Zod schemas `.parse()` (not `.safeParse()`) on persistence boundaries.
- [ ] `bootstrap.sh` adds the `aad-oid-as-user-id` mapper idempotently.
- [ ] Every successful AND failed `onboardEmployee` call writes one
      `hr_actions` row via `recordHrAction` (success → `result='success'`;
      thrown error → `result='failed'` with `error_code` and `error_message`).
- [ ] `routes/admin-employees.ts` does not contain provisioning logic — only
      parsing, service call, and error-to-status mapping. The workflow start
      and DB insert live in `services/employee-onboarding.ts`.
- [ ] `pnpm --filter @cip/hr-service typecheck` passes.
- [ ] `pnpm -r run typecheck` passes.

---

## Out of Scope

- Tier 3 form UI (separate slice).
- MS Graph integration to look up `oid` from `email` (admin pastes it for now;
  add as a follow-up slice if it becomes a real friction point).
- SMS magic link onboarding for `field_employee` (separate slice — needs the
  KC SMS authenticator SPI first).
- Updating `employees.keycloak_id` after KC user creation (see "Workflow change"
  above — optional in this slice).
- Bulk import endpoint (`POST /admin/employees/bulk`) — defer until manual creation
  proves out the model.

---

## If You Hit a Cross-Slice Issue

If `EmployeeOnboardingWorkflow` (Slice 25) needs a backwards-incompatible signature
change to support the workflow update above, **do not refactor it inline**. Log a
note in `slices/CROSS_SLICE_NOTES.md` per the template and stop. The route can call
the workflow with its current signature and a follow-up cross-slice resolution can
add `persistKeycloakIdActivity` cleanly.

---

## Commit

```
slice(31): admin employee provisioning endpoint + AAD oid mapper
```

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

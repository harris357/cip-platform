# CIP Platform — Slice Map

> One slice = one focused session. Work in order. Later slices depend on earlier ones compiling.

---

## Slice Map

| # | Slice | Doc | Status |
|---|-------|-----|--------|
| 22 | Cleanup & Doc Reset | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 23 | HR Persistence Layer + Migration Runner | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 24 | Cert Vertical Activities | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 25 | Employee Onboarding Activities | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 26 | Channel Registry on NATS KV (resolves CS-018) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 27 | Platform-Core Tenant Provisioning + Wiring Reconciliation | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 28 | CI/CD & Image Pipeline | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 29 | First Deploy Runbook (operational) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | PENDING |
| 30 | Teams App Registration & Sideload (operational) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | PENDING |
| 31 | Employee Admin Provisioning Endpoint | [archive/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md](./archive/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md) | COMPLETE |
| 32 | Realm Roles + Auth Context + HR Audit Table | [archive/SLICE_32_REALM_ROLES_AND_AUDIT.md](./archive/SLICE_32_REALM_ROLES_AND_AUDIT.md) | COMPLETE |
| 33 | HR MCP Tools + Identity Migration + Disable Workflows | [archive/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md](./archive/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md) | COMPLETE |
| 35 | Tenants + Tenant Identity Providers Tables | [archive/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md](./archive/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md) | COMPLETE |
| 36 | Multi-Tenant Teams Bot (in-code routing) | [archive/SLICE_36_MULTI_TENANT_BOT.md](./archive/SLICE_36_MULTI_TENANT_BOT.md) | COMPLETE |
| 37 | Per-Tenant KC Client Secrets via K8s Secrets | [SLICE_37_PER_TENANT_KC_SECRETS.md](./SLICE_37_PER_TENANT_KC_SECRETS.md) | PENDING |
| 38 | Module-Level Permissions (renames "capabilities") | [SLICE_38_PERMISSIONS.md](./SLICE_38_PERMISSIONS.md) | PENDING |

All slices 01–21 are complete — see [archive/](./archive/). Slices 31, 32,
33, 35, 36 completed during the auth/multi-tenant work and have been moved
to [archive/](./archive/) too; their prompts are kept in
[PROMPTS_ALL.md](./PROMPTS_ALL.md) under the "Archived prompts" section
for reference.

---

## Dependency Order

Only pending slices shown. Completed slices are archived.

```
COMPLETE: 22 ──► 23 ──► 24
                  └─► 25 ──► 32 ──► 31 ──► 33
                                            └─► 35 ──► 36
                  └─► 26          └─► 27       └─► 28

PENDING:                          (independent of each other)
            29 ──► 30                          (operational; live cluster + Azure)
            38           (permissions; needs 32 only — done)
            37           (per-tenant KC secrets; needs 35 + 36 — both done)
```

### Recommended next order

1. **Slice 38** — Module-Level Permissions. Fixes the **observable
   "no tool match" behaviour** in the bot today: `discoverTools` filters
   by `requiredCapability` against an empty `ctx.capabilities` map, so
   the LLM rarely sees any tools. Slice 38 implements
   `get_employee_permissions` against the role catalog, renames
   capabilities → permissions across the codebase, and lets the LLM
   actually pick the right tool.
2. **Slice 37** — Per-Tenant KC Client Secrets via K8s Secrets. Production
   hygiene for multi-tenant deployments. Today's single-realm dev works
   fine via the `KEYCLOAK_CLIENT_SECRET` fallback. Run this when you're
   ready to onboard a second tenant.
3. **Slices 29, 30** — Operational deploy runbook + Teams app
   registration. Run last; require live cluster and Azure access.

Slices 37 and 38 can run in either order — they're independent. 38 first
gives a faster observable win. 37 is more architectural.

---

## The Seven Non-Negotiables

Enforce in every session. Fail the session if any are violated.

1. `tenantId: string` on every domain interface, DB table, agent state, Temporal workflow ID
2. No `import` from `@anthropic-ai/sdk` anywhere — all LLM calls go via LiteLLM
3. NATS subjects only via `Subjects.*` or `buildSubject()` from `@cip/shared`
4. Every `workflow.start()` has `workflowId: \`{type}-${tenantId}-${entityId}\`` + comment
5. Every Temporal Activity validates output with Zod `.parse()` before returning
6. No MCP tool input schema contains `tenantId` — always from `authInfo.token`
7. Stubs use `throw new Error('not implemented')` — never `return undefined as any`

---

## Module Structure Rule

All hr-service business logic lives inside its module:

```
packages/hr-service/src/modules/
  certifications/    workflows/ activities/ agents/ mcp-tools/ cards/
  employees/         workflows/ activities/ mcp-tools/ cards/
  compliance/        mcp-tools/ cards/
```

Nothing from one module imports from another module. Cross-module access goes via
the shared DB layer or NATS events — never direct imports.

---

## Cross-Slice Protocol

1. Finish the current slice with the correct types even if typecheck fails on an earlier package
2. Log the issue in [CROSS_SLICE_NOTES.md](./CROSS_SLICE_NOTES.md)
3. Run `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` to resolve all open notes before the next slice

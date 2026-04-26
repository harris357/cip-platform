# CIP Platform — Session Prompts

One prompt per slice. Copy verbatim into Claude Code to start the session.
Each prompt is self-contained — do not load any file not listed under "Read before writing."

---

## PROMPT 02 — Shared Types

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 02 — Shared Types
Goal: Create all shared domain types used by every other package.

Read before writing:
- slices/SLICE_02_SHARED_TYPES.md

Create only these files:
- packages/shared/src/types/tenant.ts
- packages/shared/src/types/employee.ts
- packages/shared/src/types/certification.ts
- packages/shared/src/types/role.ts
- packages/shared/src/types/agent.ts
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/events.ts
- packages/shared/src/types/mcp.ts
- packages/shared/src/index.ts (re-exports only)

Hard rules:
1. No client imports (pg, nats, temporalio) — types only
2. ExtractionResult must be z.infer<typeof ExtractionResultSchema> — not a hand-written interface
3. Worker type must not exist — Employee only
4. All dates are string (ISO 8601) — never Date
5. mergeCapabilities() must be a pure function with no side effects

Finish with: pnpm --filter @cip/shared typecheck
Report the full typecheck output. Fix all errors before finishing.
```

---

## PROMPT 05A — HR Domain Schema

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 05A — HR Domain Schema
Goal: Write the normalized SQL migration that establishes the full HR domain schema.

Read before writing:
- slices/SLICE_05A_HR_DOMAIN.md

Create only this file:
- packages/hr-service/src/db/migrations/002_domain_model.sql

Also create these empty directories (touch a .gitkeep in each):
- packages/hr-service/src/modules/certifications/
- packages/hr-service/src/modules/employees/
- packages/hr-service/src/modules/compliance/

Hard rules:
1. Every tenant-scoped table must have tenant_id UUID NOT NULL and an RLS policy
2. submission_status CHECK must match exactly: pending|processing|matched|failed|hitl_required
3. cert_status CHECK must match exactly: valid|expired|revoked|superseded
4. Lookup tables (hitl_reasons etc.) have no tenant_id — they are global
5. All seed INSERTs use ON CONFLICT (code) DO NOTHING

No typecheck for this slice — validate SQL syntax manually or against a dev DB.
Report any constraints or indexes you added and why.
```

---

## PROMPT 05B — HR ORM + Registry

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 05B — HR ORM + Registry
Goal: Add Drizzle ORM schema, withTenantRLS wrapper, and LookupRegistry utility.

Read before writing:
- slices/SLICE_05B_HR_ORM.md
- packages/hr-service/src/db/migrations/002_domain_model.sql

Create/modify only these files:
- packages/shared/src/utils/lookup-registry.ts      (new)
- packages/shared/src/index.ts                      (add LookupRegistry export)
- packages/hr-service/src/db/index.ts               (new)
- packages/hr-service/src/db/schema.ts              (new — mirrors SQL migration exactly)
- packages/hr-service/src/db/rls.ts                 (new)
- packages/hr-service/src/db/registries.ts          (new)
- packages/hr-service/package.json                  (add drizzle-orm, pg dependencies if missing)

Hard rules:
1. withTenantRLS() must SET LOCAL inside a transaction — never outside one
2. Every Drizzle table must have tenantId: uuid('tenant_id').notNull() where the SQL has tenant_id
3. LookupRegistry throws on unknown code — never returns undefined
4. getDb() and getHrRegistries() are lazy singletons — never connect/load at module load time
5. No status string literals used directly — only registry.code or typed TCode

Finish with: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 06 — HR Temporal Workflows

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 06 — HR Temporal Workflows
Goal: Build CertificationProcessingWorkflow with all activities (matching activities are stubs).

Read before writing:
- slices/SLICE_06_HR_TEMPORAL.md
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/agent.ts

Create only these files:
- packages/hr-service/src/workers/temporal-worker.ts
- packages/hr-service/src/modules/certifications/workflows/certification-processing.workflow.ts
- packages/hr-service/src/modules/certifications/activities/fetch-document.activity.ts
- packages/hr-service/src/modules/certifications/activities/pre-classify-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/run-vision-agent.activity.ts
- packages/hr-service/src/modules/certifications/activities/validate-extraction.activity.ts
- packages/hr-service/src/modules/certifications/activities/persist-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/notify-hitl.activity.ts

Hard rules:
1. Workflow ID: CertProcess-${tenantId}-${submissionId} with comment on preceding line
2. matchEmployee and matchCertDefinition run with Promise.all (parallel) — stubs throwing 'not implemented'
3. runVisionAgentActivity must call ExtractionResultSchema.parse() before returning
4. HITL signal uses defineSignal + condition() — never a polling loop
5. Task queue from process.env['TEMPORAL_TASK_QUEUE_HR'] — never hardcoded

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 07 — Vision Agent

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 07 — Vision Agent (LangGraph)
Goal: Build the LangGraph vision agent used by runVisionAgentActivity.

Read before writing:
- slices/SLICE_07_VISION_AGENT.md
- packages/hr-service/src/modules/certifications/activities/run-vision-agent.activity.ts

Create only these files:
- packages/hr-service/src/modules/certifications/agents/vision-agent/index.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/state.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/nodes.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/prompts.ts

Hard rules:
1. LLM model alias is cip-vision — never a raw Anthropic model string
2. State must have tenantId: string and submissionId: string (not optional)
3. ExtractionResultSchema.parse() called on LLM response before returning from extractFields
4. Never import from @anthropic-ai/sdk — use createLiteLLMClient from @cip/shared
5. Graph has exactly 4 nodes: extractFields, assessConfidence, formatOutput, flagForHitl

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 08 — NATS Watcher

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 08 — NATS Watcher
Goal: Build the ambient watcher that reacts to domain events.

Read before writing:
- slices/SLICE_08_NATS_WATCHER.md
- packages/shared/src/types/events.ts
- packages/shared/src/utils/subject-builder.ts

Create only this file:
- packages/hr-service/src/nats/watcher.ts

Modify:
- packages/hr-service/src/index.ts (call startAmbientWatcher alongside Temporal worker)

Hard rules:
1. No raw NATS subject strings — use Subjects.* helpers only
2. Every message is acked after its handler completes
3. Use EmployeeOnboardedEvent — not WorkerOnboardedEvent (deprecated alias)
4. Each handler is a named function — no anonymous inline logic in subscription loops
5. If a Subjects.* helper is missing, log a CROSS-SLICE NOTE and use a placeholder string

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 09 — MCP Server

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 09 — MCP Server
Goal: Build the hr-service MCP server with all tool registrations.

Read before writing:
- slices/SLICE_09_MCP_SERVER.md
- packages/shared/src/types/mcp.ts
- packages/hr-service/src/db/rls.ts
- packages/hr-service/src/db/registries.ts

Create only these files:
- packages/hr-service/src/mcp-server/index.ts
- packages/hr-service/src/modules/certifications/mcp-tools/get-my-certifications.ts
- packages/hr-service/src/modules/certifications/mcp-tools/get-submission-status.ts
- packages/hr-service/src/modules/certifications/mcp-tools/process-document.ts
- packages/hr-service/src/modules/certifications/mcp-tools/resolve-hitl.ts
- packages/hr-service/src/modules/certifications/mcp-tools/cards/certifications-card.ts
- packages/hr-service/src/modules/certifications/mcp-tools/cards/submission-status-card.ts
- packages/hr-service/src/modules/employees/mcp-tools/list-staff.ts
- packages/hr-service/src/modules/employees/mcp-tools/get-employee-capabilities.ts
- packages/hr-service/src/modules/employees/mcp-tools/cards/staff-card.ts
- packages/hr-service/src/modules/settings/mcp-tools/get-tenant-channel-config.ts

Hard rules:
1. tenantId absent from every tool input schema — always from authInfo.token
2. Every tool returns McpModuleResponse serialised as JSON in content[0].text
3. Every tool has annotations.requiredCapability (empty string if none required)
4. Card builders are pure functions — no DB calls, no async
5. process_document inserts a cert_submission row then starts Temporal workflow

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 10 — Platform Core

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 10 — Platform Core
Goal: Build TenantProvisioningWorkflow with initTenantDatabase seeding roles and settings.

Read before writing:
- slices/SLICE_10_PLATFORM_CORE.md
- packages/shared/src/types/workflow.ts

Create only these files:
- packages/platform-core/src/index.ts
- packages/platform-core/src/server.ts
- packages/platform-core/src/routes/health.ts
- packages/platform-core/src/routes/tenant.ts
- packages/platform-core/src/workers/temporal-worker.ts
- packages/platform-core/src/workflows/tenant-provisioning.workflow.ts
- packages/platform-core/src/activities/create-keycloak-realm.activity.ts
- packages/platform-core/src/activities/create-temporal-namespace.activity.ts
- packages/platform-core/src/activities/create-nats-streams.activity.ts
- packages/platform-core/src/activities/create-object-store-buckets.activity.ts
- packages/platform-core/src/activities/init-tenant-database.activity.ts
- packages/platform-core/src/activities/issue-litellm-virtual-key.activity.ts
- packages/platform-core/src/activities/provision-complete-notify.activity.ts

Hard rules:
1. Workflow ID: TenantProvision-${tenantId}-${tenantId} with comment on preceding line
2. initTenantDatabase seeds the 5 system roles with correct capabilities JSONB
3. initTenantDatabase inserts an empty tenant_settings row (idempotent ON CONFLICT)
4. All activities throw new Error('not implemented') except initTenantDatabase (seed logic only)
5. Task queue from process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] — never hardcoded

Finish with: pnpm --filter @cip/platform-core typecheck
Fix all errors before finishing.
```

---

## PROMPT 14 — Matching Activities

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 14 — Matching Activities
Goal: Implement employee and cert-definition matching, replacing Slice 06 stubs.

Read before writing:
- slices/SLICE_14_MATCHING.md
- packages/hr-service/src/modules/certifications/activities/  (existing stubs to replace)
- sample/ernai/packages/orchestration-service/src/matching/personMatch.ts
- sample/ernai/packages/orchestration-service/src/matching/certMatch.ts

Create/modify only these files:
- packages/hr-service/src/modules/certifications/activities/match-employee.activity.ts
- packages/hr-service/src/modules/certifications/activities/match-cert-definition.activity.ts
- packages/hr-service/src/modules/certifications/activities/nickname-map.ts

Hard rules:
1. Both activities Zod-validate return values before returning
2. LLM calls use cip-lightweight alias via createLiteLLMClient — never a raw model string
3. DB queries use withTenantRLS — never raw queries
4. NICKNAME_MAP must have minimum 30 entries (port from PoC)
5. Three-pass employee matching: exact email → fuzzy name → LLM tiebreaker

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 15 — Employee Onboarding

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 15 — Employee Onboarding Workflow
Goal: Build EmployeeOnboardingWorkflow with 4 activities.

Read before writing:
- slices/SLICE_15_EMPLOYEE_ONBOARDING.md
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/events.ts

Create only these files:
- packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts
- packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts
- packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts
- packages/hr-service/src/modules/employees/activities/send-welcome-notification.activity.ts
- packages/hr-service/src/modules/employees/activities/publish-employee-onboarded.activity.ts

Modify:
- packages/hr-service/src/workers/temporal-worker.ts (register new workflow + activities)

Hard rules:
1. Workflow ID: EmployeeOnboard-${tenantId}-${employeeId} with comment
2. createKeycloakUser branches on identityType — separate stub for each path
3. assignDefaultRole: aad_federated → field_operations, field_employee → field_employee
4. publishEmployeeOnboarded uses Subjects.employeeOnboarded() — no raw NATS string
5. All activity bodies throw new Error('not implemented') except publishEmployeeOnboarded

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 16 — Complex Query Tools

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 16 — Complex Query Tools
Goal: Build multi-step MCP tools for compliance reporting.

Read before writing:
- slices/SLICE_16_COMPLEX_QUERY_TOOLS.md
- packages/shared/src/types/mcp.ts
- packages/hr-service/src/mcp-server/index.ts

Create only these files:
- packages/hr-service/src/modules/compliance/mcp-tools/get-expiring-certifications.ts
- packages/hr-service/src/modules/compliance/mcp-tools/get-compliance-summary.ts
- packages/hr-service/src/modules/compliance/mcp-tools/get-staff-certifications.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/expiry-card.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/compliance-summary-card.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/staff-certs-card.ts

Modify:
- packages/hr-service/src/mcp-server/index.ts (register compliance tools)

Hard rules:
1. Each tool declares requiredCapability annotation
2. Each tool returns McpModuleResponse with data, card, and message
3. All DB queries use withTenantRLS
4. Card builders are pure functions — no DB calls, no async
5. tenantId absent from all tool input schemas

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 17 — Teams Bot

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 17 — Teams Bot (Generic Gateway)
Goal: Build a lightweight Teams bot with zero business logic. Bot calls MCP only.

Read before writing:
- slices/SLICE_17_TEAMS_BOT.md
- packages/shared/src/types/mcp.ts
- packages/shared/src/types/tenant.ts

Create only these files:
- packages/teams-bot/src/index.ts
- packages/teams-bot/src/bot.ts
- packages/teams-bot/src/server.ts
- packages/teams-bot/src/teams-protocol/file-handler.ts
- packages/teams-bot/src/teams-protocol/card-renderer.ts
- packages/teams-bot/src/teams-protocol/channel-registry.ts
- packages/teams-bot/src/auth/resolve-context.ts
- packages/teams-bot/src/mcp/client.ts
- packages/teams-bot/src/mcp/tool-discovery.ts
- packages/teams-bot/src/mcp/tool-executor.ts
- packages/teams-bot/src/intent/router.ts

Hard rules:
1. No imports from @cip/hr-service — MCP client only
2. No switch(intent) or hardcoded intent strings — LLM selects the tool
3. No channel IDs, team IDs, or role names hardcoded anywhere in the bot
4. detectFileAttachments must strip text/html and handle Teams CDN download info pattern
5. POST /proactive is the only mechanism for unsolicited messages

Finish with: pnpm --filter @cip/teams-bot typecheck
Fix all errors before finishing.
```

---

## PROMPT CROSS-SLICE

```
You are working on the CIP Platform TypeScript monorepo.

Session: CROSS-SLICE — Resolve open notes
Goal: Fix all OPEN notes in slices/CROSS_SLICE_NOTES.md.

Read before writing:
- slices/CROSS_SLICE_NOTES.md  (read every OPEN note carefully)

For each OPEN note:
1. Read the affected file
2. Apply the exact fix described
3. Run typecheck on the affected package
4. Mark the note RESOLVED with today's date

Hard rules:
1. Fix only what the note specifies — no extra cleanup
2. After all fixes: pnpm -r run typecheck must pass
3. Update CROSS_SLICE_NOTES.md — move fixed notes to Resolved section

Finish with: pnpm -r run typecheck
Report full output. Do not finish if any errors remain in packages you touched.
```

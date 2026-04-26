# Slice 09 — MCP Server

> **Prerequisite:** Slices 02, 05A, 05B complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/
  mcp-server/
    index.ts                              ← server setup, registers all tools
  modules/
    certifications/
      mcp-tools/
        get-my-certifications.ts
        get-submission-status.ts
        process-document.ts
        resolve-hitl.ts
        cards/
          certifications-card.ts
          submission-status-card.ts
          hitl-card.ts
    employees/
      mcp-tools/
        list-staff.ts
        get-employee-capabilities.ts
        cards/
          staff-card.ts
    compliance/
      mcp-tools/
        (stubs — implemented in Slice 16)
    settings/
      mcp-tools/
        get-tenant-channel-config.ts
```

---

## Core Principles

1. **`tenantId` always from JWT** — never from tool arguments
2. **Every tool returns `McpModuleResponse`** — `{ data, card?, message? }`
3. **Every tool declares `requiredCapability`** — bot uses this to filter tools per user
4. **Card builders live in `cards/`** alongside their tools — not in the bot

---

## Tool Registration Pattern

```typescript
// mcp-server/index.ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

export const server = new McpServer({ name: 'hr-service', version: '1.0.0' })

// Each module registers its own tools
registerCertificationTools(server)
registerEmployeeTools(server)
registerSettingsTools(server)
```

```typescript
// modules/certifications/mcp-tools/get-my-certifications.ts
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { McpModuleResponse, Certification } from '@cip/shared'
import { withTenantRLS } from '../../../db/rls.js'
import { getDb } from '../../../db/index.js'
import { buildCertificationsCard } from './cards/certifications-card.js'

export function registerGetMyCertifications(server: McpServer) {
  server.tool(
    'get_my_certifications',
    'Get the current employee\'s certifications and expiry dates',
    {},   // no input — employeeId comes from JWT
    {
      annotations: {
        requiredCapability: 'viewOwnCerts',
        category: 'certifications',
      },
    },
    async (_args, { authInfo }) => {
      const { tenantId, employeeId } = extractAuthContext(authInfo)
      const db = getDb()
      const certs = await withTenantRLS(db, tenantId, (tx) =>
        getCertificationsForEmployee(tx, employeeId)
      )
      const response: McpModuleResponse<Certification[]> = {
        data: certs,
        card: buildCertificationsCard(certs),
        message: `You have ${certs.length} certification(s).`,
      }
      return { content: [{ type: 'text', text: JSON.stringify(response) }] }
    },
  )
}
```

---

## Tool Inventory

### Certifications module

| Tool | requiredCapability | Description |
|---|---|---|
| `get_my_certifications` | `viewOwnCerts` | Current employee's certs + expiry |
| `get_submission_status` | `viewOwnCerts` | Status of a specific submission |
| `process_document` | `uploadCertForSelf` | Trigger cert processing workflow |
| `resolve_hitl` | `resolveHitl` | Send HITLDecisionSignal to workflow |

### Employees module

| Tool | requiredCapability | Description |
|---|---|---|
| `list_staff` | `viewTeamCerts` | List employees (respects capability scope) |
| `get_employee_capabilities` | none | Returns caller's RoleCapabilities (called by bot on connect) |

### Settings module

| Tool | requiredCapability | Description |
|---|---|---|
| `get_tenant_channel_config` | none | Returns `channel_config` JSONB for tenant (called by bot) |

---

## `get_employee_capabilities` — Special Tool

This is called by the Teams Bot on every session to build `AuthContext`. It must return the full `RoleCapabilities` object for the calling employee.

```typescript
// Input: none (employeeId from JWT)
// Output: McpModuleResponse<{ capabilities: RoleCapabilities, roles: string[] }>
async (_args, { authInfo }) => {
  const { tenantId, employeeId, roles } = extractAuthContext(authInfo)
  const db = getDb()
  const roleRows = await withTenantRLS(db, tenantId, (tx) =>
    getRolesForEmployee(tx, employeeId)
  )
  const capabilities = mergeCapabilities(roleRows.map(r => r.capabilities))
  const response: McpModuleResponse = {
    data: { capabilities, roles },
    message: `${roles.length} role(s) active.`,
  }
  return { content: [{ type: 'text', text: JSON.stringify(response) }] }
}
```

---

## `process_document` Tool

Triggers `CertificationProcessingWorkflow`. Does not wait for completion.

```typescript
// Input: { objectStoreKey: string }  ← key was set by the Teams Bot before calling
// Output: McpModuleResponse<{ submissionId, workflowId }>
async ({ objectStoreKey }, { authInfo }) => {
  const { tenantId, employeeId } = extractAuthContext(authInfo)
  const submissionId = randomUUID()
  // Insert cert_submission row
  // Start Temporal workflow
  // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
  const workflowId = `CertProcess-${tenantId}-${submissionId}`
  // ...
  const response: McpModuleResponse = {
    data: { submissionId, workflowId },
    card: buildProcessingAckCard(submissionId),
    message: `Your certificate is being processed. Submission ID: ${submissionId}`,
  }
  return { content: [{ type: 'text', text: JSON.stringify(response) }] }
}
```

---

## Card Builders

Each card builder is a pure function: takes data, returns Adaptive Card JSON.

```typescript
// cards/certifications-card.ts
import type { Certification } from '@cip/shared'

export function buildCertificationsCard(certs: Certification[]): object {
  return {
    type: 'AdaptiveCard',
    version: '1.5',
    body: [
      { type: 'TextBlock', text: 'Your Certifications', weight: 'Bolder', size: 'Medium' },
      ...certs.map(c => ({
        type: 'ColumnSet',
        columns: [
          { type: 'Column', items: [{ type: 'TextBlock', text: c.certDefId }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: c.expiresAt ?? 'No expiry' }] },
          { type: 'Column', items: [{ type: 'TextBlock', text: c.certStatus }] },
        ],
      })),
    ],
  }
}
```

---

## Acceptance Criteria

- [ ] `tenantId` is absent from every tool's input schema
- [ ] Every tool returns `McpModuleResponse` serialised as JSON in `content[0].text`
- [ ] Every tool has `annotations.requiredCapability` (empty string `''` if none required)
- [ ] `get_employee_capabilities` returns merged `RoleCapabilities` across all employee roles
- [ ] `get_tenant_channel_config` returns `channel_config` JSONB from `tenant_settings`
- [ ] `process_document` inserts a `cert_submission` row and starts a Temporal workflow
- [ ] All card builders are pure functions with no DB calls
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

# Slice 16 — Complex Query Tools

> **Prerequisite:** Slices 05B, 09 complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

Multi-step MCP tools for compliance reporting. These handle queries that require
aggregating data across multiple employees or submissions — too complex for a single
DB query, not complex enough to warrant a LangGraph agent.

```
packages/hr-service/src/modules/compliance/
  mcp-tools/
    get-expiring-certifications.ts
    get-compliance-summary.ts
    get-staff-certifications.ts
    cards/
      expiry-card.ts
      compliance-summary-card.ts
      staff-certs-card.ts
```

Register all three tools from `mcp-server/index.ts`.

---

## Tool Inventory

| Tool | requiredCapability | Description |
|---|---|---|
| `get_expiring_certifications` | `viewTeamCerts` | Certs expiring within N days for accessible employees |
| `get_compliance_summary` | `viewAllCerts` | Aggregate compliance % across all employees |
| `get_staff_certifications` | `viewTeamCerts` | All certifications for a named employee |

---

## `get_expiring_certifications`

```typescript
// Input: { daysAhead?: number }  (default 90)
// Steps:
//   1. Fetch all active certifications expiring within daysAhead
//   2. Group by employee
//   3. Enrich with employee name
// Output: McpModuleResponse<ExpiringCertGroup[]>

interface ExpiringCertGroup {
  employee: { id: string; fullName: string; email: string }
  certs: Array<{ displayName: string; expiresAt: string; daysRemaining: number }>
}
```

---

## `get_compliance_summary`

```typescript
// Input: none
// Steps:
//   1. Fetch all employees in tenant
//   2. For each, count valid vs expired/missing required certs
//   3. Return aggregate stats
// Output: McpModuleResponse<ComplianceSummary>

interface ComplianceSummary {
  totalEmployees: number
  fullCompliance: number
  partialCompliance: number
  nonCompliant: number
  expiringWithin90Days: number
}
```

---

## `get_staff_certifications`

```typescript
// Input: { employeeId: string }
// requiredCapability: 'viewTeamCerts'
// Steps:
//   1. Verify caller has access (viewAllCerts OR same team — stub: viewTeamCerts sufficient)
//   2. Fetch all certifications for employeeId
//   3. Enrich with cert_definition display names
// Output: McpModuleResponse<StaffCertReport>
```

---

## Implementation Pattern

All three tools follow the same structure:

```typescript
export function registerGetExpiringCertifications(server: McpServer) {
  server.tool(
    'get_expiring_certifications',
    'Get certifications expiring within the specified number of days',
    z.object({ daysAhead: z.number().int().min(1).max(365).default(90) }),
    { annotations: { requiredCapability: 'viewTeamCerts', category: 'compliance' } },
    async ({ daysAhead }, { authInfo }) => {
      const { tenantId } = extractAuthContext(authInfo)
      const db = getDb()
      const groups = await withTenantRLS(db, tenantId, tx =>
        fetchExpiringCerts(tx, daysAhead)
      )
      const response: McpModuleResponse<ExpiringCertGroup[]> = {
        data: groups,
        card: buildExpiryCard(groups),
        message: `${groups.length} employee(s) have certs expiring within ${daysAhead} days.`,
      }
      return { content: [{ type: 'text', text: JSON.stringify(response) }] }
    },
  )
}
```

---

## Acceptance Criteria

- [ ] Three tools registered: `get_expiring_certifications`, `get_compliance_summary`, `get_staff_certifications`
- [ ] Each declares `requiredCapability` annotation
- [ ] Each returns `McpModuleResponse` with `data`, `card`, and `message`
- [ ] All DB queries use `withTenantRLS`
- [ ] Card builders are pure functions in `cards/`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

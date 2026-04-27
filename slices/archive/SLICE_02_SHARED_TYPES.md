# Slice 02 — Shared Types

> **Prerequisite:** Slice 01 complete.
> **Package:** `@cip/shared`
> **Verify:** `pnpm --filter @cip/shared typecheck`

---

## What You Are Building

```
packages/shared/src/
  index.ts
  types/
    tenant.ts          ← TenantContext, TenantConfig, AuthContext
    employee.ts        ← Employee, IdentityType, EmploymentType
    certification.ts   ← CertSubmission, Certification, CertDefinition, status unions
    role.ts            ← Role, RoleCapabilities, mergeCapabilities()
    agent.ts           ← AgentState, VisionAgentState, ExtractionResultSchema (Zod)
    workflow.ts        ← all workflow input/output + HITLDecisionSignal
    events.ts          ← NATS event payloads
    mcp.ts             ← McpModuleResponse<T>
```

---

## Type Contracts

### `mcp.ts`
```typescript
/** Standard envelope every MCP tool returns. */
export interface McpModuleResponse<T = unknown> {
  data: T
  card?: object        // Adaptive Card JSON — bot renders if present
  message?: string     // plain text fallback
}
```

### `tenant.ts`
```typescript
export interface TenantContext {
  tenantId: string     // never optional
  userId: string
  tenantConfig: TenantConfig
}

export interface TenantConfig {
  tenantId: string
  name: string
  litellmVirtualKey: string
  keycloakRealm: string
  natsPrefix: string   // `cip.${tenantId}`
  langfuseTags: Record<string, string>
}

export interface AuthContext extends TenantContext {
  employeeId: string
  roles: string[]                  // keycloak_role codes from JWT
  capabilities: RoleCapabilities
}
```

### `employee.ts`
```typescript
export type IdentityType = 'aad_federated' | 'field_employee'
export type EmploymentType = 'employee'   // stub — extend when HR modules added

export interface Employee {
  id: string
  tenantId: string
  email: string
  fullName: string
  givenName?: string
  surname?: string
  phone?: string
  aadOid?: string          // null for field_employee
  keycloakId?: string      // set after onboarding workflow
  identityType: IdentityType
  employmentType: EmploymentType
  dateOfBirth?: string     // ISO 8601 date
  createdAt: string
  updatedAt: string
}
```

### `certification.ts`
```typescript
export type SubmissionStatus =
  | 'pending' | 'processing' | 'matched' | 'failed' | 'hitl_required'

export type CertStatus = 'valid' | 'expired' | 'revoked' | 'superseded'

/** One per submitted document — tracks the processing pipeline. */
export interface CertSubmission {
  id: string
  tenantId: string
  submittedBy: string        // employeeId — always known at intake
  matchedEmployeeId?: string // set after person matching
  certDefId?: string         // set after cert-def matching
  submissionStatus: SubmissionStatus
  objectStoreKey: string
  confidence?: number
  extractedFields?: Record<string, unknown>
  promptVersion?: string
  modelUsed?: string
  workflowId?: string
  createdAt: string
  updatedAt: string
}

/** One per validated credential per employee. */
export interface Certification {
  id: string
  tenantId: string
  employeeId: string
  certDefId: string
  submissionId?: string
  certStatus: CertStatus
  issueDate?: string
  expiresAt?: string
  issuedByText?: string
  createdAt: string
  updatedAt: string
}

/** Tenant-scoped certificate library entry. */
export interface CertDefinition {
  id: string
  tenantId: string
  certTypeId: string
  issuingOrgId?: string
  displayName: string
  defaultValidityDays?: number
  keywords: string[]
  isActive: boolean
}
```

### `role.ts`
```typescript
export interface RoleCapabilities {
  uploadCertForSelf: boolean
  uploadCertForOthers: boolean
  viewOwnCerts: boolean
  viewTeamCerts: boolean
  viewAllCerts: boolean
  resolveHitl: boolean
  manageEmployees: boolean
  manageRoles: boolean
  viewCostReports: boolean
  allocateEmployees: boolean
}

export const EMPTY_CAPABILITIES: RoleCapabilities = {
  uploadCertForSelf: false, uploadCertForOthers: false,
  viewOwnCerts: false, viewTeamCerts: false, viewAllCerts: false,
  resolveHitl: false, manageEmployees: false, manageRoles: false,
  viewCostReports: false, allocateEmployees: false,
}

export function mergeCapabilities(caps: RoleCapabilities[]): RoleCapabilities {
  return caps.reduce(
    (acc, c) => ({
      uploadCertForSelf:   acc.uploadCertForSelf   || c.uploadCertForSelf,
      uploadCertForOthers: acc.uploadCertForOthers || c.uploadCertForOthers,
      viewOwnCerts:        acc.viewOwnCerts        || c.viewOwnCerts,
      viewTeamCerts:       acc.viewTeamCerts       || c.viewTeamCerts,
      viewAllCerts:        acc.viewAllCerts         || c.viewAllCerts,
      resolveHitl:         acc.resolveHitl          || c.resolveHitl,
      manageEmployees:     acc.manageEmployees      || c.manageEmployees,
      manageRoles:         acc.manageRoles          || c.manageRoles,
      viewCostReports:     acc.viewCostReports      || c.viewCostReports,
      allocateEmployees:   acc.allocateEmployees    || c.allocateEmployees,
    }),
    { ...EMPTY_CAPABILITIES },
  )
}

export interface Role {
  id: string
  tenantId: string
  keycloakRole: string
  label: string
  description?: string
  capabilities: RoleCapabilities
  isSystemRole: boolean
}
```

### `agent.ts`
```typescript
import { z } from 'zod'

export interface AgentState {
  tenantId: string
  runId: string
  startedAt: string
  completedAt?: string
  error?: string
}

export interface VisionAgentState extends Omit<AgentState, 'runId' | 'startedAt'> {
  submissionId: string
  employeeId: string
  objectStoreKey: string
  documentBase64?: string
  extraction?: ExtractionResult
  requiresHitl: boolean
  userId: string
  workflowId?: string
  activityId?: string
  model?: string
}

export const ExtractionResultSchema = z.object({
  tenantId:     z.string().uuid(),
  submissionId: z.string().uuid(),
  extracted: z.object({
    holderName:  z.string().optional(),
    holderEmail: z.string().optional(),
    certName:    z.string().optional(),
    issuingBody: z.string().optional(),
    issueDate:   z.string().optional(),
    expiryDate:  z.string().optional(),
    certNumber:  z.string().optional(),
  }).passthrough(),
  confidence: z.number().min(0).max(1),
  rawText:    z.string(),
  warnings:   z.array(z.string()),
})

export type ExtractionResult = z.infer<typeof ExtractionResultSchema>

export const IntentResultSchema = z.object({
  intent:     z.enum(['UPLOAD_CERT', 'QUERY_COMPLIANCE', 'RESPOND_HITL', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  entities:   z.record(z.string()),
  tenantId:   z.string(),
})

export type IntentResult = z.infer<typeof IntentResultSchema>
```

### `workflow.ts`
```typescript
import type { CertStatus, SubmissionStatus } from './certification.js'
import type { ExtractionResult } from './agent.js'

export interface CertProcessingInput {
  tenantId: string
  submissionId: string
  employeeId: string
  objectStoreKey: string
  certificationId: string
}

export interface CertProcessingOutput {
  tenantId: string
  submissionId: string
  submissionStatus: SubmissionStatus
  certificationId?: string
  certStatus?: CertStatus
  extractionResult?: ExtractionResult
  hitlRequired: boolean
}

export interface EmployeeOnboardingInput {
  tenantId: string
  employeeId: string
  identityType: 'aad_federated' | 'field_employee'
  email: string
  fullName: string
  aadOid?: string
}

export interface EmployeeOnboardingOutput {
  tenantId: string
  employeeId: string
  keycloakId: string
  onboardedAt: string
}

export interface TenantProvisioningInput {
  tenantId: string
  tenantName: string
  adminEmail: string
  tier: 'standard' | 'premium' | 'enterprise'
  budgetLimitUsd: number
}

export interface TenantProvisioningOutput {
  tenantId: string
  success: boolean
  provisionedAt: string
  litellmVirtualKey: string
}

export interface HITLDecisionSignal {
  approved: boolean
  correctedFields?: Record<string, string>
  reviewedBy: string
  reviewedAt: string
}
```

### `events.ts`
```typescript
export interface CertSubmittedEvent {
  tenantId: string; submissionId: string; employeeId: string
  objectStoreKey: string; submittedAt: string
}
export interface CertProcessedEvent {
  tenantId: string; submissionId: string; submissionStatus: string; processedAt: string
}
export interface CertExpiredEvent {
  tenantId: string; certificationId: string; employeeId: string; expiredAt: string
}
export interface EmployeeMatchedEvent {
  tenantId: string; submissionId: string; matchedEmployeeId: string
  method: string; confidence: number; matchedAt: string
}
export interface CertDefinitionMatchedEvent {
  tenantId: string; submissionId: string; certDefId: string
  method: string; confidence: number; matchedAt: string
}
export interface ComplianceDriftedEvent {
  tenantId: string; employeeId: string
  driftType: 'missing_cert' | 'expired_cert' | 'allocation_mismatch'; detectedAt: string
}
export interface EmployeeOnboardedEvent {
  tenantId: string; employeeId: string; identityType: string; onboardedAt: string
}
export interface TenantProvisionedEvent {
  tenantId: string; tenantName: string; provisionedAt: string
}
// Backward-compat aliases
export type WorkerOnboardedEvent = EmployeeOnboardedEvent
export type CertUploadedEvent = CertSubmittedEvent
```

---

## Acceptance Criteria

- [ ] `pnpm --filter @cip/shared typecheck` passes
- [ ] `McpModuleResponse<T>` exported from `mcp.ts` and `index.ts`
- [ ] `Worker` type does not exist — only `Employee`
- [ ] `Certification` has `certDefId` + `employeeId` — no free-text `certType`
- [ ] `CertSubmission` and `Certification` are separate interfaces
- [ ] `ExtractionResult` is `z.infer<typeof ExtractionResultSchema>` — not a hand-written interface
- [ ] `mergeCapabilities()` is exported and pure
- [ ] No client imports in this package — types only
- [ ] All dates are `string` (ISO 8601)

# Slice 02 — Shared Types

> **Prerequisite:** Slice 01 complete and `pnpm install` passes.  
> **Session size:** Medium — 5 type files, ~200–300 lines of TypeScript.  
> **Verify with:** `pnpm --filter @cip/shared typecheck`

---

## What You Are Building

All domain types that every other package imports. No clients, no utils — types only.

```
packages/shared/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts           ← re-exports everything
    └── types/
        ├── tenant.ts      ← TenantContext, TenantConfig
        ├── certification.ts  ← Certification, ExtractionResult, CertStatus
        ├── agent.ts       ← AgentState, VisionAgentState, IntentResult
        ├── workflow.ts    ← workflow input/output types
        └── events.ts      ← NATS event payload types
```

---

## Type Contracts to Enforce

### `tenant.ts`
```typescript
export interface TenantContext {
  tenantId: string       // UUID — never optional
  userId: string
  tenantConfig: TenantConfig
}

export interface TenantConfig {
  tenantId: string
  name: string
  litellmVirtualKey: string
  keycloakRealm: string
  natsPrefix: string     // = `cip.${tenantId}`
  langfuseTags: Record<string, string>
}
```

### `certification.ts`
```typescript
export type CertStatus = 'pending' | 'processing' | 'valid' | 'rejected' | 'expired'

export interface Certification {
  id: string
  tenantId: string       // REQUIRED — RLS key
  workerId: string
  certType: string
  issuingBody: string
  issueDate: string      // ISO 8601
  expiryDate: string     // ISO 8601
  documentUrl: string
  status: CertStatus
  confidenceScore: number
  createdAt: string
  updatedAt: string
}

export interface ExtractionResult {
  tenantId: string       // REQUIRED
  certId: string
  extracted: Partial<Omit<Certification, 'id' | 'tenantId' | 'workerId' | 'status' | 'createdAt' | 'updatedAt'>>
  confidence: number     // 0–1
  rawText: string
  warnings: string[]
}
```

### `agent.ts`
```typescript
export interface AgentState {
  tenantId: string       // REQUIRED on every agent state
  runId: string
  startedAt: string
  completedAt?: string
  error?: string
}

export interface VisionAgentState extends AgentState {
  certId: string
  documentUrl: string
  documentBase64?: string
  extraction?: ExtractionResult
  requiresHitl: boolean
  hitlResolution?: HitlResolution
}

export interface HitlResolution {
  reviewedBy: string
  resolvedAt: string
  approved: boolean
  corrections?: Partial<ExtractionResult['extracted']>
}

export interface IntentResult {
  intent: 'UPLOAD_CERT' | 'QUERY_COMPLIANCE' | 'RESPOND_HITL' | 'UNKNOWN'
  confidence: number
  entities: Record<string, string>
  tenantId: string       // REQUIRED
}
```

### `workflow.ts`
```typescript
export interface CertProcessingInput {
  tenantId: string
  certId: string
  workerId: string
  documentUrl: string
  uploadedBy: string
}

export interface CertProcessingOutput {
  tenantId: string
  certId: string
  status: CertStatus
  extractionResult?: ExtractionResult
  hitlRequired: boolean
}

export interface TenantProvisioningInput {
  tenantId: string
  tenantName: string
  adminEmail: string
}

export interface TenantProvisioningOutput {
  tenantId: string
  success: boolean
  provisionedAt: string
  litellmVirtualKey: string
}
```

### `events.ts` — NATS event payloads
```typescript
// Subject pattern: cip.{tenantId}.{domain}.{event}.v{N}
// Always built via buildSubject() — never as raw strings

export interface CertUploadedEvent {
  tenantId: string
  certId: string
  workerId: string
  documentUrl: string
  uploadedBy: string
  uploadedAt: string
}

export interface CertProcessedEvent {
  tenantId: string
  certId: string
  status: CertStatus
  processedAt: string
}

export interface CertExpiredEvent {
  tenantId: string
  certId: string
  workerId: string
  expiredAt: string
}

export interface ComplianceDriftedEvent {
  tenantId: string
  workerId: string
  driftType: 'missing_cert' | 'expired_cert' | 'allocation_mismatch'
  detectedAt: string
}
```

---

## `packages/shared/tsconfig.json`

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src/**/*"]
}
```

---

## Acceptance Criteria

- [ ] `pnpm --filter @cip/shared typecheck` passes with zero errors
- [ ] Every type and interface has `tenantId: string` (not optional) where applicable
- [ ] `index.ts` re-exports everything from `types/`
- [ ] No client imports (`pg`, `nats`, `temporalio`) — types only
- [ ] `CertStatus` is a union type, not an enum (enums are harder to extend)
- [ ] All date fields are `string` (ISO 8601) not `Date` (serialisation-safe for Temporal payloads)

---

## Why `string` Dates?

Temporal workflow inputs/outputs must be JSON-serialisable. `Date` objects lose their prototype after JSON round-trip. Use ISO 8601 strings and parse at the boundary only when needed for comparison logic.

---

## Things That Will Break Slice 06 If Wrong

- Missing `tenantId` on `VisionAgentState` — the vision agent Activity will fail the tenantId rule
- `ExtractionResult.extracted` fields being required (not `Partial`) — Zod validation in Activities will reject partial extractions
- `CertProcessingInput` missing `workerId` — the workflow can't associate the cert with a worker

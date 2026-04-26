# Slice 05B — HR ORM + Registry

> **Prerequisite:** Slice 05A migration file exists.
> **Package:** `@cip/hr-service` + `@cip/shared`
> **Verify:** `pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/shared typecheck`

---

## What You Are Building

```
packages/shared/src/utils/
  lookup-registry.ts      ← generic LookupRegistry<TCode> class

packages/hr-service/src/db/
  index.ts                ← drizzle(pool) factory, exports Db type
  schema.ts               ← Drizzle table definitions (mirrors 002_domain_model.sql)
  rls.ts                  ← withTenantRLS<T>() wrapper
  registries.ts           ← instantiates LookupRegistry for each lookup table
```

---

## `packages/shared/src/utils/lookup-registry.ts`

```typescript
type LookupRow<TCode extends string> = { id: number; code: TCode; label: string }

export class LookupRegistry<TCode extends string = string> {
  private byCode: Map<TCode, LookupRow<TCode>>
  private byId:   Map<number, LookupRow<TCode>>

  constructor(rows: LookupRow<TCode>[]) {
    this.byCode = new Map(rows.map(r => [r.code, r]))
    this.byId   = new Map(rows.map(r => [r.id,   r]))
  }

  id(code: TCode): number {
    const row = this.byCode.get(code)
    if (!row) throw new Error(`LookupRegistry: unknown code "${code}". Valid: ${[...this.byCode.keys()].join(', ')}`)
    return row.id
  }

  label(code: TCode): string {
    const row = this.byCode.get(code)
    if (!row) throw new Error(`LookupRegistry: unknown code "${code}"`)
    return row.label
  }

  code(id: number): TCode {
    const row = this.byId.get(id)
    if (!row) throw new Error(`LookupRegistry: unknown id ${id}`)
    return row.code
  }

  all(): LookupRow<TCode>[] {
    return [...this.byCode.values()]
  }
}
```

Export from `packages/shared/src/index.ts`.

---

## `packages/hr-service/src/db/index.ts`

```typescript
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import * as schema from './schema.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>

let _pool: Pool | null = null
let _db: Db | null = null

export function getDb(): Db {
  if (!_db) {
    _pool = new Pool({ connectionString: process.env['DATABASE_URL_HR'] })
    _db = drizzle(_pool, { schema })
  }
  return _db
}
```

---

## `packages/hr-service/src/db/rls.ts`

```typescript
import { sql } from 'drizzle-orm'
import type { Db } from './index.js'

export async function withTenantRLS<T>(
  db: Db,
  tenantId: string,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL app.current_tenant_id = ${tenantId}`)
    return fn(tx as unknown as Db)
  })
}
```

---

## `packages/hr-service/src/db/schema.ts`

Define Drizzle tables mirroring the SQL migration. Key patterns:

```typescript
import {
  pgTable, uuid, text, boolean, integer, numeric,
  timestamp, date, jsonb, primaryKey
} from 'drizzle-orm/pg-core'

// Lookup tables (no tenant_id)
export const hitlReasons = pgTable('hitl_reasons', {
  id:    integer('id').primaryKey().generatedAlwaysAsIdentity(),
  code:  text('code').notNull().unique(),
  label: text('label').notNull(),
})

// ... repeat for hitlResolutions, notificationTypes, employmentTypes,
//     identityTypes, workflowStepNames

// Tenant-scoped tables
export const employees = pgTable('employees', {
  id:             uuid('id').primaryKey().defaultRandom(),
  tenantId:       uuid('tenant_id').notNull(),
  email:          text('email').notNull(),
  fullName:       text('full_name').notNull(),
  givenName:      text('given_name'),
  surname:        text('surname'),
  phone:          text('phone'),
  aadOid:         text('aad_oid'),
  keycloakId:     text('keycloak_id'),
  identityType:   text('identity_type').notNull(),
  employmentType: text('employment_type').notNull().default('employee'),
  dateOfBirth:    date('date_of_birth'),
  createdAt:      timestamp('created_at').defaultNow(),
  updatedAt:      timestamp('updated_at').defaultNow(),
})

// ... roles, employeeRoles, certificateTypes, issuingOrganizations,
//     certificateDefinitions, certSubmissions, certifications,
//     hitlItems, notifications, workflowStepCosts,
//     agentRuns, tenantSettings
```

Every tenant-scoped table must have `tenantId: uuid('tenant_id').notNull()`. No exceptions.

---

## `packages/hr-service/src/db/registries.ts`

```typescript
import { LookupRegistry } from '@cip/shared'
import { getDb } from './index.js'
import { hitlReasons, hitlResolutions, notificationTypes, workflowStepNames } from './schema.js'

export type HitlReasonCode =
  | 'low_confidence' | 'ambiguous_person' | 'ambiguous_cert_type'
  | 'expired_document' | 'illegible_document' | 'manual_review'

export type HitlResolutionCode = 'approved' | 'corrected' | 'rejected'

export type NotificationTypeCode =
  | 'cert_processed' | 'cert_expiring_soon' | 'cert_expired'
  | 'hitl_required'  | 'hitl_resolved' | 'onboarding_complete' | 'hr_message_sent'

export type WorkflowStepNameCode =
  | 'fetch_document' | 'pre_classify' | 'vision_extraction'
  | 'match_employee' | 'match_cert_definition' | 'persist_certification' | 'send_notification'

export interface HrRegistries {
  hitlReasons:      LookupRegistry<HitlReasonCode>
  hitlResolutions:  LookupRegistry<HitlResolutionCode>
  notificationTypes: LookupRegistry<NotificationTypeCode>
  workflowStepNames: LookupRegistry<WorkflowStepNameCode>
}

export async function loadHrRegistries(): Promise<HrRegistries> {
  const db = getDb()
  const [reasons, resolutions, notifTypes, stepNames] = await Promise.all([
    db.select().from(hitlReasons),
    db.select().from(hitlResolutions),
    db.select().from(notificationTypes),
    db.select().from(workflowStepNames),
  ])
  return {
    hitlReasons:       new LookupRegistry(reasons       as any),
    hitlResolutions:   new LookupRegistry(resolutions   as any),
    notificationTypes: new LookupRegistry(notifTypes    as any),
    workflowStepNames: new LookupRegistry(stepNames     as any),
  }
}

let _registries: HrRegistries | null = null

export async function getHrRegistries(): Promise<HrRegistries> {
  if (!_registries) _registries = await loadHrRegistries()
  return _registries
}
```

---

## Acceptance Criteria

- [ ] `LookupRegistry<TCode>` exported from `@cip/shared`
- [ ] `withTenantRLS()` sets `app.current_tenant_id` inside a transaction — never outside one
- [ ] Every Drizzle table mirrors the SQL schema exactly (same column names, types, constraints)
- [ ] `getDb()` is a lazy singleton — does not connect until first call
- [ ] `getHrRegistries()` is a lazy singleton — loads from DB once on first call
- [ ] No status string literals used directly in any file in this slice — only registry codes
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

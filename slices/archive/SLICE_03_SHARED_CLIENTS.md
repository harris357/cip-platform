# Slice 03 — Shared Clients & Utils

> **Prerequisite:** Slice 02 complete and `@cip/shared` typechecks.  
> **Session size:** Medium-large — 8 files, ~400 lines.  
> **Verify with:** `pnpm --filter @cip/shared typecheck`

---

## What You Are Building

The client factories and utilities that every service uses to connect to infrastructure. These are **stubs with correct types** — they will be wired to real credentials in later slices.

```
packages/shared/src/
├── clients/
│   ├── litellm.ts       ← OpenAI-compatible client factory (LiteLLM proxy)
│   ├── langfuse.ts      ← Langfuse observability singleton
│   ├── temporal.ts      ← Temporal Cloud connection factory
│   ├── nats.ts          ← NATS JetStream connection factory
│   └── postgres.ts      ← pg Pool factory + RLS helpers
└── utils/
    ├── subject-builder.ts   ← NATS subject construction — NO raw strings elsewhere
    ├── tenant-context.ts    ← JWT extraction, withTenantContext helper
    └── zod-schemas.ts       ← Shared Zod schemas for event payloads + agent outputs
```

---

## Client Contracts

### `litellm.ts` — the most critical client

```typescript
import OpenAI from 'openai'

export interface LiteLLMClientOptions {
  tenantId: string         // used for Langfuse tag attribution
  virtualKey: string       // per-tenant key issued at provisioning
  baseURL?: string         // defaults to LITELLM_BASE_URL env var
}

export function createLiteLLMClient(opts: LiteLLMClientOptions): OpenAI {
  return new OpenAI({
    apiKey: opts.virtualKey,
    baseURL: opts.baseURL ?? process.env['LITELLM_BASE_URL'],
    defaultHeaders: {
      'x-tenant-id': opts.tenantId,      // forwarded to Langfuse
    },
  })
}
```

**This is the only LLM client in the codebase.** Services receive `TenantContext.tenantConfig.litellmVirtualKey` and pass it here. Never `new OpenAI({ apiKey: process.env.ANTHROPIC_API_KEY })`.

### `nats.ts`

```typescript
import { connect, NatsConnection, JetStreamManager } from 'nats'

export interface NatsClientOptions {
  url?: string    // defaults to NATS_URL env var
}

export async function createNatsClient(opts?: NatsClientOptions): Promise<NatsConnection> {
  return connect({ servers: opts?.url ?? process.env['NATS_URL'] })
}

export async function createJetStreamManager(nc: NatsConnection): Promise<JetStreamManager> {
  return nc.jetstreamManager()
}
```

### `postgres.ts` — RLS is the important part

```typescript
import { Pool, PoolClient } from 'pg'

export function createPool(connectionString: string): Pool {
  return new Pool({ connectionString, max: 10 })
}

// ALWAYS use this wrapper — sets the RLS session variable before any query
export async function withTenantRLS<T>(
  client: PoolClient,
  tenantId: string,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  await client.query('SET app.current_tenant_id = $1', [tenantId])
  try {
    return await fn(client)
  } finally {
    await client.query('RESET app.current_tenant_id')
  }
}
```

Every DB query in `hr-service` goes through `withTenantRLS`. Raw `pool.query()` without this wrapper is a security bug.

### `temporal.ts`

```typescript
import { Connection, Client } from '@temporalio/client'

export async function createTemporalClient(): Promise<Client> {
  const connection = await Connection.connect({
    address: process.env['TEMPORAL_ADDRESS'],
    // mTLS handled via TEMPORAL_API_KEY in cloud connection
  })
  return new Client({
    connection,
    namespace: process.env['TEMPORAL_NAMESPACE'],
  })
}
```

---

## `subject-builder.ts` — Critical Utility

```typescript
// ALL NATS subjects must be constructed here. Never elsewhere.

export type NatsDomain = 'cert' | 'worker' | 'compliance' | 'tenant'
export type NatsVersion = 'v1'

export interface SubjectParts {
  tenantId: string
  domain: NatsDomain
  event: string
  version?: NatsVersion
}

export function buildSubject(parts: SubjectParts): string {
  const v = parts.version ?? 'v1'
  return `cip.${parts.tenantId}.${parts.domain}.${parts.event}.${v}`
}

// Pre-built subject builders for known events
export const Subjects = {
  certUploaded: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'uploaded' }),
  certProcessed: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'processed' }),
  certExpired: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'cert', event: 'expired' }),
  complianceDrifted: (tenantId: string) =>
    buildSubject({ tenantId, domain: 'compliance', event: 'drifted' }),
} as const
```

### `tenant-context.ts`

```typescript
import { TenantContext } from '../types/tenant.js'
import { Request } from 'express'

// Extracts TenantContext from a verified JWT in the Authorization header
// Throws if tenantId is missing — this is a hard requirement
export function extractTenantContext(req: Request): TenantContext {
  // JWT should already be verified by middleware before this is called
  const payload = (req as any).jwtPayload
  if (!payload?.tenantId) throw new Error('Missing tenantId in JWT payload')
  return {
    tenantId: payload.tenantId,
    userId: payload.sub,
    tenantConfig: payload.tenantConfig,
  }
}

// Convenience wrapper for async operations that need a tenant context
export async function withTenantContext<T>(
  ctx: TenantContext,
  fn: (ctx: TenantContext) => Promise<T>
): Promise<T> {
  return fn(ctx)
}
```

---

## `zod-schemas.ts` — Shared Validation

Define Zod schemas that mirror the TypeScript types. These are used in Temporal Activities to validate outputs before returning.

```typescript
import { z } from 'zod'

export const ExtractionResultSchema = z.object({
  tenantId: z.string().uuid(),
  certId: z.string().uuid(),
  extracted: z.object({
    certType: z.string().optional(),
    issuingBody: z.string().optional(),
    issueDate: z.string().optional(),
    expiryDate: z.string().optional(),
  }),
  confidence: z.number().min(0).max(1),
  rawText: z.string(),
  warnings: z.array(z.string()),
})

export const IntentResultSchema = z.object({
  intent: z.enum(['UPLOAD_CERT', 'QUERY_COMPLIANCE', 'RESPOND_HITL', 'UNKNOWN']),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string()),
  tenantId: z.string().uuid(),
})

export type ValidatedExtractionResult = z.infer<typeof ExtractionResultSchema>
export type ValidatedIntentResult = z.infer<typeof IntentResultSchema>
```

---

## Acceptance Criteria

- [ ] `pnpm --filter @cip/shared typecheck` still passes after adding clients and utils
- [ ] `createLiteLLMClient` is the only function that produces an OpenAI-compatible client — no other file does this
- [ ] `buildSubject` is exported and all hard-coded subject examples in the codebase are deleted
- [ ] `withTenantRLS` wrapper exists and is used in the `postgres.ts` client
- [ ] Zod schemas are defined for `ExtractionResult` and `IntentResult`
- [ ] No client imports `@anthropic-ai/sdk`

---

## Env Vars Each Client Uses

| Client | Env var(s) |
|--------|-----------|
| LiteLLM | `LITELLM_BASE_URL`, `LITELLM_VIRTUAL_KEY` (per-tenant, not from env) |
| Langfuse | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` |
| Temporal | `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` |
| NATS | `NATS_URL` |
| PostgreSQL | `DATABASE_URL_HR` or `DATABASE_URL_PLATFORM` |

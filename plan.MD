# CIP Platform — Claude Code Repository Creation Spec

> **Purpose:** Hand this document to Claude Code with the instruction:
> _"Create a TypeScript monorepo for the Construction Intelligence Platform exactly as specified in this document. Create every file listed. Do not skip sections. Do not invent structure not listed here."_

---

## 0. How to Use This Document

This spec is exhaustive by design. Claude Code should:

1. Read the entire document before writing any code
2. Create every file listed in Section 2 (Repo Structure)
3. Use the exact package names in Section 3 (Dependencies)
4. Implement every interface and type in Section 4 (Shared Types)
5. Create stub implementations for every service in Section 5 (Service Stubs)
6. Apply every environment variable in Section 6 (Config)
7. Wire the Makefile targets in Section 7

Where a section says **STUB**, create the file with the correct exports and types but with placeholder implementation (e.g. `throw new Error('not implemented')`). This gives Claude Code a compilable scaffold that a developer can fill in — not a blank repo.

---

## 1. Platform Overview (Context Only)

**What it is:** A multi-tenant B2B SaaS platform for the construction industry. Manages worker certifications, compliance, and training scheduling. Primary UX is a Microsoft Teams Bot.

**The core loop:**
1. A worker's certification document (photo or PDF) is uploaded via Teams Bot or web app
2. A NATS event triggers a Temporal workflow (`CertificationProcessingWorkflow`)
3. The workflow runs a LangGraph Vision Agent to extract cert fields via LiteLLM → Anthropic Claude
4. Low-confidence extractions pause at a HITL Temporal Signal — an admin reviews in Teams
5. Validated certs update the HR domain database with RLS-enforced tenant isolation
6. An Ambient Watcher monitors all certs for expiry, allocations, and compliance drift
7. All agent traces and costs flow through LiteLLM → Langfuse for per-tenant attribution

**Non-negotiables:**
- `tenantId` on every database row, every NATS subject, every agent state object, every Temporal workflow ID — from the first commit
- All LLM calls go through LiteLLM. No service imports `@anthropic-ai/sdk` directly
- All long-running workflows live in Temporal. LangGraph agents are invoked as Temporal Activities
- Every agent output is a typed, Zod-validated struct — never untyped prose

---

## 2. Repository Structure

Create this exact directory and file tree. Every file listed must be created.

```
cip/
├── package.json                          # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.js
├── .gitignore
├── .env.example
├── Makefile
│
├── packages/
│   ├── shared/                           # @cip/shared — shared types, clients, utilities
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── types/
│   │       │   ├── agent.ts              # AgentState, all agent output types
│   │       │   ├── tenant.ts             # TenantContext, TenantConfig
│   │       │   ├── certification.ts      # Cert domain types, ExtractionResult
│   │       │   ├── workflow.ts           # Workflow input/output types
│   │       │   └── events.ts             # NATS event payload types
│   │       ├── clients/
│   │       │   ├── litellm.ts            # LiteLLM OpenAI-compat client factory
│   │       │   ├── langfuse.ts           # Langfuse singleton
│   │       │   ├── temporal.ts           # Temporal connection factory
│   │       │   ├── nats.ts               # NATS connection + subject builder
│   │       │   └── postgres.ts           # pg pool factory with RLS helpers
│   │       └── utils/
│   │           ├── subject-builder.ts    # NATS subject construction
│   │           ├── tenant-context.ts     # JWT extraction, withTenantContext
│   │           └── zod-schemas.ts        # Shared Zod schemas
│   │
│   ├── hr-service/                       # @cip/hr-service — HR domain service
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   ├── helm/
│   │   │   ├── Chart.yaml
│   │   │   ├── values.yaml
│   │   │   └── templates/
│   │   │       ├── deployment.yaml
│   │   │       └── service.yaml
│   │   └── src/
│   │       ├── index.ts                  # Express app entry point
│   │       ├── server.ts                 # HTTP server setup
│   │       ├── routes/
│   │       │   └── health.ts
│   │       ├── workers/
│   │       │   └── temporal-worker.ts    # Temporal worker bootstrap
│   │       ├── workflows/
│   │       │   ├── certification-processing.workflow.ts
│   │       │   └── worker-onboarding.workflow.ts
│   │       ├── activities/
│   │       │   ├── fetch-document.activity.ts
│   │       │   ├── pre-classify-cert.activity.ts
│   │       │   ├── run-vision-agent.activity.ts
│   │       │   ├── validate-extraction.activity.ts
│   │       │   ├── persist-cert.activity.ts
│   │       │   └── notify-hitl.activity.ts
│   │       ├── agents/
│   │       │   └── vision-agent/
│   │       │       ├── index.ts          # LangGraph graph definition
│   │       │       ├── nodes.ts          # individual graph nodes
│   │       │       ├── state.ts          # VisionAgentState
│   │       │       └── prompts.ts        # prompt templates (loaded from Langfuse)
│   │       ├── mcp-server/
│   │       │   ├── index.ts              # MCP server entry
│   │       │   └── tools/
│   │       │       ├── get-worker-certs.ts
│   │       │       ├── get-compliance-status.ts
│   │       │       └── trigger-cert-upload.ts
│   │       ├── nats/
│   │       │   └── watcher.ts            # Ambient Watcher — subscribes to NATS
│   │       └── db/
│   │           ├── migrations/
│   │           │   └── 001_initial.sql
│   │           └── queries/
│   │               ├── certifications.ts
│   │               └── workers.ts
│   │
│   ├── platform-core/                    # @cip/platform-core — platform API + provisioning
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   ├── helm/
│   │   │   ├── Chart.yaml
│   │   │   ├── values.yaml
│   │   │   └── templates/
│   │   │       ├── deployment.yaml
│   │   │       └── service.yaml
│   │   └── src/
│   │       ├── index.ts
│   │       ├── server.ts
│   │       ├── routes/
│   │       │   ├── health.ts
│   │       │   └── tenant.ts
│   │       ├── workers/
│   │       │   └── temporal-worker.ts
│   │       ├── workflows/
│   │       │   └── tenant-provisioning.workflow.ts   # TenantProvisioningWorkflow
│   │       └── activities/
│   │           ├── create-keycloak-realm.activity.ts
│   │           ├── create-temporal-namespace.activity.ts
│   │           ├── create-nats-streams.activity.ts
│   │           ├── create-object-store-buckets.activity.ts
│   │           ├── init-tenant-database.activity.ts
│   │           ├── issue-litellm-virtual-key.activity.ts
│   │           └── provision-complete-notify.activity.ts
│   │
│   ├── teams-bot/                        # @cip/teams-bot — Microsoft Teams Bot
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── Dockerfile
│   │   ├── helm/
│   │   │   ├── Chart.yaml
│   │   │   ├── values.yaml
│   │   │   └── templates/
│   │   │       ├── deployment.yaml
│   │   │       └── service.yaml
│   │   └── src/
│   │       ├── index.ts
│   │       ├── bot.ts                    # TeamsActivityHandler
│   │       ├── agents/
│   │       │   └── intent-router/
│   │       │       ├── index.ts          # Tier 2 single LLM call — IntentResult
│   │       │       └── schema.ts         # Zod schema for IntentResult
│   │       └── handlers/
│   │           ├── cert-upload.handler.ts
│   │           ├── compliance-query.handler.ts
│   │           └── hitl-response.handler.ts
│   │
│   └── infra/                            # @cip/infra — OVH cluster management scripts
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── ovh-client.ts             # node-ovh client factory
│           ├── scale-nodepool.ts         # scale up/down with polling
│           ├── start.ts                  # morning startup script
│           └── stop.ts                   # evening shutdown script
│
├── infra/
│   ├── k8s/
│   │   ├── pvcs.yaml                     # All 5 PVCs
│   │   ├── namespaces.yaml
│   │   └── litellm-config.yaml           # LiteLLM ConfigMap with proxy_config
│   ├── helm/
│   │   ├── postgres-values.yaml
│   │   ├── nats-values.yaml
│   │   ├── keycloak-values.yaml
│   │   └── monitoring-values.yaml
│   └── terraform/
│       ├── bootstrap/
│       │   ├── providers.tf
│       │   ├── variables.tf
│       │   ├── outputs.tf
│       │   ├── kubernetes.tf
│       │   ├── storage.tf
│       │   ├── dns.tf
│       │   └── state-bucket.tf
│       └── cluster/
│           ├── providers.tf
│           ├── variables.tf
│           ├── outputs.tf
│           ├── node-pool.tf
│           └── helm.tf
│
└── scripts/
    ├── start.sh
    ├── stop.sh
    ├── bootstrap.sh
    └── create-secrets.sh
```

---

## 3. Dependencies

### 3.1 Root `package.json`

```json
{
  "name": "cip",
  "private": true,
  "scripts": {
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "lint": "eslint packages/*/src --ext .ts",
    "migrate:dev": "node infra/scripts/migrate.js"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@typescript-eslint/parser": "^7.0.0",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
    "eslint": "^8.57.0"
  }
}
```

### 3.2 `pnpm-workspace.yaml`

```yaml
packages:
  - 'packages/*'
```

### 3.3 `packages/shared/package.json`

```json
{
  "name": "@cip/shared",
  "version": "0.1.0",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": {
    "build": "tsc",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@langchain/openai": "^0.4.0",
    "@langfuse/tracing": "^5.0.0",
    "@langfuse/langchain": "^5.0.0",
    "@temporalio/client": "^1.10.0",
    "@temporalio/worker": "^1.10.0",
    "@temporalio/workflow": "^1.10.0",
    "@temporalio/activity": "^1.10.0",
    "nats": "^2.28.0",
    "pg": "^8.11.0",
    "zod": "^3.23.0",
    "jose": "^5.3.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "typescript": "^5.4.0"
  }
}
```

### 3.4 `packages/hr-service/package.json`

```json
{
  "name": "@cip/hr-service",
  "version": "0.1.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cip/shared": "workspace:*",
    "@langchain/core": "^0.3.0",
    "@langchain/langgraph": "^0.2.0",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.19.0",
    "multer": "^1.4.5-lts.1",
    "@aws-sdk/client-s3": "^3.600.0",
    "@aws-sdk/s3-request-presigner": "^3.600.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "@types/multer": "^1.4.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

### 3.5 `packages/platform-core/package.json`

```json
{
  "name": "@cip/platform-core",
  "version": "0.1.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cip/shared": "workspace:*",
    "express": "^4.19.0",
    "@ovhcloud/node-ovh": "^3.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.0",
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

### 3.6 `packages/teams-bot/package.json`

```json
{
  "name": "@cip/teams-bot",
  "version": "0.1.0",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@cip/shared": "workspace:*",
    "botbuilder": "^4.23.0",
    "@langchain/core": "^0.3.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

### 3.7 `packages/infra/package.json`

```json
{
  "name": "@cip/infra",
  "version": "0.1.0",
  "scripts": {
    "start": "tsx src/start.ts",
    "stop": "tsx src/stop.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@ovhcloud/node-ovh": "^3.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.4.0"
  }
}
```

---

## 4. Shared Types (`packages/shared/src/types/`)

Create these files with the exact types specified. These are the contracts the entire system builds on.

### 4.1 `types/tenant.ts`

```typescript
export interface TenantContext {
  tenantId: string;   // UUID — from JWT, never from request body
  userId: string;     // JWT sub claim
  systemRole: 'platform_admin' | 'tenant_admin' | 'supervisor' | 'worker';
}

export interface TenantConfig {
  tenantId: string;
  name: string;
  tier: 'standard' | 'premium' | 'enterprise';
  litellmVirtualKey: string;
  temporalNamespace: string;
  objectStoreBucket: string;
  createdAt: Date;
}
```

### 4.2 `types/agent.ts`

```typescript
import { z } from 'zod';

// Base state injected into every LangGraph agent graph
export interface AgentState {
  tenantId: string;
  userId: string;
  workflowId: string;
  activityId: string;
  model: 'cip-vision' | 'cip-chat' | 'cip-lightweight' | 'cip-reasoning';
  messages: Array<{ role: 'user' | 'assistant' | 'system'; content: string }>;
  error?: string;
}

// Vision Agent output — returned from RunVisionAgentActivity
export const ExtractionResultSchema = z.object({
  certType: z.string(),
  extractedFields: z.record(z.object({
    value: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    requiresReview: z.boolean(),
  })),
  overallConfidence: z.number().min(0).max(1),
  requiresHITL: z.boolean(),
  hitlReason: z.string().optional(),
  promptVersion: z.string(),
  modelUsed: z.string(),
  tokensUsed: z.number(),
  costUsd: z.number(),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

// Teams Bot intent router output — Tier 2 single structured LLM call
export const IntentResultSchema = z.object({
  intent: z.enum([
    'cert_upload',
    'compliance_query',
    'worker_lookup',
    'status_check',
    'escalation',
    'unknown',
  ]),
  confidence: z.number().min(0).max(1),
  entities: z.record(z.string()).optional(),
  rawMessage: z.string(),
});
export type IntentResult = z.infer<typeof IntentResultSchema>;

// Compliance Assessment Agent output
export const ComplianceResultSchema = z.object({
  workerId: z.string(),
  siteId: z.string(),
  isCompliant: z.boolean(),
  blockingGaps: z.array(z.object({
    certType: z.string(),
    reason: z.string(),
    severity: z.enum(['blocking', 'warning']),
    remediation: z.string(),
  })),
  requiresHITL: z.boolean(),
  assessedAt: z.string().datetime(),
  modelUsed: z.string(),
});
export type ComplianceResult = z.infer<typeof ComplianceResultSchema>;
```

### 4.3 `types/certification.ts`

```typescript
export type CertStatus = 'pending' | 'processing' | 'validated' | 'expired' | 'rejected' | 'hitl_review';

export interface Certification {
  id: string;
  tenantId: string;           // RLS key — on every row
  workerId: string;
  certType: string;
  status: CertStatus;
  expiresAt: Date | null;
  extractedFields: Record<string, string | null>;
  confidence: number | null;
  objectStoreKey: string;     // OVH S3 key for the source document
  createdAt: Date;
  updatedAt: Date;
}

export interface CertType {
  id: string;
  name: string;
  requiredFields: string[];
  validityPeriodDays: number;
  jurisdictions: string[];
}
```

### 4.4 `types/workflow.ts`

```typescript
// CertificationProcessingWorkflow input
export interface CertProcessingInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  objectStoreKey: string;
  uploadedBy: string;
}

// HITL signal payload — sent to resume a paused workflow
export interface HITLDecisionSignal {
  approved: boolean;
  reviewedBy: string;
  correctedFields?: Record<string, string>;
  rejectionReason?: string;
  reviewedAt: string; // ISO datetime
}

// TenantProvisioningWorkflow input
export interface TenantProvisioningInput {
  tenantId: string;
  tenantName: string;
  adminEmail: string;
  tier: 'standard' | 'premium' | 'enterprise';
  budgetLimitUsd: number;
}
```

### 4.5 `types/events.ts`

```typescript
// All NATS event payloads — tenantId always present
export interface CertificationUploadedEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  objectStoreKey: string;
  uploadedBy: string;
  uploadedAt: string;
}

export interface CertificationValidatedEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  certType: string;
  expiresAt: string;
  validatedAt: string;
}

export interface CertificationExpiredEvent {
  tenantId: string;
  workerId: string;
  certificationId: string;
  certType: string;
  expiredAt: string;
}

export interface WorkerAllocatedToSiteEvent {
  tenantId: string;
  workerId: string;
  siteId: string;
  allocationId: string;
  allocatedAt: string;
}

export interface TenantProvisionedEvent {
  tenantId: string;
  tenantName: string;
  provisionedAt: string;
}
```

---

## 5. Shared Clients (`packages/shared/src/clients/`)

### 5.1 `clients/litellm.ts`

```typescript
import { ChatOpenAI } from '@langchain/openai';

export type ModelAlias = 'cip-vision' | 'cip-chat' | 'cip-lightweight' | 'cip-reasoning';

/**
 * Returns a ChatOpenAI instance pointed at LiteLLM.
 * All agents call this — no service imports @anthropic-ai/sdk directly.
 * ANTHROPIC_API_KEY never appears outside the LiteLLM pod.
 */
export function createLiteLLMClient(alias: ModelAlias): ChatOpenAI {
  const baseURL = process.env.LITELLM_BASE_URL
    ?? 'http://litellm.cip-app.svc.cluster.local:4000';
  const apiKey = process.env.LITELLM_VIRTUAL_KEY;

  if (!apiKey) throw new Error('LITELLM_VIRTUAL_KEY not set');

  return new ChatOpenAI({
    modelName: alias,
    openAIApiKey: apiKey,
    configuration: { baseURL },
    temperature: 0,
  });
}
```

### 5.2 `clients/langfuse.ts`

```typescript
import { Langfuse } from '@langfuse/tracing';

let _instance: Langfuse | null = null;

export function getLangfuse(): Langfuse {
  if (_instance) return _instance;

  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl   = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com';

  if (!publicKey || !secretKey) {
    throw new Error('Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY');
  }

  _instance = new Langfuse({ publicKey, secretKey, baseUrl, flushAt: 10, flushInterval: 5000 });
  return _instance;
}

export async function shutdownLangfuse(): Promise<void> {
  if (_instance) {
    await _instance.shutdownAsync();
    _instance = null;
  }
}
```

### 5.3 `clients/temporal.ts`

```typescript
import { Connection, Client } from '@temporalio/client';
import { NativeConnection } from '@temporalio/worker';

function getTemporalEnv() {
  const address   = process.env.TEMPORAL_ADDRESS;
  const namespace = process.env.TEMPORAL_NAMESPACE;
  const apiKey    = process.env.TEMPORAL_API_KEY;
  if (!address || !namespace || !apiKey) {
    throw new Error('Missing TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, or TEMPORAL_API_KEY');
  }
  return { address, namespace, apiKey };
}

export async function createTemporalWorkerConnection(): Promise<NativeConnection> {
  const { address, apiKey } = getTemporalEnv();
  return NativeConnection.connect({
    address,
    tls: true,
    metadata: { authorization: `Bearer ${apiKey}` },
  });
}

export async function createTemporalClient(tenantNamespace?: string): Promise<Client> {
  const { address, namespace, apiKey } = getTemporalEnv();
  const connection = await Connection.connect({
    address,
    tls: true,
    metadata: { authorization: `Bearer ${apiKey}` },
  });
  return new Client({ connection, namespace: tenantNamespace ?? namespace });
}
```

### 5.4 `clients/nats.ts`

```typescript
import { connect, NatsConnection, StringCodec } from 'nats';

let _connection: NatsConnection | null = null;

export async function getNatsConnection(): Promise<NatsConnection> {
  if (_connection) return _connection;
  const url = process.env.NATS_URL ?? 'nats://nats.cip-infra.svc.cluster.local:4222';
  _connection = await connect({ servers: url });
  return _connection;
}

export const sc = StringCodec();
```

### 5.5 `utils/subject-builder.ts`

```typescript
/**
 * Canonical NATS subject builder.
 * ALL subject construction must go through this function.
 * Never build subject strings ad-hoc in individual services.
 *
 * Schema: cip.{tenantId}.{domain}.{eventName}
 */
export function buildSubject(
  tenantId: string,
  domain: 'hr' | 'ops' | 'platform' | 'agents',
  eventName: string,
): string {
  if (!tenantId || !domain || !eventName) {
    throw new Error('buildSubject: all parameters required');
  }
  return `cip.${tenantId}.${domain}.${eventName}`;
}

// Typed subject constants — use these, not raw strings
export const Subjects = {
  certificationUploaded: (t: string) => buildSubject(t, 'hr', 'certificationUploaded'),
  certificationValidated: (t: string) => buildSubject(t, 'hr', 'certificationValidated'),
  certificationExpired: (t: string) => buildSubject(t, 'hr', 'certificationExpired'),
  workerOnboarded: (t: string) => buildSubject(t, 'hr', 'workerOnboarded'),
  workerAllocatedToSite: (t: string) => buildSubject(t, 'ops', 'workerAllocatedToSite'),
  incidentOccurred: (t: string) => buildSubject(t, 'ops', 'incidentOccurred'),
  tenantProvisioned: (t: string) => buildSubject(t, 'platform', 'tenantProvisioned'),
} as const;
```

### 5.6 `utils/tenant-context.ts`

```typescript
import { jwtVerify, createRemoteJWKSet } from 'jose';
import type { TenantContext } from '../types/tenant.js';
import type { Request, Response, NextFunction } from 'express';

const KEYCLOAK_URL = process.env.KEYCLOAK_URL ?? 'https://keycloak.dev.cip.io';
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM ?? 'cip-dev';

const JWKS_URL = `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`;
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

/**
 * Express middleware that validates the Bearer JWT and attaches TenantContext to req.
 * tenantId is ALWAYS extracted from the JWT — never from request body or params.
 */
export async function withTenantContext(
  req: Request & { tenantContext?: TenantContext },
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer token' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const { payload } = await jwtVerify(token, JWKS);

    const tenantId   = payload['tenantId'] as string | undefined;
    const systemRole = payload['systemRole'] as string | undefined;
    const userId     = payload['sub'] as string | undefined;

    if (!tenantId) {
      res.status(401).json({ error: 'JWT missing tenantId claim — check Keycloak Protocol Mapper' });
      return;
    }

    req.tenantContext = {
      tenantId,
      userId: userId ?? '',
      systemRole: (systemRole ?? 'worker') as TenantContext['systemRole'],
    };

    next();
  } catch (err) {
    res.status(401).json({ error: 'Invalid or expired JWT' });
  }
}
```

---

## 6. Key Service Stubs

These are the most important files. Create full stubs with correct types and structure. Mark unimplemented logic with `// TODO` comments — do NOT leave out the file or the exports.

### 6.1 NATS Subject Builder — `packages/shared/src/utils/subject-builder.ts`

Already specified in Section 5.5. No additional notes.

### 6.2 CertificationProcessingWorkflow — `packages/hr-service/src/workflows/certification-processing.workflow.ts`

```typescript
import { proxyActivities, defineSignal, condition, sleep } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { CertProcessingInput, HITLDecisionSignal } from '@cip/shared/types/workflow.js';

const {
  fetchDocument,
  preClassifyCert,
  runVisionAgent,
  validateExtraction,
  persistCert,
  notifyHITL,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3, backoffCoefficient: 2 },
});

// HITL signal — the admin sends this from the Teams Bot to resume the workflow
export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision');

export async function CertificationProcessingWorkflow(
  input: CertProcessingInput,
): Promise<void> {
  // Workflow ID convention: cert-processing-{tenantId}-{certificationId}
  // This is enforced when starting the workflow via the Temporal client

  let hitlDecision: HITLDecisionSignal | null = null;

  // Register signal handler before any await points
  // (Temporal requirement — signals can arrive before the handler is registered)
  // TODO: setHandler(hitlDecisionSignal, (signal) => { hitlDecision = signal; });

  // ── Act 1: Fetch document from OVH Object Store ──
  const document = await fetchDocument({
    tenantId: input.tenantId,
    objectStoreKey: input.objectStoreKey,
  });

  // ── Act 2: Tier 1 pre-classification (no AI, fast, cheap) ──
  const preClassification = await preClassifyCert({
    tenantId: input.tenantId,
    documentMetadata: document.metadata,
  });

  // ── Act 3: Vision Agent (Tier 3 — full LangGraph graph via LiteLLM) ──
  const extraction = await runVisionAgent({
    tenantId: input.tenantId,
    workerId: input.workerId,
    certificationId: input.certificationId,
    documentBase64: document.base64,
    certType: preClassification.certType,
    workflowId: 'TODO: workflow.workflowInfo().workflowId',
  });

  // ── Act 4: Validate extraction against cert type schema ──
  const validation = await validateExtraction({
    tenantId: input.tenantId,
    extraction,
    certType: preClassification.certType,
  });

  // ── Act 5: HITL gate — pause if confidence is low ──
  if (extraction.requiresHITL) {
    await notifyHITL({
      tenantId: input.tenantId,
      workerId: input.workerId,
      certificationId: input.certificationId,
      extraction,
      workflowId: 'TODO: workflow.workflowInfo().workflowId',
    });

    // Wait up to 5 days for admin decision via Teams Bot signal
    const signalReceived = await condition(
      () => hitlDecision !== null,
      '5 days',
    );

    if (!signalReceived || hitlDecision?.approved === false) {
      // TODO: mark cert as rejected, notify worker
      return;
    }

    // Apply admin corrections to extraction before persisting
    // TODO: merge hitlDecision.correctedFields into extraction
  }

  // ── Act 6: Persist validated cert to PostgreSQL ──
  await persistCert({
    tenantId: input.tenantId,
    workerId: input.workerId,
    certificationId: input.certificationId,
    extraction,
    hitlDecision: hitlDecision ?? undefined,
  });
}
```

### 6.3 TenantProvisioningWorkflow — `packages/platform-core/src/workflows/tenant-provisioning.workflow.ts`

```typescript
import { proxyActivities } from '@temporalio/workflow';
import type * as activities from '../activities/index.js';
import type { TenantProvisioningInput } from '@cip/shared/types/workflow.js';

const {
  createKeycloakRealm,
  createTemporalNamespace,
  createNatsStreams,
  createObjectStoreBuckets,
  initTenantDatabase,
  issueLiteLLMVirtualKey,
  provisionCompleteNotify,
} = proxyActivities<typeof activities>({
  startToCloseTimeout: '10 minutes',
  retry: { maximumAttempts: 3 },
});

/**
 * TenantProvisioningWorkflow
 *
 * This is the ONLY way to onboard a new tenant. Never provision tenants manually.
 * Each activity is idempotent — safe to retry from any step.
 *
 * Workflow ID convention: tenant-provisioning-{tenantId}
 */
export async function TenantProvisioningWorkflow(
  input: TenantProvisioningInput,
): Promise<void> {
  // Step 1: Create Keycloak realm for tenant
  await createKeycloakRealm({ tenantId: input.tenantId, adminEmail: input.adminEmail });

  // Step 2: Create Temporal namespace for tenant
  await createTemporalNamespace({ tenantId: input.tenantId });

  // Step 3: Create NATS JetStream streams scoped to cip.{tenantId}.*
  await createNatsStreams({ tenantId: input.tenantId });

  // Step 4: Create OVH Object Store buckets for tenant
  await createObjectStoreBuckets({ tenantId: input.tenantId });

  // Step 5: Initialise tenant schema in PostgreSQL (run migrations)
  await initTenantDatabase({ tenantId: input.tenantId });

  // Step 6: Issue LiteLLM virtual key with tier-appropriate budget
  await issueLiteLLMVirtualKey({
    tenantId: input.tenantId,
    tier: input.tier,
    budgetLimitUsd: input.budgetLimitUsd,
  });

  // Step 7: Publish tenantProvisioned NATS event + notify admin
  await provisionCompleteNotify({ tenantId: input.tenantId, tenantName: input.tenantName });
}
```

### 6.4 Vision Agent — `packages/hr-service/src/agents/vision-agent/index.ts`

```typescript
import { StateGraph, END } from '@langchain/langgraph';
import { CallbackHandler } from '@langfuse/langchain';
import { createLiteLLMClient } from '@cip/shared/clients/litellm.js';
import { getLangfuse } from '@cip/shared/clients/langfuse.js';
import { ExtractionResultSchema } from '@cip/shared/types/agent.js';
import type { AgentState } from '@cip/shared/types/agent.js';
import { extractionNode } from './nodes.js';
import type { VisionAgentState } from './state.js';

/**
 * Vision Agent — Tier 3 LangGraph agent.
 * Invoked from RunVisionAgentActivity (Temporal Activity).
 * All LLM calls go through LiteLLM (cip-vision alias).
 * Every run is traced in Langfuse with tenantId and workflowId tagged.
 */
export async function runVisionAgent(input: {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
  activityId: string;
}): Promise<import('@cip/shared/types/agent.js').ExtractionResult> {
  const langfuse = getLangfuse();

  // Root trace — tenantId and workflowId are MANDATORY metadata
  const trace = langfuse.trace({
    name: 'vision-agent-run',
    metadata: {
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      activityId: input.activityId,
      certType: input.certType,
    },
    tags: [input.tenantId, 'vision-agent', input.certType],
  });

  const langfuseHandler = new CallbackHandler({ root: trace });
  const model = createLiteLLMClient('cip-vision');

  const initialState: VisionAgentState = {
    tenantId: input.tenantId,
    userId: '',
    workflowId: input.workflowId,
    activityId: input.activityId,
    model: 'cip-vision',
    messages: [],
    documentBase64: input.documentBase64,
    certType: input.certType,
    extractedFields: {},
    confidence: 0,
    requiresHITL: false,
  };

  // Build and compile the graph
  const graph = new StateGraph<VisionAgentState>({ channels: {} as any })
    // TODO: add nodes using addNode()
    // .addNode('extract', extractionNode(model))
    // .addEdge(START, 'extract')
    // .addEdge('extract', END)
    .compile();

  // TODO: invoke graph with langfuseHandler in callbacks
  // const result = await graph.invoke(initialState, { callbacks: [langfuseHandler] });

  // STUB — return a placeholder until nodes are implemented
  throw new Error('VisionAgent: not yet implemented — add graph nodes in nodes.ts');
}
```

### 6.5 Vision Agent State — `packages/hr-service/src/agents/vision-agent/state.ts`

```typescript
import type { AgentState } from '@cip/shared/types/agent.js';

export interface VisionAgentState extends AgentState {
  documentBase64: string;
  certType: string;
  extractedFields: Record<string, { value: string | null; confidence: number; requiresReview: boolean }>;
  confidence: number;
  requiresHITL: boolean;
  hitlReason?: string;
}
```

### 6.6 Run Vision Agent Activity — `packages/hr-service/src/activities/run-vision-agent.activity.ts`

```typescript
import { runVisionAgent } from '../agents/vision-agent/index.js';
import type { ExtractionResult } from '@cip/shared/types/agent.js';

export interface RunVisionAgentInput {
  tenantId: string;
  workerId: string;
  certificationId: string;
  documentBase64: string;
  certType: string;
  workflowId: string;
}

/**
 * Temporal Activity wrapper around the Vision Agent LangGraph graph.
 * Temporal handles retries and timeouts. The agent itself handles reasoning.
 */
export async function runVisionAgent(
  input: RunVisionAgentInput,
): Promise<ExtractionResult> {
  const { activityInfo } = await import('@temporalio/activity');
  const info = activityInfo();

  return runVisionAgent({
    ...input,
    activityId: info.activityId,
  });
}
```

### 6.7 Temporal Worker Bootstrap — `packages/hr-service/src/workers/temporal-worker.ts`

```typescript
import { Worker } from '@temporalio/worker';
import { createTemporalWorkerConnection } from '@cip/shared/clients/temporal.js';
import * as activities from '../activities/index.js';

/**
 * Starts a Temporal worker for the HR domain.
 * The worker registers against the tenant namespace from env.
 * In production, one worker pod serves multiple tenant namespaces
 * by reading them from config and creating multiple Worker instances.
 */
export async function startTemporalWorker(): Promise<void> {
  const connection = await createTemporalWorkerConnection();
  const namespace  = process.env.TEMPORAL_NAMESPACE!;
  const taskQueue  = process.env.TEMPORAL_TASK_QUEUE ?? 'cip-hr-tasks';

  const worker = await Worker.create({
    connection,
    namespace,
    taskQueue,
    workflowsPath: new URL('../workflows/index.js', import.meta.url).pathname,
    activities,
  });

  console.log(`HR Temporal worker started — namespace: ${namespace}, queue: ${taskQueue}`);
  await worker.run();
}
```

### 6.8 NATS Ambient Watcher — `packages/hr-service/src/nats/watcher.ts`

```typescript
import { getNatsConnection, sc } from '@cip/shared/clients/nats.js';
import { Subjects } from '@cip/shared/utils/subject-builder.js';
import { createTemporalClient } from '@cip/shared/clients/temporal.js';
import type { CertificationUploadedEvent, WorkerAllocatedToSiteEvent } from '@cip/shared/types/events.js';

/**
 * Ambient Watcher — two-speed design:
 *   Fast pass: Tier 1 deterministic check (threshold, expiry calc) — runs on every event
 *   Slow pass: Tier 3 agent (Compliance Assessment) — triggered only when fast pass flags
 *
 * Runs in the same process as the HR service in dev.
 * Extracted to its own container at production scale.
 */
export async function startAmbientWatcher(tenantId: string): Promise<void> {
  const nc = await getNatsConnection();

  // Subscribe to all events for this tenant
  const sub = nc.subscribe(`cip.${tenantId}.>`);

  console.log(`Ambient Watcher started for tenant: ${tenantId}`);

  for await (const msg of sub) {
    const subject = msg.subject;
    const data = JSON.parse(sc.decode(msg.data));

    if (subject.endsWith('.certificationUploaded')) {
      await handleCertUploaded(data as CertificationUploadedEvent);
    } else if (subject.endsWith('.workerAllocatedToSite')) {
      await handleWorkerAllocated(data as WorkerAllocatedToSiteEvent);
    } else if (subject.endsWith('.certificationExpired')) {
      // TODO: trigger renewal reminder workflow
    }
  }
}

async function handleCertUploaded(event: CertificationUploadedEvent): Promise<void> {
  // Fast pass: should we process this?
  const shouldProcess = true; // TODO: Tier 1 check against cert type registry

  if (shouldProcess) {
    const client = await createTemporalClient(
      `${event.tenantId}.cip`, // per-tenant Temporal namespace convention
    );

    await client.workflow.start('CertificationProcessingWorkflow', {
      taskQueue: 'cip-hr-tasks',
      workflowId: `cert-processing-${event.tenantId}-${event.certificationId}`,
      args: [{
        tenantId: event.tenantId,
        workerId: event.workerId,
        certificationId: event.certificationId,
        objectStoreKey: event.objectStoreKey,
        uploadedBy: event.uploadedBy,
      }],
    });
  }
}

async function handleWorkerAllocated(event: WorkerAllocatedToSiteEvent): Promise<void> {
  // TODO: Tier 1 fast compliance check
  // If gaps detected → trigger ComplianceAssessmentWorkflow
}
```

### 6.9 HR Service MCP Server — `packages/hr-service/src/mcp-server/index.ts`

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { withTenantContext } from '@cip/shared/utils/tenant-context.js';

/**
 * HR Domain MCP Server.
 * All tools extract tenantId from the JWT — never from tool arguments.
 * This file registers tools; tool implementations live in ./tools/
 */
const server = new McpServer({ name: 'cip-hr-domain', version: '0.1.0' });

server.tool(
  'get_worker_certifications',
  'Returns all certifications for a worker. tenantId is extracted from the auth context.',
  {
    workerId: z.string().uuid().describe('The worker UUID'),
  },
  async ({ workerId }, extra) => {
    // TODO: extract tenantId from extra.authInfo (JWT)
    // TODO: query certifications from PostgreSQL with RLS
    throw new Error('get_worker_certifications: not yet implemented');
  },
);

server.tool(
  'get_compliance_status',
  'Returns current compliance status for a worker on a specific site.',
  {
    workerId: z.string().uuid(),
    siteId: z.string().uuid(),
  },
  async ({ workerId, siteId }, extra) => {
    // TODO: implement compliance check
    throw new Error('get_compliance_status: not yet implemented');
  },
);

server.tool(
  'trigger_cert_upload',
  'Triggers the certification upload workflow for a worker.',
  {
    workerId: z.string().uuid(),
    objectStoreKey: z.string(),
  },
  async ({ workerId, objectStoreKey }, extra) => {
    // TODO: start CertificationProcessingWorkflow via Temporal client
    throw new Error('trigger_cert_upload: not yet implemented');
  },
);

export async function startMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log('HR Domain MCP Server running');
}
```

---

## 7. Database — Initial Migration

### `packages/hr-service/src/db/migrations/001_initial.sql`

```sql
-- ─────────────────────────────────────────────────────────────────────────────
-- CIP HR Domain — Initial Schema
-- All tables include tenant_id as the first column.
-- Row-Level Security is enabled on all tables.
-- tenant_id is NEVER nullable.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "vector";

-- Set the RLS context variable — call this at the start of every DB session
-- SET app.current_tenant_id = '<tenantId>';

-- ── Workers ──────────────────────────────────────────────────────────────────
CREATE TABLE workers (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id    UUID NOT NULL,
  email        TEXT NOT NULL,
  full_name    TEXT NOT NULL,
  keycloak_id  TEXT NOT NULL UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
CREATE POLICY workers_tenant_isolation ON workers
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ── Certifications ────────────────────────────────────────────────────────────
CREATE TABLE certifications (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL,
  worker_id         UUID NOT NULL REFERENCES workers(id),
  cert_type         TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','processing','validated','expired','rejected','hitl_review')),
  expires_at        TIMESTAMPTZ,
  extracted_fields  JSONB,
  confidence        NUMERIC(4,3),
  object_store_key  TEXT NOT NULL,
  prompt_version    TEXT,
  model_used        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY certifications_tenant_isolation ON certifications
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE INDEX idx_certifications_tenant_worker ON certifications(tenant_id, worker_id);
CREATE INDEX idx_certifications_expires_at ON certifications(expires_at) WHERE status = 'validated';

-- ── Outcome Store — AI calibration data ──────────────────────────────────────
CREATE TABLE agent_runs (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id         UUID NOT NULL,
  domain            TEXT NOT NULL,
  agent_type        TEXT NOT NULL,
  workflow_id       TEXT NOT NULL,
  activity_id       TEXT NOT NULL,
  prompt_version    TEXT,
  model_used        TEXT,
  memory_context_id UUID,
  input_hash        TEXT,
  ran_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at       TIMESTAMPTZ  -- NULL until ground truth arrives
);

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_runs_tenant_isolation ON agent_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE field_outcomes (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_run_id         UUID NOT NULL REFERENCES agent_runs(id),
  tenant_id            UUID NOT NULL,
  entity_type          TEXT NOT NULL,
  entity_id            UUID NOT NULL,
  field_name           TEXT NOT NULL,
  agent_value          TEXT,
  agent_confidence     NUMERIC(4,3),
  ground_truth_value   TEXT,
  ground_truth_source  TEXT CHECK (ground_truth_source IN ('human_hitl','validation_rule','downstream_outcome')),
  was_correct          BOOLEAN,
  correction_delta     TEXT,
  corrected_by         UUID,
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE field_outcomes ENABLE ROW LEVEL SECURITY;
CREATE POLICY field_outcomes_tenant_isolation ON field_outcomes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE TABLE memory_writes (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id      UUID NOT NULL,
  agent_run_id   UUID NOT NULL REFERENCES agent_runs(id),
  vector_store_id TEXT NOT NULL,
  memory_type    TEXT NOT NULL,
  scope          TEXT NOT NULL CHECK (scope IN ('provider','cert_type','worker','tenant')),
  scope_id       TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  expires_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE memory_writes ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_writes_tenant_isolation ON memory_writes
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- ── Vector Store (pgvector) ───────────────────────────────────────────────────
CREATE TABLE agent_memory_vectors (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  tenant_id   UUID NOT NULL,
  scope       TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  content     TEXT NOT NULL,
  embedding   vector(1536),  -- OpenAI/Anthropic embedding dimension
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ
);

ALTER TABLE agent_memory_vectors ENABLE ROW LEVEL SECURITY;
CREATE POLICY agent_memory_vectors_tenant_isolation ON agent_memory_vectors
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Create HNSW index from day one — prevents painful migration later
CREATE INDEX idx_agent_memory_vectors_embedding ON agent_memory_vectors
  USING hnsw (embedding vector_cosine_ops);
```

---

## 8. Kubernetes Manifests

### `infra/k8s/pvcs.yaml`

```yaml
# All 5 PVCs — create once, NEVER delete.
# OVH StorageClass: csi-cinder-high-speed-gen2 (NVMe-backed)
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: postgres-pvc
  namespace: cip-infra
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-cinder-high-speed-gen2
  resources:
    requests:
      storage: 20Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: nats-pvc
  namespace: cip-infra
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-cinder-high-speed-gen2
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: prometheus-pvc
  namespace: cip-observe
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-cinder-high-speed-gen2
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: loki-pvc
  namespace: cip-observe
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-cinder-high-speed-gen2
  resources:
    requests:
      storage: 5Gi
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: grafana-pvc
  namespace: cip-observe
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: csi-cinder-high-speed-gen2
  resources:
    requests:
      storage: 1Gi
```

### `infra/k8s/namespaces.yaml`

```yaml
---
apiVersion: v1
kind: Namespace
metadata:
  name: cip-infra
---
apiVersion: v1
kind: Namespace
metadata:
  name: cip-auth
---
apiVersion: v1
kind: Namespace
metadata:
  name: cip-observe
---
apiVersion: v1
kind: Namespace
metadata:
  name: cip-app
```

### `infra/k8s/litellm-config.yaml`

```yaml
# LiteLLM proxy config — mounted as ConfigMap on the LiteLLM pod.
# Secrets (ANTHROPIC_API_KEY, LANGFUSE_*, LITELLM_MASTER_KEY) are injected
# from the litellm-credentials K8s Secret via environmentSecrets in Helm values.
# They are referenced here using the os.environ/ prefix — never hardcoded.
apiVersion: v1
kind: ConfigMap
metadata:
  name: litellm-config
  namespace: cip-app
data:
  config.yaml: |
    model_list:
      - model_name: cip-vision
        litellm_params:
          model: anthropic/claude-sonnet-4-20250514
          api_key: os.environ/ANTHROPIC_API_KEY

      - model_name: cip-chat
        litellm_params:
          model: anthropic/claude-sonnet-4-20250514
          api_key: os.environ/ANTHROPIC_API_KEY

      - model_name: cip-lightweight
        litellm_params:
          model: anthropic/claude-haiku-4-5-20251001
          api_key: os.environ/ANTHROPIC_API_KEY

      - model_name: cip-reasoning
        litellm_params:
          model: anthropic/claude-opus-4-6
          api_key: os.environ/ANTHROPIC_API_KEY

    general_settings:
      master_key: os.environ/LITELLM_MASTER_KEY
      database_url: postgresql://cipuser:REPLACE_WITH_PASSWORD@postgres-postgresql.cip-infra:5432/cip_litellm

    litellm_settings:
      success_callback: ["langfuse"]
      failure_callback: ["langfuse"]
      langfuse_public_key: os.environ/LANGFUSE_PUBLIC_KEY
      langfuse_secret_key: os.environ/LANGFUSE_SECRET_KEY
      langfuse_host: os.environ/LANGFUSE_HOST
      drop_params: true
      max_budget: 50
      budget_duration: "30d"
```

---

## 9. Environment Variables

### `.env.example`

```bash
# ── OVH API ──────────────────────────────────────────────────────────────────
OVH_ENDPOINT=ovh-ca
OVH_APPLICATION_KEY=
OVH_APPLICATION_SECRET=
OVH_CONSUMER_KEY=
OVH_CLOUD_PROJECT_SERVICE=
OVH_CLUSTER_ID=
OVH_NODEPOOL_ID=

# ── Cluster access ────────────────────────────────────────────────────────────
KUBECONFIG=~/.kube/cip-dev.yaml

# ── LiteLLM — set on domain service pods only ─────────────────────────────────
# The Anthropic API key lives ONLY in the litellm-credentials K8s Secret.
# Domain services use the virtual key — not the real key.
LITELLM_BASE_URL=http://litellm.cip-app.svc.cluster.local:4000
LITELLM_VIRTUAL_KEY=sk-

# ── LiteLLM — set on the LiteLLM pod only (via litellm-credentials secret) ───
# ANTHROPIC_API_KEY=sk-ant-            # NEVER set this on domain service pods
# LITELLM_MASTER_KEY=sk-cip-master-   # Admin key — not for agents

# ── Langfuse (set on all pods that make LLM calls) ───────────────────────────
LANGFUSE_PUBLIC_KEY=pk-lf-
LANGFUSE_SECRET_KEY=sk-lf-
LANGFUSE_HOST=https://cloud.langfuse.com

# ── Temporal Cloud ────────────────────────────────────────────────────────────
TEMPORAL_ADDRESS=<namespace>.<account>.tmprl.cloud:7233
TEMPORAL_NAMESPACE=cip-dev-00000000-0000-0000-0000-000000000001
TEMPORAL_API_KEY=
TEMPORAL_TASK_QUEUE=cip-hr-tasks

# ── NATS ──────────────────────────────────────────────────────────────────────
NATS_URL=nats://nats.cip-infra.svc.cluster.local:4222

# ── PostgreSQL ────────────────────────────────────────────────────────────────
DATABASE_URL_HR=postgresql://cipuser:PASSWORD@postgres-postgresql.cip-infra:5432/cip_hr
DATABASE_URL_PLATFORM=postgresql://cipuser:PASSWORD@postgres-postgresql.cip-infra:5432/cip_platform

# ── Keycloak ──────────────────────────────────────────────────────────────────
KEYCLOAK_URL=https://keycloak.dev.cip.io
KEYCLOAK_REALM=cip-dev
KEYCLOAK_CLIENT_ID=platform-api

# ── OVH Object Store ──────────────────────────────────────────────────────────
AWS_ENDPOINT_URL=https://s3.bhs.io.cloud.ovh.net
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=BHS

# ── Dev tenant (fixed UUID for dev environment) ───────────────────────────────
DEV_TENANT_ID=00000000-0000-0000-0000-000000000001
```

---

## 10. Makefile

```makefile
# Makefile — CIP Platform
# Daily commands: make start | make stop | make bootstrap

.PHONY: start stop bootstrap bootstrap-infra status forward logs deploy verify typecheck build

# ── Daily cycle ──────────────────────────────────────────────────────────────

start:        ## Morning startup — scale node to 1, deploy all Helm charts
	@pnpm --filter @cip/infra tsx src/start.ts

stop:         ## Evening shutdown — destroy Helm releases, scale node to 0
	@pnpm --filter @cip/infra tsx src/stop.ts

# ── First time only ──────────────────────────────────────────────────────────

bootstrap-infra: ## One-time: provision OVH cluster, PVCs, Object Store, DNS via Terraform
	@bash scripts/bootstrap.sh

bootstrap:    ## One-time: NATS streams, Keycloak realm, DB migrations, LiteLLM virtual key
	@bash scripts/bootstrap.sh

create-secrets: ## Recreate all K8s secrets from .envrc (after cluster recreation)
	@bash scripts/create-secrets.sh

# ── Development ──────────────────────────────────────────────────────────────

status:       ## Show pod states, PVC states, node state
	@echo "--- Nodes ---"
	@kubectl get nodes 2>/dev/null || echo "No nodes (cluster stopped)"
	@echo ""
	@echo "--- PVCs (must always exist) ---"
	@kubectl get pvc -A
	@echo ""
	@echo "--- Pods ---"
	@kubectl get pods -A 2>/dev/null || echo "No pods"

forward:      ## Port-forward NATS (4222) and PostgreSQL (5432) for local dev
	@kubectl port-forward -n cip-infra svc/nats 4222:4222 &
	@kubectl port-forward -n cip-infra svc/postgres-postgresql 5432:5432 &
	@echo "Port-forwards open: NATS=4222, PostgreSQL=5432"

logs:         ## Tail logs from a service. Usage: make logs svc=hr-service
	@kubectl logs -f -n cip-app -l app=$(svc) --tail=100

deploy:       ## Build + push + rollout restart. Usage: make deploy svc=hr-service
	@docker build -t ghcr.io/YOUR_ORG/$(svc):dev ./packages/$(svc)
	@docker push ghcr.io/YOUR_ORG/$(svc):dev
	@kubectl rollout restart deployment/$(svc) -n cip-app

verify:       ## End-to-end health check
	@bash scripts/verify.sh

# ── Code quality ─────────────────────────────────────────────────────────────

typecheck:    ## Run TypeScript type checking across all packages
	@pnpm -r run typecheck

build:        ## Build all packages
	@pnpm -r run build

lint:         ## Run ESLint
	@pnpm lint
```

---

## 11. `tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "strict": true,
    "exactOptionalPropertyTypes": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  }
}
```

---

## 12. `.gitignore`

```
node_modules/
dist/
.env
.envrc
*.tfvars
*.tfvars.json
.terraform/
.terraform.lock.hcl
terraform.tfstate
terraform.tfstate.backup
.ingress-ip
~/.kube/cip-dev.yaml
*.pem
*.key
```

---

## 13. Constraints Claude Code Must Enforce

These are hard rules. If any file would violate them, stop and flag it rather than proceeding.

1. **No direct Anthropic SDK import anywhere outside of `infra/k8s/litellm-config.yaml` comments.** Every LLM call uses `createLiteLLMClient()` from `@cip/shared/clients/litellm.ts`.

2. **`tenantId` must be present on every database table row, every NATS event payload, every agent state object, and every Temporal workflow ID.** If a type or table is missing it, add it.

3. **Never construct NATS subjects as raw strings.** Always use `buildSubject()` or the `Subjects` map from `subject-builder.ts`.

4. **Every Temporal workflow ID must follow the pattern `{workflowType}-{tenantId}-{entityId}`.** Enforce this as a comment at every call site.

5. **Every agent output must be validated with Zod before being returned from the Temporal Activity.** Never return untyped or unvalidated data from an Activity.

6. **`tenantId` in MCP tools is always extracted from the JWT.** Never accept it as a tool argument.

7. **TypeScript strict mode is on.** `noImplicitAny`, `strictNullChecks`. Every `TODO` stub must still be type-correct — use `throw new Error('not implemented')` not `return undefined as any`.

---

## 14. What to Build First (Suggested Order for Claude Code)

Claude Code should scaffold in this order to ensure the shared foundation compiles before domain packages depend on it:

1. Root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.gitignore`, `.env.example`
2. `packages/shared/` — all types, all clients, all utils. This must typecheck before anything else.
3. `infra/k8s/` — all YAML manifests. No compilation needed.
4. `infra/terraform/` — Terraform HCL stubs (providers.tf, variables.tf, empty resource files with comments)
5. `packages/hr-service/` — workflows, activities, agent stubs, MCP server, NATS watcher, Dockerfile, Helm chart
6. `packages/platform-core/` — TenantProvisioningWorkflow and all its activity stubs, Dockerfile, Helm chart
7. `packages/teams-bot/` — bot stub, intent router agent stub, handlers, Dockerfile, Helm chart
8. `packages/infra/` — OVH client, scale-nodepool, start.ts, stop.ts
9. `Makefile`, `scripts/*.sh`
10. Run `pnpm install` and `pnpm typecheck` — fix any type errors before finishing

---

*End of spec. Every section is required. Do not omit files.*

# Slice 04 — Infrastructure YAML

> **Prerequisite:** Slice 03 complete.  
> **Session size:** Small — YAML only, no TypeScript.  
> **Verify with:** `kubectl apply --dry-run=client -f infra/k8s/` (if cluster is running)

---

## What You Are Building

```
infra/
├── k8s/
│   ├── namespaces.yaml        ← cip-infra, cip-app
│   ├── pvcs.yaml              ← 5 PVCs: postgres, nats, keycloak, langfuse, litellm-logs
│   └── litellm-config.yaml    ← LiteLLM ConfigMap with proxy_config.yaml
└── helm/
    ├── postgres-values.yaml
    ├── nats-values.yaml
    ├── keycloak-values.yaml
    └── monitoring-values.yaml
```

Terraform stubs go in `infra/terraform/` — providers, variables, and empty resource files with comments describing what each will provision.

---

## PVC Inventory

| PVC Name | Size | StorageClass | Used By |
|----------|------|-------------|---------|
| `postgres-data` | 20Gi | standard | PostgreSQL |
| `nats-data` | 5Gi | standard | NATS JetStream |
| `keycloak-data` | 2Gi | standard | Keycloak |
| `langfuse-data` | 10Gi | standard | Langfuse |
| `litellm-logs` | 5Gi | standard | LiteLLM request logs |

**Critical:** PVCs are in namespace `cip-infra`. They must **not** be deleted when the cluster scales to zero — they persist across node pool scale events. The stop script only deletes Helm releases, not PVCs.

---

## LiteLLM ConfigMap — Key Points

The `proxy_config.yaml` embedded in the ConfigMap must:
- Define a model alias `claude-vision` pointing to `anthropic/claude-3-5-sonnet-20241022`
- Enable `langfuse` as the success callback with env var references
- Set `litellm_settings.drop_params: true` (prevents unknown param errors)
- Reference `ANTHROPIC_API_KEY` from the `litellm-credentials` Secret — never hardcoded

---

## Acceptance Criteria

- [ ] Two namespaces: `cip-infra` and `cip-app`
- [ ] All 5 PVCs defined with correct sizes and namespace (`cip-infra`)
- [ ] LiteLLM ConfigMap has `claude-vision` model alias
- [ ] No actual secrets in any YAML file — all sensitive values reference K8s Secret names
- [ ] Terraform files are valid HCL stubs (can be planned without errors if variables are supplied)

---
---

# Slice 05 — HR Service: Database Layer

> **Prerequisite:** Slice 03 complete (`@cip/shared` compiles).  
> **Session size:** Small — SQL migration + 2 TypeScript query files.  
> **Verify with:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/db/
├── migrations/
│   └── 001_initial.sql     ← schema + RLS policies
└── queries/
    ├── certifications.ts   ← typed query functions
    └── workers.ts          ← typed query functions
```

---

## Schema Design

### `001_initial.sql`

```sql
-- Enable RLS
ALTER DATABASE cip_hr SET row_security = on;

CREATE TABLE workers (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,              -- REQUIRED: RLS key
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE certifications (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,         -- REQUIRED: RLS key
  worker_id        UUID NOT NULL REFERENCES workers(id),
  cert_type        TEXT NOT NULL,
  issuing_body     TEXT NOT NULL,
  issue_date       DATE NOT NULL,
  expiry_date      DATE NOT NULL,
  document_url     TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending',
  confidence_score NUMERIC(4,3),
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- RLS Policies
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;
ALTER TABLE certifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON workers
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

CREATE POLICY tenant_isolation ON certifications
  USING (tenant_id = current_setting('app.current_tenant_id')::UUID);

-- Indexes
CREATE INDEX idx_certifications_tenant_worker ON certifications(tenant_id, worker_id);
CREATE INDEX idx_certifications_expiry ON certifications(tenant_id, expiry_date)
  WHERE status = 'valid';
```

### Query Files — Pattern to Follow

```typescript
// certifications.ts
import { PoolClient } from 'pg'
import { Certification } from '@cip/shared'

// All functions take PoolClient (not Pool) — caller manages the withTenantRLS wrapper
export async function findCertificationById(
  client: PoolClient,
  id: string
): Promise<Certification | null> {
  const result = await client.query(
    'SELECT * FROM certifications WHERE id = $1',
    [id]
  )
  return result.rows[0] ?? null
}

export async function upsertCertification(
  client: PoolClient,
  cert: Omit<Certification, 'createdAt' | 'updatedAt'>
): Promise<Certification> {
  // INSERT ... ON CONFLICT DO UPDATE
  throw new Error('not implemented')
}

export async function findExpiredCertifications(
  client: PoolClient,
  beforeDate: string
): Promise<Certification[]> {
  throw new Error('not implemented')
}
```

---

## Acceptance Criteria

- [ ] `tenant_id` column present on every table — not optional, not nullable
- [ ] RLS policies reference `current_setting('app.current_tenant_id')::UUID`
- [ ] Query functions take `PoolClient`, not `Pool` (caller manages transaction/RLS)
- [ ] Return types match the `Certification` and `Worker` interfaces from `@cip/shared`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

---
---

# Slice 06 — HR Service: Temporal Workflows & Activities

> **Prerequisite:** Slices 03 and 05 complete.  
> **Session size:** Large — 2 workflows, 6 activities, 1 worker bootstrap.  
> **Verify with:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/
├── workers/
│   └── temporal-worker.ts         ← registers all workflows + activities
├── workflows/
│   ├── certification-processing.workflow.ts
│   └── worker-onboarding.workflow.ts
└── activities/
    ├── fetch-document.activity.ts
    ├── pre-classify-cert.activity.ts
    ├── run-vision-agent.activity.ts
    ├── validate-extraction.activity.ts
    ├── persist-cert.activity.ts
    └── notify-hitl.activity.ts
```

---

## Workflow ID Pattern (enforced at every call site)

```typescript
// CertificationProcessingWorkflow — ID pattern enforced here
const workflowId = `CertProcess-${input.tenantId}-${input.certId}`
//                  ^^^^^^^^^^^  ^^^^^^^^^^^^^^^^  ^^^^^^^^^^^
//                  workflowType  tenantId          entityId
```

This is a non-negotiable. Add a comment at every `client.workflow.start()` call site:
```typescript
// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
```

---

## `CertificationProcessingWorkflow` — Execution Order

```
1. fetchDocument(input.documentUrl)           → documentBase64: string
2. preClassifyCert(documentBase64)            → certType: string
3. runVisionAgent({ tenantId, documentBase64, certType })  → ExtractionResult
4. if extraction.confidence < 0.85:
       signal HITL → wait for HitlResolutionSignal
5. validateExtraction(extraction)             → ValidatedExtractionResult (Zod)
6. persistCert(tenantId, certId, extraction)  → Certification
7. notifyHitl (only if step 4 was triggered)
```

All activity calls must include retry policies. Use conservative defaults:
```typescript
{ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } }
```

---

## Activity Contracts

### `run-vision-agent.activity.ts`
This Activity invokes the LangGraph vision agent. It must:
1. Call `runVisionAgent()` from `../agents/vision-agent/index.js`
2. Zod-validate the result with `ExtractionResultSchema` before returning
3. Never return unvalidated data

```typescript
import { ExtractionResultSchema } from '@cip/shared'

export async function runVisionAgentActivity(
  input: RunVisionAgentInput
): Promise<ExtractionResult> {
  const rawResult = await runVisionAgent(input)
  // REQUIRED: validate before returning from Activity
  return ExtractionResultSchema.parse(rawResult)
}
```

### `notify-hitl.activity.ts`
Sends a Temporal Signal back to the workflow and posts a Teams Adaptive Card. For now: stub that logs and returns.

---

## HITL Temporal Signal Pattern

```typescript
// In the workflow definition:
import { defineSignal, setHandler } from '@temporalio/workflow'

export const hitlResolutionSignal = defineSignal<[HitlResolution]>('hitlResolution')

// Inside the workflow:
let hitlResolution: HitlResolution | undefined
setHandler(hitlResolutionSignal, (resolution) => {
  hitlResolution = resolution
})
await condition(() => hitlResolution !== undefined, '7 days')
```

---

## Acceptance Criteria

- [ ] Every workflow ID follows `{workflowType}-{tenantId}-{entityId}` with comment
- [ ] `runVisionAgentActivity` validates output with `ExtractionResultSchema.parse()`
- [ ] HITL signal is defined with `defineSignal` — not a polling loop
- [ ] Temporal worker registers every workflow and activity
- [ ] All stubs throw `new Error('not implemented')` — no `return undefined as any`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

---
---

# Slice 07 — HR Service: Vision Agent (LangGraph)

> **Prerequisite:** Slice 06 complete.  
> **Session size:** Medium — 4 files, the most conceptually complex slice.  
> **Verify with:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/agents/vision-agent/
├── index.ts     ← LangGraph graph definition; exports runVisionAgent()
├── nodes.ts     ← individual graph node functions
├── state.ts     ← VisionAgentState channel definition
└── prompts.ts   ← prompt templates
```

---

## LangGraph Graph Shape

```
START
  │
  ▼
[extractFields]    ← Claude vision call via LiteLLM; populates extraction
  │
  ▼
[assessConfidence] ← checks extraction.confidence; sets requiresHitl flag
  │
  ├── confidence >= 0.85 ──▶ [formatOutput] ──▶ END
  │
  └── confidence < 0.85  ──▶ [flagForHitl]  ──▶ END
```

---

## State Channel Definition

```typescript
// state.ts
import { VisionAgentState } from '@cip/shared'
import { Annotation } from '@langchain/langgraph'

export const VisionAgentAnnotation = Annotation.Root({
  tenantId: Annotation<string>(),           // REQUIRED
  certId: Annotation<string>(),
  documentUrl: Annotation<string>(),
  documentBase64: Annotation<string | undefined>(),
  extraction: Annotation<ExtractionResult | undefined>(),
  requiresHitl: Annotation<boolean>({ default: () => false }),
  runId: Annotation<string>(),
  startedAt: Annotation<string>(),
  error: Annotation<string | undefined>(),
})
```

---

## `extractFields` Node — LiteLLM Call Pattern

```typescript
// nodes.ts
export async function extractFields(
  state: typeof VisionAgentAnnotation.State
): Promise<Partial<typeof VisionAgentAnnotation.State>> {
  const client = createLiteLLMClient({
    tenantId: state.tenantId,
    virtualKey: state.tenantConfig.litellmVirtualKey,
  })

  const response = await client.chat.completions.create({
    model: 'claude-vision',         // alias defined in LiteLLM ConfigMap
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${state.documentBase64}` }
          },
          { type: 'text', text: 'Extract all certification fields from this document.' }
        ]
      }
    ],
    max_tokens: 1000,
  })

  // Parse response into ExtractionResult — throw if malformed
  const extracted = parseExtractionResponse(response)
  return { extraction: extracted }
}
```

---

## Prompts

`prompts.ts` exports named prompt strings. In production these will be loaded from Langfuse prompt management. For now, hardcode them as constants with a TODO comment:

```typescript
// TODO: Load from Langfuse prompt management in production
export const EXTRACTION_PROMPT = `
You are a construction certification document parser.
Extract the following fields from the provided document image...
`
```

---

## Acceptance Criteria

- [ ] `runVisionAgent()` is the single exported function from `index.ts`
- [ ] State includes `tenantId: string` (not optional)
- [ ] LiteLLM client created with `createLiteLLMClient()` — never `new OpenAI()`
- [ ] Model name is the LiteLLM alias `claude-vision`, not a raw Anthropic model string
- [ ] Graph has at least 3 nodes: extract, assess, format/flag
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

---
---

# Slice 08 — HR Service: NATS Watcher

> **Prerequisite:** Slice 06 complete.  
> **Session size:** Small — 1 file.  
> **Verify with:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/nats/
└── watcher.ts    ← Ambient Watcher — subscribes to NATS events
```

---

## Ambient Watcher Responsibilities

The watcher runs as a long-lived process alongside the Temporal worker. It subscribes to NATS JetStream and reacts to events:

| Event | Subject (built via Subjects.*) | Action |
|-------|-------------------------------|--------|
| cert.processed | `cip.*.cert.processed.v1` | Check if cert is near expiry; schedule reminder |
| cert.expired | `cip.*.cert.expired.v1` | Trigger compliance drift check |
| worker.onboarded | `cip.*.worker.onboarded.v1` | Check initial cert requirements |

The `*` wildcard covers all tenant subjects — the watcher filters by `tenantId` in the event payload, not the subject. This is intentional: one watcher instance handles all tenants.

---

## Watcher Pattern

```typescript
import { createNatsClient } from '@cip/shared'
import { Subjects } from '@cip/shared/utils/subject-builder.js'

export async function startAmbientWatcher(): Promise<void> {
  const nc = await createNatsClient()
  const js = nc.jetstream()

  // Subscribe to all cert processed events across all tenants
  const sub = js.subscribe('cip.*.cert.processed.v1', { /* consumer opts */ })

  for await (const msg of sub) {
    const event = JSON.parse(msg.string()) // typed as CertProcessedEvent
    // tenantId is on the event payload — always verified here
    await handleCertProcessed(event)
    msg.ack()
  }
}
```

---

## Acceptance Criteria

- [ ] No raw NATS subject strings — uses `Subjects.*` helpers or `buildSubject()`
- [ ] Event payloads are typed (cast from JSON, not `any`)
- [ ] Each handler acks the message after processing
- [ ] `startAmbientWatcher()` is called from `packages/hr-service/src/index.ts`

---
---

# Slice 09 — HR Service: MCP Server

> **Prerequisite:** Slice 05 (DB layer) complete.  
> **Session size:** Small-medium — 1 server entry + 3 tool files.  
> **Verify with:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/mcp-server/
├── index.ts                    ← MCP server setup and tool registration
└── tools/
    ├── get-worker-certs.ts
    ├── get-compliance-status.ts
    └── trigger-cert-upload.ts
```

---

## Critical MCP Rule: `tenantId` Source

**`tenantId` must ALWAYS come from the JWT. Never from tool arguments.**

```typescript
// WRONG — never do this
const tool = server.tool('get_worker_certs', {
  workerId: z.string(),
  tenantId: z.string(),     // ← FORBIDDEN: tenantId as argument
}, async ({ workerId, tenantId }) => { ... })

// CORRECT
const tool = server.tool('get_worker_certs', {
  workerId: z.string(),
  // tenantId is not in the schema
}, async ({ workerId }, { authInfo }) => {
  const tenantId = extractTenantIdFromJWT(authInfo.token)  // ← from JWT
  ...
})
```

---

## Tool Contracts

### `get-worker-certs`
- Input: `{ workerId: string }`
- tenantId: from JWT
- Output: array of `Certification` (filtered by RLS via `withTenantRLS`)

### `get-compliance-status`
- Input: `{ workerId: string }`
- tenantId: from JWT
- Output: `{ compliant: boolean, missing: string[], expired: string[] }`

### `trigger-cert-upload`
- Input: `{ workerId: string, documentUrl: string, certType: string }`
- tenantId: from JWT
- Output: `{ certId: string, workflowId: string }`
- Side effect: publishes `CertUploadedEvent` to NATS via `Subjects.certUploaded(tenantId)`

---

## Acceptance Criteria

- [ ] `tenantId` is **absent** from all MCP tool input schemas
- [ ] `tenantId` is extracted from JWT auth context in every tool handler
- [ ] `get-worker-certs` uses `withTenantRLS` wrapper before querying
- [ ] `trigger-cert-upload` publishes NATS event via `Subjects.certUploaded()`
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

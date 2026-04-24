# Slice 10 — Platform Core

> **Prerequisite:** Slices 01–03 complete.  
> **Session size:** Medium — 1 workflow, 7 activities, Express server, Temporal worker.  
> **Verify with:** `pnpm --filter @cip/platform-core typecheck`

---

## What You Are Building

```
packages/platform-core/src/
├── index.ts
├── server.ts
├── routes/
│   ├── health.ts
│   └── tenant.ts                         ← POST /tenants → triggers TenantProvisioningWorkflow
├── workers/
│   └── temporal-worker.ts
├── workflows/
│   └── tenant-provisioning.workflow.ts
└── activities/
    ├── create-keycloak-realm.activity.ts
    ├── create-temporal-namespace.activity.ts
    ├── create-nats-streams.activity.ts
    ├── create-object-store-buckets.activity.ts
    ├── init-tenant-database.activity.ts
    ├── issue-litellm-virtual-key.activity.ts
    └── provision-complete-notify.activity.ts
```

---

## `TenantProvisioningWorkflow` — Execution Order

This workflow must be **idempotent**. Every activity checks if the resource already exists before creating it.

```
1. createKeycloakRealm(tenantId, tenantName)
2. createTemporalNamespace(tenantId)
3. createNatsStreams(tenantId)
4. createObjectStoreBuckets(tenantId)
5. initTenantDatabase(tenantId)
6. issueLiteLLMVirtualKey(tenantId) → litellmVirtualKey: string
7. provisionCompleteNotify(tenantId, adminEmail, litellmVirtualKey)
```

Workflow ID: `TenantProvision-${input.tenantId}-${input.tenantId}`
(entityId = tenantId here because the tenant is both the scope and the entity)

---

## Tenant Route

```typescript
// POST /tenants
// Body: { tenantName: string, adminEmail: string }
// Auth: master admin JWT (Keycloak cip-master realm)

router.post('/tenants', async (req, res) => {
  const tenantId = randomUUID()
  const client = await createTemporalClient()
  const handle = await client.workflow.start(tenantProvisioningWorkflow, {
    // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
    workflowId: `TenantProvision-${tenantId}-${tenantId}`,
    taskQueue: process.env['TEMPORAL_TASK_QUEUE'] ?? 'cip-platform-tasks',
    args: [{ tenantId, tenantName: req.body.tenantName, adminEmail: req.body.adminEmail }],
  })
  res.status(202).json({ tenantId, workflowId: handle.workflowId })
})
```

---

## Acceptance Criteria

- [ ] `TenantProvisioningWorkflow` runs activities in correct order
- [ ] Workflow ID follows `{workflowType}-{tenantId}-{entityId}` pattern
- [ ] All 7 activities are stubs that throw `new Error('not implemented')`
- [ ] `initTenantDatabase` activity sets up RLS policy for the new tenant
- [ ] `issueLiteLLMVirtualKey` activity returns the key as its output (to be stored in tenant config)
- [ ] `pnpm --filter @cip/platform-core typecheck` passes

---
---

# Slice 11 — Teams Bot

> **Prerequisite:** Slices 01–03 complete.  
> **Session size:** Medium — bot adapter, intent router agent, 3 handlers.  
> **Verify with:** `pnpm --filter @cip/teams-bot typecheck`

---

## What You Are Building

```
packages/teams-bot/src/
├── index.ts
├── bot.ts                        ← TeamsActivityHandler (Bot Framework)
├── agents/
│   └── intent-router/
│       ├── index.ts              ← single LLM call → IntentResult
│       └── schema.ts             ← Zod schema (mirrors @cip/shared IntentResultSchema)
└── handlers/
    ├── cert-upload.handler.ts
    ├── compliance-query.handler.ts
    └── hitl-response.handler.ts
```

---

## Intent Router — Tier 2 Single LLM Call

The intent router is **not** a LangGraph agent. It is a single LLM call that classifies incoming Teams messages into one of 4 intents. Keep it simple.

```typescript
// index.ts
export async function routeIntent(
  message: string,
  ctx: TenantContext
): Promise<IntentResult> {
  const client = createLiteLLMClient({
    tenantId: ctx.tenantId,
    virtualKey: ctx.tenantConfig.litellmVirtualKey,
  })

  const response = await client.chat.completions.create({
    model: 'claude-sonnet',     // LiteLLM alias for the text model
    messages: [
      { role: 'system', content: INTENT_ROUTER_PROMPT },
      { role: 'user', content: message }
    ],
    max_tokens: 200,
    response_format: { type: 'json_object' },
  })

  const raw = JSON.parse(response.choices[0]?.message.content ?? '{}')
  // Zod validate before returning — same pattern as Activities
  return IntentResultSchema.parse({ ...raw, tenantId: ctx.tenantId })
}
```

---

## Handler Dispatch

```typescript
// bot.ts
class CIPTeamsBot extends TeamsActivityHandler {
  async onMessage(context: TurnContext, next: () => Promise<void>) {
    const tenantCtx = extractTenantContextFromTeams(context)
    const intent = await routeIntent(context.activity.text, tenantCtx)

    switch (intent.intent) {
      case 'UPLOAD_CERT':       return certUploadHandler(context, tenantCtx, intent)
      case 'QUERY_COMPLIANCE':  return complianceQueryHandler(context, tenantCtx, intent)
      case 'RESPOND_HITL':      return hitlResponseHandler(context, tenantCtx, intent)
      default:
        await context.sendActivity('I didn\'t understand that. Try uploading a certification document.')
    }
    await next()
  }
}
```

---

## HITL Response Handler — Temporal Signal

```typescript
// hitl-response.handler.ts
export async function hitlResponseHandler(
  context: TurnContext,
  tenantCtx: TenantContext,
  intent: IntentResult
): Promise<void> {
  const workflowId = intent.entities['workflowId']
  const approved = intent.entities['decision'] === 'approve'

  const temporalClient = await createTemporalClient()
  const handle = temporalClient.workflow.getHandle(workflowId)

  await handle.signal(hitlResolutionSignal, {
    reviewedBy: tenantCtx.userId,
    resolvedAt: new Date().toISOString(),
    approved,
  })
}
```

---

## Acceptance Criteria

- [ ] `IntentResultSchema.parse()` is called on every intent router output
- [ ] `tenantId` on `IntentResult` comes from `TenantContext` — not from the LLM response
- [ ] HITL handler sends a Temporal Signal (not an Activity trigger)
- [ ] `cert-upload.handler.ts` publishes a NATS event via `Subjects.certUploaded()`
- [ ] Model name is a LiteLLM alias (`claude-sonnet`), not a raw model string
- [ ] `pnpm --filter @cip/teams-bot typecheck` passes

---
---

# Slice 12 — Infra Scripts

> **Prerequisite:** Slice 01 complete (workspace root exists).  
> **Session size:** Small — 4 TypeScript files.  
> **Verify with:** `pnpm --filter @cip/infra typecheck`

---

## What You Are Building

```
packages/infra/src/
├── ovh-client.ts        ← node-ovh authenticated client factory
├── scale-nodepool.ts    ← scale OVH node pool with polling until ready
├── start.ts             ← morning startup: scale to 1, deploy Helm releases
└── stop.ts              ← evening shutdown: destroy Helm releases, scale to 0
```

---

## OVH Node Pool Scale Pattern

```typescript
// scale-nodepool.ts
export async function scaleNodepool(
  client: OvhClient,
  targetSize: number
): Promise<void> {
  await client.requestPromised('PUT', `/cloud/project/${PROJECT_ID}/kube/${CLUSTER_ID}/nodepool/${POOL_ID}`, {
    desiredNodes: targetSize,
    minNodes: 0,
    maxNodes: 1,
  })

  // Poll until node pool reaches target state
  while (true) {
    const pool = await client.requestPromised('GET', `/cloud/project/${PROJECT_ID}/kube/${CLUSTER_ID}/nodepool/${POOL_ID}`)
    if (pool.status === 'READY') break
    await sleep(15_000)
  }
}
```

---

## `start.ts` — Morning Startup Sequence

```
1. Scale node pool to 1 (wait for READY)
2. helm upgrade --install postgres ...
3. helm upgrade --install nats ...
4. helm upgrade --install keycloak ...
5. helm upgrade --install litellm ...
6. helm upgrade --install langfuse ...
7. helm upgrade --install hr-service ...
8. helm upgrade --install platform-core ...
9. helm upgrade --install teams-bot ...
```

Helm commands are run via `child_process.execSync` or a typed wrapper. Log each step.

---

## `stop.ts` — Evening Shutdown Sequence

```
1. helm uninstall teams-bot (--namespace cip-app)
2. helm uninstall platform-core
3. helm uninstall hr-service
4. helm uninstall litellm
5. helm uninstall langfuse
6. helm uninstall keycloak
7. helm uninstall nats
8. helm uninstall postgres
9. Scale node pool to 0 (wait for READY)
```

**DO NOT delete PVCs.** Deleting a PVC will destroy all data. The stop script must only uninstall Helm releases.

---

## Acceptance Criteria

- [ ] `scaleNodepool()` polls until `status === 'READY'`, with timeout
- [ ] `stop.ts` never calls `kubectl delete pvc` or any equivalent
- [ ] Helm release names and namespaces match what's in the Helm charts
- [ ] `pnpm --filter @cip/infra typecheck` passes

---
---

# Slice 13 — Makefile & Shell Scripts

> **Prerequisite:** Slices 01–12 complete.  
> **Session size:** Small — shell scripts and Makefile targets.  
> **Verify with:** `bash -n scripts/*.sh` (syntax check only)

---

## What You Are Building

```
cip/
├── Makefile
└── scripts/
    ├── bootstrap.sh         ← one-time: NATS streams, Keycloak realm, DB migrations, LiteLLM key
    ├── create-secrets.sh    ← recreate K8s secrets from .envrc
    └── verify.sh            ← end-to-end health check
```

---

## `bootstrap.sh` — Run Once After First Deploy

```bash
#!/usr/bin/env bash
set -euo pipefail

echo "▶ Creating NATS streams..."
# kubectl exec into NATS pod and create streams via nats CLI

echo "▶ Running DB migrations..."
# kubectl exec into a migration job or pg client pod

echo "▶ Creating LiteLLM virtual key for dev tenant..."
# curl to LiteLLM proxy admin endpoint

echo "▶ Bootstrap complete."
```

---

## `create-secrets.sh` — After Cluster Recreation

```bash
#!/usr/bin/env bash
set -euo pipefail

source .envrc  # loads all env vars

kubectl create secret generic litellm-credentials \
  --from-literal=ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY}" \
  --from-literal=LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY}" \
  -n cip-app --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic cip-app-secrets \
  --from-literal=DATABASE_URL_HR="${DATABASE_URL_HR}" \
  --from-literal=NATS_URL="${NATS_URL}" \
  # ... etc
  -n cip-app --dry-run=client -o yaml | kubectl apply -f -
```

The `--dry-run=client -o yaml | kubectl apply` pattern is idempotent — safe to re-run.

---

## Acceptance Criteria

- [ ] `bash -n scripts/bootstrap.sh` passes (no syntax errors)
- [ ] `create-secrets.sh` uses `--dry-run=client -o yaml | kubectl apply` (idempotent)
- [ ] `verify.sh` checks at least: pod readiness, NATS connectivity, DB connectivity
- [ ] Makefile targets delegate to the correct scripts/commands (no logic in the Makefile itself)
- [ ] `make help` (or `make` with no args) prints a usage summary via `## comments`

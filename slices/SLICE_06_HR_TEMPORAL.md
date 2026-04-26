# Slice 06 — HR Temporal Workflows

> **Prerequisite:** Slices 02, 05A, 05B complete.
> **Package:** `@cip/hr-service`
> **Verify:** `pnpm --filter @cip/hr-service typecheck`

---

## What You Are Building

```
packages/hr-service/src/
  workers/
    temporal-worker.ts                         ← registers all workflows + activities
  modules/
    certifications/
      workflows/
        certification-processing.workflow.ts
      activities/
        fetch-document.activity.ts
        pre-classify-cert.activity.ts
        run-vision-agent.activity.ts
        validate-extraction.activity.ts
        persist-cert.activity.ts
        notify-hitl.activity.ts
```

Employee onboarding workflow and its activities are in Slice 15.

---

## `CertificationProcessingWorkflow` — Execution Order

```
1. fetchDocument(objectStoreKey)
      → documentBase64: string

2. preClassifyCert(documentBase64)
      → certTypeHint: string

3. runVisionAgent({ tenantId, submissionId, employeeId, documentBase64, certTypeHint })
      → ExtractionResult (Zod-validated before returning from activity)

4. [PARALLEL] matchEmployee(tenantId, submissionId, extraction)
             matchCertDefinition(tenantId, submissionId, extraction)
      → { employeeId, confidence, method }
      → { certDefId, confidence, method }
      (activities from Slice 14 — stubs that throw 'not implemented' here)

5. if extraction.confidence < 0.85 OR either match.confidence < 0.7:
     notifyHitl(tenantId, submissionId, hitlReasonCode: HitlReasonCode)
     wait for HITLDecisionSignal (up to 7 days)
     // HitlReasonCode imported from registries.ts in @cip/hr-service

6. persistCert(tenantId, submissionId, extraction, matchedEmployeeId, certDefId)
      → certificationId: string

7. publish CertProcessedEvent → NATS
```

---

## Workflow ID Pattern

```typescript
// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
workflowId: `CertProcess-${input.tenantId}-${input.submissionId}`
```

---

## Key Code Patterns

### Parallel matching (step 4)

```typescript
import { proxyActivities } from '@temporalio/workflow'

const { matchEmployee, matchCertDefinition } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3 },
})

const [employeeMatch, certMatch] = await Promise.all([
  matchEmployee({ tenantId, submissionId, extraction }),
  matchCertDefinition({ tenantId, submissionId, extraction }),
])
```

### HITL Signal

```typescript
import { defineSignal, setHandler, condition } from '@temporalio/workflow'
import type { HITLDecisionSignal } from '@cip/shared'

export const hitlDecisionSignal = defineSignal<[HITLDecisionSignal]>('hitlDecision')

// Inside workflow:
let hitlDecision: HITLDecisionSignal | undefined
setHandler(hitlDecisionSignal, (decision) => { hitlDecision = decision })
if (needsHitl) {
  await condition(() => hitlDecision !== undefined, '7 days')
}
```

### Activity contract — Zod validation required

```typescript
// run-vision-agent.activity.ts
import { ExtractionResultSchema } from '@cip/shared'

export async function runVisionAgentActivity(
  input: RunVisionAgentInput
): Promise<ExtractionResult> {
  const raw = await runVisionAgent(input)
  return ExtractionResultSchema.parse(raw)   // REQUIRED — never skip
}
```

### Stubs

Activities for Slice 14 (`matchEmployee`, `matchCertDefinition`) must be registered but throw `new Error('not implemented')` until Slice 14 is complete.

---

## Temporal Worker Registration

```typescript
// temporal-worker.ts
import { Worker } from '@temporalio/worker'
import * as certActivities from '../modules/certifications/activities/index.js'

export async function startWorker() {
  const worker = await Worker.create({
    workflowsPath: new URL('../modules/certifications/workflows/index.js', import.meta.url).pathname,
    activities: { ...certActivities },
    taskQueue: process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks',
  })
  await worker.run()
}
```

---

## Activity Retry Policies

All activities use:
```typescript
{ startToCloseTimeout: '30 seconds', retry: { maximumAttempts: 3 } }
```

`notifyHitl` uses `{ startToCloseTimeout: '10 seconds', retry: { maximumAttempts: 5 } }` — notification delivery should retry more.

---

## Acceptance Criteria

- [ ] Workflow ID follows `{workflowType}-{tenantId}-{entityId}` with comment on preceding line
- [ ] `matchEmployee` and `matchCertDefinition` run with `Promise.all` (parallel)
- [ ] `runVisionAgentActivity` calls `ExtractionResultSchema.parse()` before returning
- [ ] HITL signal uses `defineSignal` + `condition()` — not a polling loop
- [ ] All unimplemented stubs throw `new Error('not implemented')`
- [ ] Temporal worker registers every workflow and activity
- [ ] Task queue read from `process.env['TEMPORAL_TASK_QUEUE_HR']` — never hardcoded
- [ ] `pnpm --filter @cip/hr-service typecheck` passes

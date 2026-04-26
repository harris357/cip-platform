# CIP Platform — Session Prompts

> **How to use this file:**
> - **Slice 00-A (Orientation):** Paste into a standard Claude chat session, not Claude Code. It is a conversation, not a build task.
> - **Slice 00-B (Platform Readiness):** Paste into a standard Claude chat session. Claude acts as a guided checklist partner. Have your browser and terminal open alongside.
> - **Slices 01–13:** Paste into Claude Code at the start of each session. Do not add extra context — the prompts are calibrated to keep each session tightly scoped.

---

## PROMPT 00-A — Platform Orientation

> **Session type:** Standard Claude chat (not Claude Code)  
> **Goal:** Build a solid mental model before touching any infrastructure or code  
> **Duration:** 20–40 minutes of reading and Q&A

```
I am about to start building the Construction Intelligence Platform (CIP) —
a multi-tenant B2B SaaS platform for managing worker certifications and
compliance in the construction industry. The primary UX is a Microsoft
Teams Bot. It runs on OVH Public Cloud Kubernetes.

I want to use this session to build a solid mental model of the full system
before I touch any infrastructure or write any code. I will share the key
facts about the architecture, and I want you to help me internalise them
through explanation and Q&A.

Here is the architecture in brief:

STACK:
- TypeScript monorepo (pnpm workspaces): @cip/shared, @cip/hr-service,
  @cip/platform-core, @cip/teams-bot, @cip/infra
- Event bus: NATS JetStream (self-hosted on OVH K8s)
- Durable workflows: Temporal Cloud (not self-hosted)
- AI agents: LangGraph (TypeScript), invoked as Temporal Activities
- AI gateway: LiteLLM proxy — all LLM calls go through it; no service
  imports @anthropic-ai/sdk directly
- Observability: Langfuse Cloud (traces, prompt management, cost tracking)
- Auth: Keycloak (one realm per tenant)
- Database: PostgreSQL with Row-Level Security (tenant_id on every table)
- Object store: OVH Object Store (S3-compatible)
- Edge/security: Cloudflare Pro (WAF, DDoS, SSL termination)

THE CORE CERT PROCESSING LOOP:
1. Worker uploads cert doc via Teams Bot or PWA
2. NATS event fires: cip.{tenantId}.cert.uploaded.v1
3. Temporal CertificationProcessingWorkflow starts
4. Activities run: fetch-document → pre-classify → run-vision-agent
5. LangGraph VisionAgent calls LiteLLM → Anthropic Claude (vision)
6. If confidence < 0.85: Temporal Signal pauses workflow for HITL review
7. Admin reviews in Teams; signal resumes workflow
8. validate-extraction (Zod) → persist-cert (PostgreSQL + RLS)
9. NATS event fires: cip.{tenantId}.cert.processed.v1
10. Ambient Watcher reacts (expiry checks, compliance drift)

NON-NEGOTIABLES (these are enforced in every file):
1. tenantId on every DB row, NATS payload, agent state, Temporal workflow ID
2. All LLM calls via createLiteLLMClient() from @cip/shared — never @anthropic-ai/sdk
3. NATS subjects always via buildSubject() — never raw template strings
4. Temporal workflow IDs always: {workflowType}-{tenantId}-{entityId}
5. Every Temporal Activity output Zod-validated before returning
6. tenantId in MCP tools extracted from JWT — never accepted as an argument
7. TypeScript strict mode — stubs use throw new Error('not implemented')

Please do the following:

1. Confirm you have understood the architecture by giving me a one-paragraph
   summary of how a certification document flows from Teams upload to
   PostgreSQL storage, naming each system it touches in order.

2. Then ask me five questions that would reveal any gaps in my understanding
   of how the pieces connect — particularly around tenant isolation, the
   LiteLLM proxy pattern, and the Temporal + LangGraph relationship.

3. After I answer, highlight any gaps and explain the correct mental model
   for anything I got wrong or incomplete.

4. Finally, confirm which of the seven non-negotiables is hardest to enforce
   after the fact (i.e. the one most costly to retrofit if forgotten early)
   and explain why.
```

---

## PROMPT 00-B — Platform Readiness (Infrastructure Setup)

> **Session type:** Standard Claude chat (not Claude Code)  
> **Goal:** Complete every account, credential, and verification step in slices/SLICE_00.md  
> **What to have open:** Browser (OVH, Cloudflare, Temporal, Langfuse dashboards), terminal with kubectl and AWS CLI, .envrc file in editor  
> **Duration:** 2–4 hours for a first-time setup

```
I am setting up the infrastructure for the CIP Platform before writing any
application code. I need to work through every external service, credential,
and verification step systematically. Nothing should be left unconfigured
or unverified before code work begins.

The services I need to wire up are:
- OVH Public Cloud (Kubernetes cluster, node pool, Object Store, API credentials)
- Cloudflare (DNS, SSL, WAF, API token, OVH LB IP allowlist)
- Temporal Cloud (namespace, API key, CLI verification)
- Langfuse Cloud (project, API keys, health check)
- Anthropic (API key — for LiteLLM pod only, never domain services)
- Internal credentials (PostgreSQL passwords, Keycloak admin password, LiteLLM master key)
- Twilio (SMS — account SID, auth token, Canadian phone number)
- Resend (email — API key, DNS records in Cloudflare)
- Azure Bot Service (Teams channel registration, app ID and password)

My reference document is slices/SLICE_00.md which has
the full step-by-step for each service, the .envrc template, and the
verify-readiness.sh script.

I want you to guide me through this as an interactive session:

1. Start by asking me which services I have already set up (if any), so we
   can skip completed sections and focus on what remains.

2. For each incomplete service, walk me through the setup one step at a
   time. After each step, wait for me to confirm it is done before moving
   to the next. Do not dump the entire section at once.

3. After each service is complete, give me the exact verification command
   to run and ask me to paste the output. Confirm whether the output looks
   correct before we move on.

4. Keep a running checklist visible — update it at the start of each new
   service section so I can see what is done and what remains.

5. Pay particular attention to these three things which are easy to miss:
   a. ANTHROPIC_API_KEY must only go into the litellm-credentials K8s secret.
      Flag immediately if I mention putting it anywhere else.
   b. Cloudflare SSL mode must be Full (Strict) — not Full. The difference
      matters once cert-manager issues real certs.
   c. The Temporal API key is shown only once at creation. If I say I missed
      copying it, tell me immediately to create a new one before continuing.

6. Once all services are done, prompt me to run scripts/verify-readiness.sh
   and paste the full output. Work through any failures with me.

7. End the session by confirming the .envrc has every required variable from
   the template in slices/SLICE_00.md and that all K8s
   secrets exist in the correct namespaces.

Start now by asking me which services I have already configured.
```

---

## PROMPT 00-B (RESUME) — Platform Readiness Resume

> Use this if the readiness session was interrupted and you need to pick up where you left off.

```
I am continuing the CIP Platform infrastructure setup from a previous session.
My reference document is slices/SLICE_00.md.

Here is my current .envrc with the variables I have filled in so far
(I will paste it below — empty values mean not yet configured):

[PASTE YOUR .envrc HERE]

And here is the output of my current secrets check:

[PASTE: kubectl get secrets -n cip-app && kubectl get secrets -n cip-infra && kubectl get secrets -n cert-manager]

Based on what is filled in and what secrets exist, identify:
1. Which services are fully complete (credentials in .envrc AND K8s secret created AND verification passed)
2. Which services are partially done (some steps done but not all)
3. Which services have not been started

Then pick up from the first incomplete service and guide me through it
step by step, waiting for my confirmation after each step.
```

---

## PROMPT 01 — Workspace Root

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 01: Workspace Root.

Read the following files before writing anything:
- slices/CONTEXT_WORKFLOW.md (the slice map)
- slices/SLICE_01_WORKSPACE_ROOT.md (this slice's spec)

Create ONLY these files:
- package.json (workspace root)
- pnpm-workspace.yaml
- tsconfig.base.json
- .eslintrc.js
- .gitignore
- .env.example

Rules:
1. tsconfig.base.json MUST include: "exactOptionalPropertyTypes": true, "noUncheckedIndexedAccess": true, "noImplicitOverride": true
2. .eslintrc.js MUST include a no-restricted-imports rule that blocks @anthropic-ai/* with message "Use createLiteLLMClient() from @cip/shared instead"
3. .env.example must contain all variables from the spec (Section 9) with placeholder values only — no real credentials
4. Do NOT create any files outside the ones listed above
5. Do NOT create any packages/* directories yet

After creating all files, run: pnpm install
Report any errors. Do not fix errors that require changing scope (e.g., don't create package.json files for sub-packages).
```

---

## PROMPT 02 — Shared Types

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 02: Shared Types.

Read before writing:
- slices/SLICE_02_SHARED_TYPES.md

Create ONLY these files (do not touch any existing files):
- packages/shared/package.json
- packages/shared/tsconfig.json
- packages/shared/src/index.ts
- packages/shared/src/types/tenant.ts
- packages/shared/src/types/certification.ts
- packages/shared/src/types/agent.ts
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/events.ts

Hard rules — check each file before finishing:
1. Every interface that represents domain data MUST have tenantId: string (not optional)
2. All date fields MUST be string (ISO 8601), never Date
3. CertStatus MUST be a union type, not an enum
4. No imports from any client libraries (pg, nats, temporalio, openai) — types only
5. index.ts MUST re-export everything from types/

After creating all files, run: pnpm --filter @cip/shared typecheck
Fix ALL type errors before finishing. Do not move on until typecheck passes.
```

---

## PROMPT 03 — Shared Clients & Utils

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 03: Shared Clients & Utils.

Read before writing:
- slices/SLICE_03_SHARED_CLIENTS.md

The shared types from Slice 02 already exist. Do not modify them.

Create ONLY these files:
- packages/shared/src/clients/litellm.ts
- packages/shared/src/clients/langfuse.ts
- packages/shared/src/clients/temporal.ts
- packages/shared/src/clients/nats.ts
- packages/shared/src/clients/postgres.ts
- packages/shared/src/utils/subject-builder.ts
- packages/shared/src/utils/tenant-context.ts
- packages/shared/src/utils/zod-schemas.ts

Update (do not replace):
- packages/shared/src/index.ts — add re-exports for clients and utils

Hard rules:
1. litellm.ts MUST export createLiteLLMClient() using the openai package's OpenAI class pointed at LITELLM_BASE_URL. It MUST NOT import @anthropic-ai/sdk.
2. subject-builder.ts MUST export buildSubject() and the Subjects map. No file outside this module may construct raw NATS subject strings.
3. postgres.ts MUST export withTenantRLS() — every DB call goes through this wrapper.
4. zod-schemas.ts MUST define ExtractionResultSchema and IntentResultSchema with tenantId: z.string().uuid() as a required field.

After creating all files, run: pnpm --filter @cip/shared typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 04 — Infrastructure YAML

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 04: Infrastructure YAML.

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 04 section)

Create ONLY these files:
- infra/k8s/namespaces.yaml
- infra/k8s/pvcs.yaml
- infra/k8s/litellm-config.yaml
- infra/helm/postgres-values.yaml
- infra/helm/nats-values.yaml
- infra/helm/keycloak-values.yaml
- infra/helm/monitoring-values.yaml
- infra/terraform/bootstrap/providers.tf
- infra/terraform/bootstrap/variables.tf
- infra/terraform/modules/ovh-cluster/main.tf (stub with comments)
- infra/terraform/modules/ovh-cluster/variables.tf

Hard rules:
1. pvcs.yaml MUST define exactly 5 PVCs: postgres-data (20Gi), nats-data (5Gi), keycloak-data (2Gi), langfuse-data (10Gi), litellm-logs (5Gi) — all in namespace cip-infra
2. litellm-config.yaml MUST define model aliases cip-vision, cip-chat, cip-lightweight, cip-reasoning — all referencing os.environ/ANTHROPIC_API_KEY, never a hardcoded key
3. NO actual secrets or API keys in any YAML file — all sensitive values must reference K8s Secret names via env var references
4. Terraform files are stubs only — valid HCL structure but no real resource implementations required

No TypeScript is created in this slice. No typecheck needed.
```

---

## PROMPT 05 — HR Service: Database Layer

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 05: HR Service Database Layer.

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 05 section)

@cip/shared already exists and compiles. Do not modify it.

Create ONLY these files:
- packages/hr-service/package.json
- packages/hr-service/tsconfig.json
- packages/hr-service/src/db/migrations/001_initial.sql
- packages/hr-service/src/db/queries/certifications.ts
- packages/hr-service/src/db/queries/workers.ts

Hard rules:
1. Every SQL table MUST have a tenant_id UUID NOT NULL column
2. RLS MUST be enabled on every table with policy: tenant_id = current_setting('app.current_tenant_id')::UUID
3. Query functions MUST take PoolClient as their first argument (not Pool) — the caller is responsible for withTenantRLS
4. All stub functions MUST throw new Error('not implemented') — never return undefined as any
5. Return types MUST reference Certification and Worker from @cip/shared

After creating all files, run: pnpm --filter @cip/hr-service typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 06 — HR Service: Temporal Workflows & Activities

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 06: HR Service Temporal Workflows & Activities.

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 06 section)

Create ONLY these files:
- packages/hr-service/src/index.ts
- packages/hr-service/src/server.ts
- packages/hr-service/src/routes/health.ts
- packages/hr-service/src/workers/temporal-worker.ts
- packages/hr-service/src/workflows/certification-processing.workflow.ts
- packages/hr-service/src/workflows/worker-onboarding.workflow.ts
- packages/hr-service/src/activities/fetch-document.activity.ts
- packages/hr-service/src/activities/pre-classify-cert.activity.ts
- packages/hr-service/src/activities/run-vision-agent.activity.ts
- packages/hr-service/src/activities/validate-extraction.activity.ts
- packages/hr-service/src/activities/persist-cert.activity.ts
- packages/hr-service/src/activities/notify-hitl.activity.ts
- packages/hr-service/Dockerfile
- packages/hr-service/helm/Chart.yaml
- packages/hr-service/helm/values.yaml
- packages/hr-service/helm/templates/deployment.yaml
- packages/hr-service/helm/templates/service.yaml

Hard rules:
1. EVERY call to client.workflow.start() MUST set workflowId to the pattern {workflowType}-{tenantId}-{entityId} AND MUST have a comment // Workflow ID pattern: {workflowType}-{tenantId}-{entityId} on the preceding line
2. run-vision-agent.activity.ts MUST call ExtractionResultSchema.parse() on the agent output before returning — never return unvalidated data
3. The HITL signal MUST use defineSignal from @temporalio/workflow — not polling
4. All activity stubs MUST throw new Error('not implemented')
5. temporal-worker.ts MUST register every workflow and every activity

After creating all files, run: pnpm --filter @cip/hr-service typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 07 — HR Service: Vision Agent

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 07: HR Service Vision Agent (LangGraph).

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 07 section)

Create ONLY these files:
- packages/hr-service/src/agents/vision-agent/index.ts
- packages/hr-service/src/agents/vision-agent/nodes.ts
- packages/hr-service/src/agents/vision-agent/state.ts
- packages/hr-service/src/agents/vision-agent/prompts.ts

Hard rules:
1. state.ts MUST include tenantId as a required (non-optional) annotation field
2. nodes.ts MUST use createLiteLLMClient() from @cip/shared — never new OpenAI() with a raw key
3. The model name passed to LiteLLM MUST be the alias cip-vision — never a raw Anthropic model string like claude-sonnet-4-20250514
4. index.ts MUST export a single function runVisionAgent(input) that returns Promise<ExtractionResult>
5. prompts.ts MUST have a TODO comment: // TODO: Load from Langfuse prompt management in production

After creating all files, run: pnpm --filter @cip/hr-service typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 08 — HR Service: NATS Watcher

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 08: HR Service NATS Ambient Watcher.

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 08 section)

Create ONLY this file:
- packages/hr-service/src/nats/watcher.ts

Update (do not replace):
- packages/hr-service/src/index.ts — call startAmbientWatcher() after the server starts

Hard rules:
1. Every NATS subscription subject MUST use Subjects.* helpers from @cip/shared or buildSubject() — never a raw string
2. Every message handler MUST call msg.ack() after successful processing
3. Event payloads MUST be typed — never typed as any
4. startAmbientWatcher() MUST be exported and called from index.ts

After editing files, run: pnpm --filter @cip/hr-service typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 09 — HR Service: MCP Server

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 09: HR Service MCP Server.

Read before writing:
- slices/SLICE_04_to_09.md (the Slice 09 section)

Create ONLY these files:
- packages/hr-service/src/mcp-server/index.ts
- packages/hr-service/src/mcp-server/tools/get-worker-certs.ts
- packages/hr-service/src/mcp-server/tools/get-compliance-status.ts
- packages/hr-service/src/mcp-server/tools/trigger-cert-upload.ts

Hard rules — this is the most security-critical slice:
1. NONE of the three tool input schemas may include tenantId as a field. If you find yourself typing tenantId in a z.object() for a tool input, STOP and extract it from the JWT instead.
2. tenantId MUST be extracted from the JWT auth context (authInfo.token) in every tool handler
3. get-worker-certs MUST use withTenantRLS() from @cip/shared before any DB query
4. trigger-cert-upload MUST publish a NATS event using Subjects.certUploaded(tenantId) — never a raw string

After creating all files, run: pnpm --filter @cip/hr-service typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 10 — Platform Core

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 10: Platform Core service.

Read before writing:
- slices/SLICE_10_to_13.md (the Slice 10 section)

Create ONLY these files:
- packages/platform-core/package.json
- packages/platform-core/tsconfig.json
- packages/platform-core/src/index.ts
- packages/platform-core/src/server.ts
- packages/platform-core/src/routes/health.ts
- packages/platform-core/src/routes/tenant.ts
- packages/platform-core/src/workers/temporal-worker.ts
- packages/platform-core/src/workflows/tenant-provisioning.workflow.ts
- packages/platform-core/src/activities/create-keycloak-realm.activity.ts
- packages/platform-core/src/activities/create-temporal-namespace.activity.ts
- packages/platform-core/src/activities/create-nats-streams.activity.ts
- packages/platform-core/src/activities/create-object-store-buckets.activity.ts
- packages/platform-core/src/activities/init-tenant-database.activity.ts
- packages/platform-core/src/activities/issue-litellm-virtual-key.activity.ts
- packages/platform-core/src/activities/provision-complete-notify.activity.ts
- packages/platform-core/Dockerfile
- packages/platform-core/helm/Chart.yaml
- packages/platform-core/helm/values.yaml
- packages/platform-core/helm/templates/deployment.yaml
- packages/platform-core/helm/templates/service.yaml

Hard rules:
1. TenantProvisioningWorkflow MUST run activities in the order specified in the slice doc
2. Every workflow.start() call MUST follow pattern {workflowType}-{tenantId}-{entityId} with comment
3. All activity stubs MUST throw new Error('not implemented')
4. issueLiteLLMVirtualKey activity MUST return the key as its output (string)

After creating all files, run: pnpm --filter @cip/platform-core typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 11 — Teams Bot

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 11: Teams Bot.

Read before writing:
- slices/SLICE_10_to_13.md (the Slice 11 section)

Create ONLY these files:
- packages/teams-bot/package.json
- packages/teams-bot/tsconfig.json
- packages/teams-bot/src/index.ts
- packages/teams-bot/src/bot.ts
- packages/teams-bot/src/agents/intent-router/index.ts
- packages/teams-bot/src/agents/intent-router/schema.ts
- packages/teams-bot/src/handlers/cert-upload.handler.ts
- packages/teams-bot/src/handlers/compliance-query.handler.ts
- packages/teams-bot/src/handlers/hitl-response.handler.ts
- packages/teams-bot/Dockerfile
- packages/teams-bot/helm/Chart.yaml
- packages/teams-bot/helm/values.yaml
- packages/teams-bot/helm/templates/deployment.yaml
- packages/teams-bot/helm/templates/service.yaml

Hard rules:
1. The intent router is a single LLM call — NOT a LangGraph graph. Do not add a graph.
2. IntentResultSchema.parse() MUST be called on every intent router output
3. tenantId on IntentResult MUST come from TenantContext — never from the LLM response
4. hitl-response.handler.ts MUST send a Temporal Signal, not trigger a new workflow
5. createLiteLLMClient() MUST be used — never new OpenAI() with a raw key
6. Model names MUST be LiteLLM aliases (cip-chat) — never raw Anthropic model strings

After creating all files, run: pnpm --filter @cip/teams-bot typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 12 — Infra Scripts

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 12: Infra Scripts (OVH cluster management).

Read before writing:
- slices/SLICE_10_to_13.md (the Slice 12 section)

Create ONLY these files:
- packages/infra/package.json
- packages/infra/tsconfig.json
- packages/infra/src/ovh-client.ts
- packages/infra/src/scale-nodepool.ts
- packages/infra/src/start.ts
- packages/infra/src/stop.ts

Hard rules:
1. scaleNodepool() MUST poll until status === 'READY' — not fire-and-forget
2. stop.ts MUST NOT delete PVCs under any circumstances. Add a comment: // IMPORTANT: Never delete PVCs — data is permanent
3. Helm release names and namespaces in start.ts and stop.ts MUST match what is in packages/*/helm/Chart.yaml
4. stop.ts uninstalls in REVERSE order of start.ts (services first, infrastructure last)

After creating all files, run: pnpm --filter @cip/infra typecheck
Fix ALL type errors before finishing.
```

---

## PROMPT 13 — Makefile & Shell Scripts

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE 13: Makefile & Shell Scripts.

Read before writing:
- slices/SLICE_10_to_13.md (the Slice 13 section)

Create ONLY these files:
- Makefile (update — do not replace existing targets if they exist)
- scripts/bootstrap.sh
- scripts/create-secrets.sh
- scripts/verify-readiness.sh

Hard rules:
1. All shell scripts MUST start with: #!/usr/bin/env bash\nset -euo pipefail
2. create-secrets.sh MUST use --dry-run=client -o yaml | kubectl apply (idempotent pattern)
3. verify-readiness.sh MUST check at minimum: kubectl connectivity, all required namespaces,
   all required K8s secrets, OVH S3 reachable, Temporal namespace exists, Langfuse health,
   Cloudflare token valid, all required .envrc variables set
4. bootstrap.sh MUST be safe to run more than once (idempotent)
5. Makefile MUST have a help target that lists all targets

After creating all files:
1. bash -n scripts/bootstrap.sh  (syntax check)
2. bash -n scripts/create-secrets.sh
3. bash -n scripts/verify-readiness.sh
4. pnpm typecheck  (final full typecheck across all packages)

Report the output of each. Fix any errors.
```

---

## PROMPT CROSS-SLICE — Resolve outstanding cross-slice notes

> **When to use:** After any slice that produced one or more CROSS-SLICE NOTEs,
> and before starting the next slice. Run this in Claude Code.

```
You are working on the CIP Platform TypeScript monorepo.

This is a cross-slice correction session. Do not build any new slice features.

Read these files first:
- slices/CROSS_SLICE_NOTES.md  — the full list of open notes
- CLAUDE.md             — the non-negotiables and scope rules

Then, for each note with status OPEN:
1. Read only the specific file(s) named in the note
2. Apply exactly the fix described — nothing more
3. Run pnpm --filter @cip/<affected-package> typecheck
4. Fix any type errors introduced by the change
5. Mark the note as RESOLVED in slices/CROSS_SLICE_NOTES.md with today's date

Scope rules for this session:
- Touch only the files named in OPEN notes
- Do not refactor, rename, or improve anything not listed in a note
- Do not open any file not named in a note or required by typecheck output
- If a fix reveals a further issue in a third file, write a new note
  rather than fixing it in this session

When all OPEN notes are resolved, run: pnpm -r run typecheck
Report the output. If it is clean, this session is complete.
Commit with: git commit -m "slice(cross): resolve cross-slice notes CS-NNN, CS-NNN"
```

---

## PROMPT — App Service Images & CI Pipeline

```
You are working on the CIP Platform TypeScript monorepo.

Your task for this session is SLICE APP-IMAGES: wire the three application
services (hr-service, platform-core, teams-bot) so they build, push, and
deploy to the cluster.

Read before writing:
- slices/SLICE_APP_IMAGES.md (full requirements, acceptance criteria, hard rules)

Create or modify ONLY these files:
- .github/workflows/build-images.yml     ← NEW
- packages/hr-service/helm/values.yaml   ← replace YOUR_ORG
- packages/platform-core/helm/values.yaml ← replace YOUR_ORG
- packages/teams-bot/helm/values.yaml    ← replace YOUR_ORG
- packages/infra/src/start.ts            ← restore three services to APP_CHARTS
- packages/infra/src/stop.ts             ← restore three services to APP_RELEASES
- Makefile                               ← replace YOUR_ORG in deploy target

Hard rules:
1. Do not modify any Dockerfile
2. Use GITHUB_TOKEN for registry auth — no PAT or CR_PAT secret
3. pullPolicy: Always for the dev tag
4. After restoring services to start.ts, typecheck must pass

After making all changes:
1. pnpm --filter @cip/infra typecheck
2. bash -n .github/workflows/build-images.yml || echo "YAML — no bash check needed"

Report the typecheck output. Fix any errors before finishing.
```

---

## PROMPT — Full Typecheck (run after all slices)

```
Run the following and report the full output:

pnpm -r run typecheck

If there are errors, fix them in dependency order:
1. Fix @cip/shared errors first
2. Then fix @cip/hr-service errors
3. Then fix @cip/platform-core errors
4. Then fix @cip/teams-bot errors
5. Then fix @cip/infra errors

Do not move to a later package until all earlier packages typecheck cleanly.

The following violations are always a bug — fix them even if TypeScript does not catch them:
- Any file that imports from @anthropic-ai/sdk
- Any NATS subject constructed as a template literal outside of subject-builder.ts
- Any workflow.start() call without a comment // Workflow ID pattern: {workflowType}-{tenantId}-{entityId}
- Any Temporal Activity that returns data without calling .parse() on a Zod schema first
- Any MCP tool input schema that includes tenantId as a field
- Any LiteLLM model call using a raw Anthropic model string instead of a cip-* alias
```

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
## PROMPT 02 — Shared Types

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 02 — Shared Types
Goal: Create all shared domain types used by every other package.

Read before writing:
- slices/SLICE_02_SHARED_TYPES.md

Create only these files:
- packages/shared/src/types/tenant.ts
- packages/shared/src/types/employee.ts
- packages/shared/src/types/certification.ts
- packages/shared/src/types/role.ts
- packages/shared/src/types/agent.ts
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/events.ts
- packages/shared/src/types/mcp.ts
- packages/shared/src/index.ts (re-exports only)

Hard rules:
1. No client imports (pg, nats, temporalio) — types only
2. ExtractionResult must be z.infer<typeof ExtractionResultSchema> — not a hand-written interface
3. Worker type must not exist — Employee only
4. All dates are string (ISO 8601) — never Date
5. mergeCapabilities() must be a pure function with no side effects

Finish with: pnpm --filter @cip/shared typecheck
Report the full typecheck output. Fix all errors before finishing.
```

---

## PROMPT 05A — HR Domain Schema

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 05A — HR Domain Schema
Goal: Write the normalized SQL migration that establishes the full HR domain schema.

Read before writing:
- slices/SLICE_05A_HR_DOMAIN.md

Create only this file:
- packages/hr-service/src/db/migrations/002_domain_model.sql

Also create these empty directories (touch a .gitkeep in each):
- packages/hr-service/src/modules/certifications/
- packages/hr-service/src/modules/employees/
- packages/hr-service/src/modules/compliance/

Hard rules:
1. Every tenant-scoped table must have tenant_id UUID NOT NULL and an RLS policy
2. submission_status CHECK must match exactly: pending|processing|matched|failed|hitl_required
3. cert_status CHECK must match exactly: valid|expired|revoked|superseded
4. Lookup tables (hitl_reasons etc.) have no tenant_id — they are global
5. All seed INSERTs use ON CONFLICT (code) DO NOTHING

No typecheck for this slice — validate SQL syntax manually or against a dev DB.
Report any constraints or indexes you added and why.
```

---

## PROMPT 05B — HR ORM + Registry

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 05B — HR ORM + Registry
Goal: Add Drizzle ORM schema, withTenantRLS wrapper, and LookupRegistry utility.

Read before writing:
- slices/SLICE_05B_HR_ORM.md
- packages/hr-service/src/db/migrations/002_domain_model.sql

Create/modify only these files:
- packages/shared/src/utils/lookup-registry.ts      (new)
- packages/shared/src/index.ts                      (add LookupRegistry export)
- packages/hr-service/src/db/index.ts               (new)
- packages/hr-service/src/db/schema.ts              (new — mirrors SQL migration exactly)
- packages/hr-service/src/db/rls.ts                 (new)
- packages/hr-service/src/db/registries.ts          (new)
- packages/hr-service/package.json                  (add drizzle-orm, pg dependencies if missing)

Hard rules:
1. withTenantRLS() must SET LOCAL inside a transaction — never outside one
2. Every Drizzle table must have tenantId: uuid('tenant_id').notNull() where the SQL has tenant_id
3. LookupRegistry throws on unknown code — never returns undefined
4. getDb() and getHrRegistries() are lazy singletons — never connect/load at module load time
5. No status string literals used directly — only registry.code or typed TCode

Finish with: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 06 — HR Temporal Workflows

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 06 — HR Temporal Workflows
Goal: Build CertificationProcessingWorkflow with all activities (matching activities are stubs).

Read before writing:
- slices/SLICE_06_HR_TEMPORAL.md
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/agent.ts

Create only these files:
- packages/hr-service/src/workers/temporal-worker.ts
- packages/hr-service/src/modules/certifications/workflows/certification-processing.workflow.ts
- packages/hr-service/src/modules/certifications/activities/fetch-document.activity.ts
- packages/hr-service/src/modules/certifications/activities/pre-classify-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/run-vision-agent.activity.ts
- packages/hr-service/src/modules/certifications/activities/validate-extraction.activity.ts
- packages/hr-service/src/modules/certifications/activities/persist-cert.activity.ts
- packages/hr-service/src/modules/certifications/activities/notify-hitl.activity.ts

Hard rules:
1. Workflow ID: CertProcess-${tenantId}-${submissionId} with comment on preceding line
2. matchEmployee and matchCertDefinition run with Promise.all (parallel) — stubs throwing 'not implemented'
3. runVisionAgentActivity must call ExtractionResultSchema.parse() before returning
4. HITL signal uses defineSignal + condition() — never a polling loop
5. Task queue from process.env['TEMPORAL_TASK_QUEUE_HR'] — never hardcoded

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 07 — Vision Agent

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 07 — Vision Agent (LangGraph)
Goal: Build the LangGraph vision agent used by runVisionAgentActivity.

Read before writing:
- slices/SLICE_07_VISION_AGENT.md
- packages/hr-service/src/modules/certifications/activities/run-vision-agent.activity.ts

Create only these files:
- packages/hr-service/src/modules/certifications/agents/vision-agent/index.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/state.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/nodes.ts
- packages/hr-service/src/modules/certifications/agents/vision-agent/prompts.ts

Hard rules:
1. LLM model alias is cip-vision — never a raw Anthropic model string
2. State must have tenantId: string and submissionId: string (not optional)
3. ExtractionResultSchema.parse() called on LLM response before returning from extractFields
4. Never import from @anthropic-ai/sdk — use createLiteLLMClient from @cip/shared
5. Graph has exactly 4 nodes: extractFields, assessConfidence, formatOutput, flagForHitl

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 08 — NATS Watcher

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 08 — NATS Watcher
Goal: Build the ambient watcher that reacts to domain events.

Read before writing:
- slices/SLICE_08_NATS_WATCHER.md
- packages/shared/src/types/events.ts
- packages/shared/src/utils/subject-builder.ts

Create only this file:
- packages/hr-service/src/nats/watcher.ts

Modify:
- packages/hr-service/src/index.ts (call startAmbientWatcher alongside Temporal worker)

Hard rules:
1. No raw NATS subject strings — use Subjects.* helpers only
2. Every message is acked after its handler completes
3. Use EmployeeOnboardedEvent — not WorkerOnboardedEvent (deprecated alias)
4. Each handler is a named function — no anonymous inline logic in subscription loops
5. If a Subjects.* helper is missing, log a CROSS-SLICE NOTE and use a placeholder string

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 09 — MCP Server

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 09 — MCP Server
Goal: Build the hr-service MCP server with all tool registrations.

Read before writing:
- slices/SLICE_09_MCP_SERVER.md
- packages/shared/src/types/mcp.ts
- packages/hr-service/src/db/rls.ts
- packages/hr-service/src/db/registries.ts

Create only these files:
- packages/hr-service/src/mcp-server/index.ts
- packages/hr-service/src/modules/certifications/mcp-tools/get-my-certifications.ts
- packages/hr-service/src/modules/certifications/mcp-tools/get-submission-status.ts
- packages/hr-service/src/modules/certifications/mcp-tools/process-document.ts
- packages/hr-service/src/modules/certifications/mcp-tools/resolve-hitl.ts
- packages/hr-service/src/modules/certifications/mcp-tools/cards/certifications-card.ts
- packages/hr-service/src/modules/certifications/mcp-tools/cards/submission-status-card.ts
- packages/hr-service/src/modules/employees/mcp-tools/list-staff.ts
- packages/hr-service/src/modules/employees/mcp-tools/get-employee-capabilities.ts
- packages/hr-service/src/modules/employees/mcp-tools/cards/staff-card.ts
- packages/hr-service/src/modules/settings/mcp-tools/get-tenant-channel-config.ts

Hard rules:
1. tenantId absent from every tool input schema — always from authInfo.token
2. Every tool returns McpModuleResponse serialised as JSON in content[0].text
3. Every tool has annotations.requiredCapability (empty string if none required)
4. Card builders are pure functions — no DB calls, no async
5. process_document inserts a cert_submission row then starts Temporal workflow

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 10 — Platform Core

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 10 — Platform Core
Goal: Build TenantProvisioningWorkflow with initTenantDatabase seeding roles and settings.

Read before writing:
- slices/SLICE_10_PLATFORM_CORE.md
- packages/shared/src/types/workflow.ts

Create only these files:
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

Hard rules:
1. Workflow ID: TenantProvision-${tenantId}-${tenantId} with comment on preceding line
2. initTenantDatabase seeds the 5 system roles with correct capabilities JSONB
3. initTenantDatabase inserts an empty tenant_settings row (idempotent ON CONFLICT)
4. All activities throw new Error('not implemented') except initTenantDatabase (seed logic only)
5. Task queue from process.env['TEMPORAL_TASK_QUEUE_PLATFORM'] — never hardcoded

Finish with: pnpm --filter @cip/platform-core typecheck
Fix all errors before finishing.
```

---

## PROMPT 14 — Matching Activities

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 14 — Matching Activities
Goal: Implement employee and cert-definition matching, replacing Slice 06 stubs.

Read before writing:
- slices/SLICE_14_MATCHING.md
- packages/hr-service/src/modules/certifications/activities/  (existing stubs to replace)
- sample/ernai/packages/orchestration-service/src/matching/personMatch.ts
- sample/ernai/packages/orchestration-service/src/matching/certMatch.ts

Create/modify only these files:
- packages/hr-service/src/modules/certifications/activities/match-employee.activity.ts
- packages/hr-service/src/modules/certifications/activities/match-cert-definition.activity.ts
- packages/hr-service/src/modules/certifications/activities/nickname-map.ts

Hard rules:
1. Both activities Zod-validate return values before returning
2. LLM calls use cip-lightweight alias via createLiteLLMClient — never a raw model string
3. DB queries use withTenantRLS — never raw queries
4. NICKNAME_MAP must have minimum 30 entries (port from PoC)
5. Three-pass employee matching: exact email → fuzzy name → LLM tiebreaker

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 15 — Employee Onboarding

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 15 — Employee Onboarding Workflow
Goal: Build EmployeeOnboardingWorkflow with 4 activities.

Read before writing:
- slices/SLICE_15_EMPLOYEE_ONBOARDING.md
- packages/shared/src/types/workflow.ts
- packages/shared/src/types/events.ts

Create only these files:
- packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts
- packages/hr-service/src/modules/employees/activities/create-keycloak-user.activity.ts
- packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts
- packages/hr-service/src/modules/employees/activities/send-welcome-notification.activity.ts
- packages/hr-service/src/modules/employees/activities/publish-employee-onboarded.activity.ts

Modify:
- packages/hr-service/src/workers/temporal-worker.ts (register new workflow + activities)

Hard rules:
1. Workflow ID: EmployeeOnboard-${tenantId}-${employeeId} with comment
2. createKeycloakUser branches on identityType — separate stub for each path
3. assignDefaultRole: aad_federated → field_operations, field_employee → field_employee
4. publishEmployeeOnboarded uses Subjects.employeeOnboarded() — no raw NATS string
5. All activity bodies throw new Error('not implemented') except publishEmployeeOnboarded

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 16 — Complex Query Tools

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 16 — Complex Query Tools
Goal: Build multi-step MCP tools for compliance reporting.

Read before writing:
- slices/SLICE_16_COMPLEX_QUERY_TOOLS.md
- packages/shared/src/types/mcp.ts
- packages/hr-service/src/mcp-server/index.ts

Create only these files:
- packages/hr-service/src/modules/compliance/mcp-tools/get-expiring-certifications.ts
- packages/hr-service/src/modules/compliance/mcp-tools/get-compliance-summary.ts
- packages/hr-service/src/modules/compliance/mcp-tools/get-staff-certifications.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/expiry-card.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/compliance-summary-card.ts
- packages/hr-service/src/modules/compliance/mcp-tools/cards/staff-certs-card.ts

Modify:
- packages/hr-service/src/mcp-server/index.ts (register compliance tools)

Hard rules:
1. Each tool declares requiredCapability annotation
2. Each tool returns McpModuleResponse with data, card, and message
3. All DB queries use withTenantRLS
4. Card builders are pure functions — no DB calls, no async
5. tenantId absent from all tool input schemas

Finish with: pnpm --filter @cip/hr-service typecheck
Fix all errors before finishing.
```

---

## PROMPT 17 — Teams Bot

```
You are working on the CIP Platform TypeScript monorepo.

Session: SLICE 17 — Teams Bot (Generic Gateway)
Goal: Build a lightweight Teams bot with zero business logic. Bot calls MCP only.

Read before writing:
- slices/SLICE_17_TEAMS_BOT.md
- packages/shared/src/types/mcp.ts
- packages/shared/src/types/tenant.ts

Create only these files:
- packages/teams-bot/src/index.ts
- packages/teams-bot/src/bot.ts
- packages/teams-bot/src/server.ts
- packages/teams-bot/src/teams-protocol/file-handler.ts
- packages/teams-bot/src/teams-protocol/card-renderer.ts
- packages/teams-bot/src/teams-protocol/channel-registry.ts
- packages/teams-bot/src/auth/resolve-context.ts
- packages/teams-bot/src/mcp/client.ts
- packages/teams-bot/src/mcp/tool-discovery.ts
- packages/teams-bot/src/mcp/tool-executor.ts
- packages/teams-bot/src/intent/router.ts

Hard rules:
1. No imports from @cip/hr-service — MCP client only
2. No switch(intent) or hardcoded intent strings — LLM selects the tool
3. No channel IDs, team IDs, or role names hardcoded anywhere in the bot
4. detectFileAttachments must strip text/html and handle Teams CDN download info pattern
5. POST /proactive is the only mechanism for unsolicited messages

Finish with: pnpm --filter @cip/teams-bot typecheck
Fix all errors before finishing.
```

---
---

## Archived prompts — slices completed 2026-04-30 (auth/multi-tenant chain)

_Slices 31, 32, 33, 35, 36 ran in this order during the auth/multi-tenant work._
_Slice docs moved to archive/ alongside these prompts._

---

## PROMPT Slice 32 — Realm Roles + Auth Context + HR Audit Table

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 32 — Realm Roles `hr`/`employee`, Auth Context, HR Audit
Package: @cip/shared, @cip/hr-service, plus scripts/bootstrap.sh
Verify: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_32_REALM_ROLES_AND_AUDIT.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md   §§ "Decisions resolved", "Audit"

Goal: Plumbing only — create realm roles `hr` and `employee` in KC, change
Slice 25's default-role assignment to `employee`, extend `AuthContext` with
`roles[]`, add `requireRealmRole(role)` middleware, add `hr_actions` table +
`recordHrAction` wrapper. No new MCP tools. No new workflows.

Files to modify:
- packages/shared/src/utils/tenant-context.ts
- packages/hr-service/src/modules/employees/activities/assign-default-role.activity.ts
- scripts/bootstrap.sh

Files to create:
- packages/hr-service/src/db/migrations/00X_hr_actions.sql   (use next free 00X)
- packages/hr-service/src/db/queries/hr-actions.ts
- packages/hr-service/src/services/audit.ts

Hard rules (Seven Non-Negotiables):
- tenantId on every domain interface — `hr_actions.tenant_id` is NOT NULL with RLS
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body
- recordHrAction must NOT throw on DB write failure (logs only)

Acceptance: see "Acceptance Criteria" in SLICE_32_REALM_ROLES_AND_AUDIT.md.

If a finding requires changing earlier slice output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(32): hr/employee realm roles, auth-context roles[], hr_actions audit table
```

---

## PROMPT Slice 33 — HR MCP Tools + Identity Migration + Disable Workflows

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 33 — HR MCP Tools, Identity Migration, Disable Workflows
Package: @cip/hr-service
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md
- docs/identity-and-auth-architecture.md

STEP 0 BEFORE ANY HANDLER CODE:

  Investigate the @modelcontextprotocol/sdk version pinned in this repo and
  determine whether it exposes structuredContent natively or only content[].
  Look at how existing tools under
  packages/hr-service/src/modules/certifications/mcp-tools/ shape their
  results. Then PAUSE and post a brief report to the user containing:
    - SDK version
    - structuredContent supported (yes/no)
    - what existing tools do today
    - your recommended envelope shape (default proposal:
        { ok, code?, data?, message })
    - your recommended carrier (native structuredContent OR JSON-in-text)
  Wait for user confirmation. Then implement uniformly across all 7 tools.

  Workflows + activities below can be written in parallel with the
  investigation; only the seven `*.tool.ts` handlers wait on the answer.

Goal: Expose 7 HR MCP tools gated by 'hr' realm role; add the
EmployeeIdentityMigrationWorkflow and EmployeeDisableWorkflow with their
activities; extract Slice 31's onboarding logic into a shared service so
employee.create and POST /admin/employees share the same code path; write
hr_actions audit rows for every tool call.

Files to create / modify: see SLICE_33 spec § "What You Are Building".
There are 12 new files (3 services, 2 workflows, 10 activities, 7 MCP tools,
1 tool registry) and a handful of modifications (worker registration, mcp
server mount, route handler thinning).

Hard rules (Seven Non-Negotiables):
- tenantId from authInfo.token (MCP) / req.auth (HTTP), never input schemas
- Workflow ID patterns:
    EmployeeIdentityMigrationWorkflow → EmployeeMigrate-${tenantId}-${employeeId}
    EmployeeDisableWorkflow            → EmployeeDisable-${tenantId}-${employeeId}
  with the // Workflow ID pattern: ... comment line above each start call
- Every activity producing domain data validates output via Zod .parse()
- No @anthropic-ai/sdk imports
- NATS subjects only via Subjects.* — log a cross-slice note if you need to
  add new subjects to @cip/shared
- Stubs forbidden — every function ships with a working body
  (Step 0 investigation does not count as a stub; tool handlers are written
  AFTER the envelope is confirmed)

Acceptance: see "Acceptance Criteria" in SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md.

If a finding requires changing earlier slice output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(33): hr mcp tools, identity migration workflows, disable workflow, audit wiring
```

---

## PROMPT Slice 31 — Employee Admin Provisioning Endpoint

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 31 — Employee Admin Provisioning Endpoint
Package: @cip/hr-service (plus scripts/bootstrap.sh)
Verify: pnpm --filter @cip/hr-service typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md                       (check for any open notes that touch hr-service)
- docs/identity-and-auth-architecture.md            (background — three-store identity model + JWT AG provisioning rule)
- docs/users-roles-auth-normalization-plan.md       (role model — `hr` is the gate, not `admin`)

Prerequisite: Slice 32 must be complete. This slice consumes its outputs:
  - `requireRealmRole('hr')` middleware from @cip/shared
  - `recordHrAction` from packages/hr-service/src/services/audit.ts
  - `hr` and `employee` realm roles seeded in KC

Goal: Add authenticated POST /admin/employees on hr-service that inserts an
employees row, starts EmployeeOnboardingWorkflow, and records an hr_actions
audit row. Extract the provisioning logic into services/employee-onboarding.ts
so Slice 33's employee.create MCP tool can reuse it. Add the oid → BROKER_ID
mapper to the aad IDP in scripts/bootstrap.sh so JWT AG can match users
provisioned by this endpoint.

Files to create:
- packages/hr-service/src/types/employee.ts
- packages/hr-service/src/db/queries/employees.ts
- packages/hr-service/src/services/employee-onboarding.ts   (the actual logic)
- packages/hr-service/src/routes/admin-employees.ts          (thin route wrapper)

Files to modify:
- packages/hr-service/src/server.ts                 (mount the new router)
- scripts/bootstrap.sh                              (add aad-oid-as-user-id mapper)

Optional (do iff scope allows; otherwise log a cross-slice note for Slice 25):
- packages/hr-service/src/modules/employees/activities/  (add persistKeycloakIdActivity)
- packages/hr-service/src/modules/employees/workflows/employee-onboarding.workflow.ts (call it)

Hard rules (Seven Non-Negotiables):
- tenantId comes from req.auth, never from request body
- Endpoint is gated on `hr` realm role (NOT `admin` — see normalization plan)
- Workflow ID pattern + comment line above the start call
- Zod .parse() on persistence boundaries
- No @anthropic-ai/sdk imports
- No raw NATS subjects
- Stubs forbidden — every function has a working body
- Every successful AND failed onboardEmployee call writes an hr_actions row

Acceptance: see "Acceptance Criteria" in SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md.

If a finding requires changing an earlier slice's output: log a cross-slice note
per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor outside this slice.

Commit: slice(31): admin employee provisioning endpoint + AAD oid mapper
```

---

## PROMPT Slice 35 — Tenants + Tenant Identity Providers Tables

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 35 — Tenants Table + Tenant Identity Providers
Package: @cip/shared, @cip/hr-service, @cip/platform-core
Verify: pnpm --filter @cip/shared typecheck && pnpm --filter @cip/hr-service typecheck && pnpm --filter @cip/platform-core typecheck && pnpm -r run typecheck

Read before writing:
- CLAUDE.md
- slices/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md                          (check for any open notes)
- docs/users-roles-auth-normalization-plan.md          (background)

Goal: Add `tenants` and `tenant_identity_providers` tables (cip_hr DB,
no RLS — platform-level). Drizzle schema, Zod types in @cip/shared,
queries, four admin endpoints on hr-service guarded by a shared
PLATFORM_ADMIN_TOKEN header, and a modification to platform-core's
POST /tenants so it inserts the tenant row BEFORE starting the
existing TenantProvisioningWorkflow.

Files to create:
- packages/hr-service/src/db/migrations/004_tenants.sql
- packages/hr-service/src/db/queries/tenants.ts
- packages/hr-service/src/db/queries/tenant-identity-providers.ts
- packages/hr-service/src/routes/admin-tenants.ts

Files to modify:
- packages/hr-service/src/db/schema.ts
- packages/hr-service/src/db/index.ts            (export getPool() if not present)
- packages/hr-service/src/server.ts              (mount adminTenantsRouter)
- packages/shared/src/types/tenant.ts            (Zod schemas + types)
- packages/platform-core/src/routes/tenant.ts    (insert via hr-service before workflow)
- packages/platform-core/helm/values.yaml        (HR_SERVICE_URL, PLATFORM_ADMIN_TOKEN env)
- packages/hr-service/helm/values.yaml           (PLATFORM_ADMIN_TOKEN env)

Hard rules (Seven Non-Negotiables):
- tenants.id IS the canonical tenant identifier (= KC realm name)
- tenants and tenant_identity_providers do NOT have RLS — platform-scope
- Secrets do NOT live in tenant_identity_providers.config — secret_ref names a K8s secret
- Zod .parse() on every DB-layer return value
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body

Acceptance: see "Acceptance Criteria" in SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(35): tenants table + tenant_identity_providers + admin endpoints
```

---

## PROMPT Slice 36 — Multi-Tenant Teams Bot

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 36 — Multi-Tenant Teams Bot (in-code tenant routing)
Package: @cip/teams-bot
Verify: pnpm --filter @cip/teams-bot typecheck && pnpm -r run typecheck

Prerequisite: Slice 35 must be complete. This slice consumes its
GET /admin/tenants/by-aad/:aadTenantId endpoint.

Read before writing:
- CLAUDE.md
- slices/SLICE_36_MULTI_TENANT_BOT.md   (this slice's full spec)
- slices/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md   § "HTTP Endpoints"
- slices/CROSS_SLICE_NOTES.md
- docs/users-roles-auth-normalization-plan.md

Goal: Bot resolves the AAD tenant ID on each incoming activity, looks up
the matching CIP tenant via hr-service, binds a TenantContext for that
request, and uses per-realm KC client secrets for the JWT-AG exchange.
Reject messages from unknown or inactive tenants with [security] log
lines. Six-step pipeline: extract → resolve → validate → bind → exchange
→ downstream.

Files to create:
- packages/teams-bot/src/auth/tenant-resolver.ts
- packages/teams-bot/src/auth/keycloak-secrets.ts

Files to modify:
- packages/teams-bot/src/bot.ts
    onMessage: resolve tenant BEFORE token check
    onSigninInvokeActivity: resolve tenant BEFORE token exchange
    handleAuthenticatedMessage: take TenantContext as a parameter
    exchangeAadForKeycloak: signature change, takes TenantContext (no env)
- packages/teams-bot/src/auth/resolve-context.ts
    Take TenantContext, use ctx.cipTenantId (NOT channelData.tenant.id)
- packages/teams-bot/helm/values.yaml
    Add HR_SERVICE_URL, KEYCLOAK_REALM_FALLBACK; document KEYCLOAK_CLIENT_SECRETS
    JSON-map secret + PLATFORM_ADMIN_TOKEN secret

Hard rules (Seven Non-Negotiables):
- AAD tenant ID (from activity.channelData.tenant.id) is NOT the CIP tenant ID
- Reject every failure mode: missing AAD tenant, no matching CIP tenant,
  inactive tenant, no enabled aad_oidc provider, no client secret available
- 5-minute cache TTL on the tenant lookup; key = AAD tenant ID
- All log lines in the message-handling pipeline include cipTenantId
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function has a working body

Acceptance: see "Acceptance Criteria" in SLICE_36_MULTI_TENANT_BOT.md.

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(36): multi-tenant bot — AAD tenant resolution + per-realm KC secrets
```

---

## PROMPT Slice 43 — Remove the hardcoded category layer

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 43 — Remove the hardcoded category layer
Package: @cip/teams-bot, @cip/shared, @cip/hr-service
Verify: pnpm --filter @cip/teams-bot typecheck
        pnpm --filter @cip/shared typecheck
        pnpm --filter @cip/hr-service typecheck

Prerequisite: Slice 39B + 41 deployed. Bot is on b240cb8 (post-crash-fix).

Read before writing:
- CLAUDE.md
- slices/SLICE_43_REMOVE_CATEGORY_LAYER.md   (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- packages/teams-bot/src/intent/tool-categories.ts  (heavy delete)
- packages/teams-bot/src/intent/classifier.ts
- packages/teams-bot/src/intent/router.ts
- packages/teams-bot/src/bot.ts
- packages/shared/src/clients/prompts/bot-intent-classify.ts
- packages/shared/src/clients/prompts/index.ts
- packages/teams-bot/src/mcp/tool-discovery.ts
- One sample MCP tool registration per module (cert/employee/admin/compliance) to inform the description sweep

Goal: collapse the six-label intent enum to three (chitchat/meta/proceed),
delete the per-category Stage-2 tool maps and aliases, restore an
LLM-composed meta reply via a dedicated meta_compose call, sweep every
hr-service tool description to the scope/audience/output shape with
requiredPermission annotations, and fix the discoverTools cache key
bug (was tenant-keyed → must be tenant+user).

Files to create:
- packages/teams-bot/src/intent/meta-compose.ts
- packages/shared/src/clients/prompts/bot-meta-compose.ts
- packages/hr-service/src/db/migrations/014_routing_rules_collapse.sql

Files to modify:
- packages/teams-bot/src/intent/tool-categories.ts  (delete most; keep 3-intent enum + availableIntents helper)
- packages/teams-bot/src/intent/classifier.ts       (3-label schema; resilient parse)
- packages/teams-bot/src/intent/router.ts           (single alias=route, full permitted catalog)
- packages/teams-bot/src/intent/debug-banner.ts     (rename category → intent)
- packages/teams-bot/src/intent/alias-resolver.ts   (purpose name updates)
- packages/teams-bot/src/bot.ts                     (drop filter; meta calls meta_compose)
- packages/teams-bot/src/mcp/tool-discovery.ts      (cache key includes employeeId)
- packages/shared/src/clients/prompts/bot-intent-classify.ts  (3-label prompt)
- packages/shared/src/clients/prompts/index.ts                (register meta-compose)
- packages/hr-service/src/modules/**/mcp-tools/*.ts  (~30 tools — description + requiredPermission annotation)

Hard rules (Seven Non-Negotiables):
- tenantId: string (not optional) on every domain interface — unchanged
- No hand-curated tool registries. Routing decisions derive from MCP
  tool metadata at runtime
- Every server.tool() carries requiredPermission annotation (use null
  explicitly when unrestricted)
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body
- Re-seed Langfuse as part of deploy (bot.intent_classify and the new
  bot.meta_compose); the seed script is idempotent on no-change

Tool description shape (mandatory): scope + audience + output +
sibling-disambiguation. Phrasing examples are tiebreakers, not the
primary lever. See SLICE_43 doc for the role_list reference example.

Acceptance: see "Verification" in SLICE_43_REMOVE_CATEGORY_LAYER.md
(canonical query smoke tests + cost regression check).

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(43): remove hardcoded category layer; full-catalog function calling
```

---

## PROMPT Slice 44 — Tool catalog embeddings (vector retrieval pre-filter)

```
You are working on the CIP Platform TypeScript monorepo.

Session: Slice 44 — Tool catalog embeddings (vector retrieval pre-filter)
Package: @cip/hr-service, @cip/teams-bot, @cip/shared
Verify: pnpm --filter @cip/hr-service typecheck
        pnpm --filter @cip/teams-bot typecheck
        pnpm --filter @cip/shared typecheck

Prerequisite: Slice 43 complete. Tool descriptions follow the
scope/audience/output shape; requiredPermission annotations on every
tool; intent pipeline is chitchat|meta|proceed with single `route` alias.

Read before writing:
- CLAUDE.md
- slices/SLICE_44_TOOL_EMBEDDINGS.md           (this slice's full spec)
- slices/CROSS_SLICE_NOTES.md
- packages/hr-service/src/db/migrations/003_ai_memory.sql  (pgvector pattern reference — agent_memory_vectors)
- packages/hr-service/src/services/permission-catalog-seed.ts  (idempotent seed pattern reference)
- packages/hr-service/src/main.ts             (add seed call)
- packages/teams-bot/src/mcp/tool-discovery.ts (insert retrieval step)
- packages/teams-bot/src/bot.ts                (pass message into discoverTools)
- packages/shared/src/clients/litellm.ts       (add embedding helper if missing)

Goal: add a tool_embeddings table (pgvector, HNSW cosine), an idempotent
indexer that runs on hr-service startup (re-embeds only on
description_hash change — zero API calls on no-op restart), and a
top-K retrieval step in discoverTools (between permission filter and
router LLM). Embedding via cip-embed alias → mistral-embed.

Files to create:
- packages/hr-service/src/db/migrations/015_tool_embeddings.sql
- packages/hr-service/src/services/tool-embeddings-seed.ts
- packages/teams-bot/src/intent/embed-cache.ts  (LRU 256/60s)

Files to modify:
- packages/hr-service/src/main.ts                  (call seedToolEmbeddings after seedPermissionCatalog)
- packages/teams-bot/src/mcp/tool-discovery.ts     (retrieval step + cache stores permission-filtered list, not retrieval result)
- packages/teams-bot/src/bot.ts                    (pass user message text into discoverTools)
- packages/shared/src/clients/litellm.ts           (embedding helper if missing)

Hard rules (Seven Non-Negotiables):
- tool_embeddings is the ONLY table that's not tenant-scoped — tools
  are defined by service code, not data. Document this in the migration.
- description_hash MUST be deterministic: sha256(name + ' ' + description
  + ' ' + JSON.stringify(paramSchema)). Stable across pod restarts.
- Indexer MUST be idempotent. Re-runs without description changes do
  zero embedding API calls (verify via the [tool-embeddings] log line).
- Indexer MUST clean up orphans (tools removed from code) in the same
  transaction as the upsert pass — partial registry never wipes embeddings.
- Multi-replica safe: ON CONFLICT (service, tool_name) DO UPDATE
  WHERE EXCLUDED.description_hash <> tool_embeddings.description_hash
- discoverTools MUST handle empty tool_embeddings (first deploy before
  the indexer runs) — fall back to full permission-filtered list silently
- discoverTools MUST handle empty intersection (no permitted tool ranks
  in top K) — fall back to full permission-filtered list silently
- No @anthropic-ai/sdk imports
- Stubs forbidden — every function ships with a working body

Acceptance: see "Verification" in SLICE_44_TOOL_EMBEDDINGS.md
(indexer smoke test + retrieval correctness query table + cost/latency
regression check).

If a finding requires changing earlier slice output: log a cross-slice
note per slices/CROSS_SLICE_NOTES.md and continue. Do not refactor
outside this slice.

Commit: slice(44): tool embeddings + vector retrieval pre-filter
```

---

# Slice 00 — Platform Orientation

> **Session type:** Reading only. No Claude Code. No code changes.  
> **Goal:** Build a mental model of how all pieces connect before touching any code.

---

## The Core Loop (read this until it is automatic)

```
Teams Bot  ──upload──▶  NATS event
                              │
                              ▼
                   Temporal: CertificationProcessingWorkflow
                              │
                    ┌─────────┴──────────────────────┐
                    │                                 │
                    ▼                                 ▼
           Activity: fetch-document        Activity: pre-classify-cert
                    │
                    ▼
           Activity: run-vision-agent
               └── LangGraph VisionAgent
                       └── LiteLLM ──▶ Anthropic Claude
                              │
                    confidence < threshold?
                    ├── YES: Temporal Signal ──▶ HITL (Teams Bot prompt)
                    └── NO: Activity: validate-extraction (Zod)
                                   │
                                   ▼
                           Activity: persist-cert (PostgreSQL + RLS)
                                   │
                                   ▼
                        NATS event: cert.processed.v1
                                   │
                                   ▼
                          Ambient Watcher reacts
```

---

## Package Dependency Graph

```
@cip/shared          ◀── everything imports this; it imports nothing internal
    ▲
    ├── @cip/hr-service       (domain: certs, workers, vision agent)
    ├── @cip/platform-core    (domain: tenant provisioning)
    ├── @cip/teams-bot        (UX: Microsoft Teams adapter)
    └── @cip/infra            (ops: OVH cluster scripts)
```

`@cip/shared` must compile before any other package. It contains:
- **Types** — all domain types, agent state, event payloads, workflow I/O
- **Clients** — LiteLLM, Langfuse, Temporal, NATS, PostgreSQL factories
- **Utils** — tenant context, NATS subject builder, Zod schemas

---

## Infrastructure Stack (what runs in K8s)

| Component | Namespace | Purpose |
|-----------|-----------|---------|
| PostgreSQL | `cip-infra` | HR domain DB + Platform DB; RLS enforced |
| NATS JetStream | `cip-infra` | Event bus; per-tenant subjects |
| Keycloak | `cip-infra` | Auth; per-tenant realms |
| LiteLLM Proxy | `cip-app` | Single gateway for all LLM calls |
| Langfuse | `cip-app` | Observability; per-tenant trace attribution |
| HR Service | `cip-app` | Temporal worker + Express + MCP server |
| Platform Core | `cip-app` | Tenant provisioning API + Temporal worker |
| Teams Bot | `cip-app` | Bot Framework adapter |

OVH hosts the Kubernetes cluster. The node pool scales to 0 overnight (cost control). PVCs persist through scale-down. Temporal is **cloud-hosted** (not in-cluster).

---

## Tenant Isolation Model

Every piece of data is scoped to a `tenantId` (UUID):

```
Database:   WHERE tenant_id = $1   (PostgreSQL RLS policy)
NATS:       cip.{tenantId}.cert.uploaded.v1   (subject prefix)
Temporal:   workflowId = "CertProcess-{tenantId}-{certId}"
AgentState: { tenantId: string, ... }   (every state object)
LiteLLM:    virtual key per tenant (issued at provisioning)
Langfuse:   tags: { tenant: tenantId }
```

A new tenant is created by the `TenantProvisioningWorkflow` in `platform-core`. It provisions all of the above atomically.

---

## LLM Call Path (always)

```
Service code
  └── createLiteLLMClient()    ← from @cip/shared/clients/litellm.ts
          └── LiteLLM proxy    ← HTTP, OpenAI-compatible API
                  └── Anthropic API   ← real key lives ONLY here
```

**No service ever imports `@anthropic-ai/sdk` directly.** This is enforced by the architecture (only LiteLLM has the API key) and by convention (ESLint can add a no-restricted-imports rule if desired).

---

## Files to Read Next

After this orientation, your first coding slice is `SLICE_01_WORKSPACE_ROOT.md`. Before starting that, optionally skim:

- `CIP_Platform_Architecture_v1_0.docx` — system context and design decisions
- `CIP_Integration_Wiring_v0_2.docx` — service-to-service wiring details  
- `CIP_Dev_Environment_Setup_v0_4.docx` — how to get the cluster running locally

---

## Questions to Have Answered Before Slice 2

Work through these yourself before generating any shared types code:

- [ ] What fields does a `Certification` record need? (Type, issuer, expiry, worker ID, document URL, confidence score, status)
- [ ] What does `TenantContext` need to carry? (tenantId, tenantConfig, user identity from JWT)
- [ ] What events flow over NATS? (cert.uploaded, cert.processed, cert.expired, worker.onboarded, compliance.drifted)
- [ ] What is the shape of `VisionAgentState`? (input doc, extraction result, confidence, hitl flag, tenantId)
- [ ] What does a Temporal workflow input/output look like? (strongly typed, Zod-validated structs)

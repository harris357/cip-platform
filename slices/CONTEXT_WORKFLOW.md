# CIP Platform — Slice Map

> One slice = one focused session. Work in order. Later slices depend on earlier ones compiling.

---

## Slice Map

| # | Slice | Doc | Status |
|---|-------|-----|--------|
| 22 | Cleanup & Doc Reset | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 23 | HR Persistence Layer + Migration Runner | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 24 | Cert Vertical Activities | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 25 | Employee Onboarding Activities | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 26 | Channel Registry on NATS KV (resolves CS-018) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 27 | Platform-Core Tenant Provisioning + Wiring Reconciliation | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 28 | CI/CD & Image Pipeline | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 29 | First Deploy Runbook (operational) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 30 | Teams App Registration & Sideload (operational) | [PROMPTS_DEPLOY.md](./PROMPTS_DEPLOY.md) | COMPLETE |
| 31 | Employee Admin Provisioning Endpoint | [archive/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md](./archive/SLICE_31_EMPLOYEE_ADMIN_PROVISIONING.md) | COMPLETE |
| 32 | Realm Roles + Auth Context + HR Audit Table | [archive/SLICE_32_REALM_ROLES_AND_AUDIT.md](./archive/SLICE_32_REALM_ROLES_AND_AUDIT.md) | COMPLETE |
| 33 | HR MCP Tools + Identity Migration + Disable Workflows | [archive/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md](./archive/SLICE_33_HR_MCP_TOOLS_AND_MIGRATION.md) | COMPLETE |
| 35 | Tenants + Tenant Identity Providers Tables | [archive/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md](./archive/SLICE_35_TENANTS_AND_IDENTITY_PROVIDERS.md) | COMPLETE |
| 36 | Multi-Tenant Teams Bot (in-code routing) | [archive/SLICE_36_MULTI_TENANT_BOT.md](./archive/SLICE_36_MULTI_TENANT_BOT.md) | COMPLETE |
| 37 | Per-Tenant KC Client Secrets via K8s Secrets | [archive/SLICE_37_PER_TENANT_KC_SECRETS.md](./archive/SLICE_37_PER_TENANT_KC_SECRETS.md) | COMPLETE |
| 38 | Module-Level Permissions (renames "capabilities") | [archive/SLICE_38_PERMISSIONS.md](./archive/SLICE_38_PERMISSIONS.md) | COMPLETE |
| 39A | Per-Purpose LLM Routing Foundation | [SLICE_39A_PER_PURPOSE_ROUTING.md](./SLICE_39A_PER_PURPOSE_ROUTING.md) | COMPLETE |
| 39B | LLM-as-Classifier in the Bot | [SLICE_39B_BOT_CLASSIFIER.md](./SLICE_39B_BOT_CLASSIFIER.md) | COMPLETE |
| 40 | LiteLLM Tier Governance via provision-tenant.sh | [SLICE_40_LITELLM_TIER_GOVERNANCE.md](./SLICE_40_LITELLM_TIER_GOVERNANCE.md) | COMPLETE |
| 41 | Langfuse-hosted Prompts | [SLICE_41_LANGFUSE_PROMPTS.md](./SLICE_41_LANGFUSE_PROMPTS.md) | COMPLETE |
| 42A | Permission Groups (rename roles + module + catalog + globs) | [SLICE_42A_PERMISSION_GROUPS_SCHEMA.md](./SLICE_42A_PERMISSION_GROUPS_SCHEMA.md) | PENDING |
| 42C | Role Layer (cross-module composition over groups) | [SLICE_42C_ROLES_LAYER.md](./SLICE_42C_ROLES_LAYER.md) | PENDING |
| 42B | Admin User Bootstrap (PLATFORM_ADMIN_EMAIL → admin role + hr realm role) | [SLICE_42B_ADMIN_USER_BOOTSTRAP.md](./SLICE_42B_ADMIN_USER_BOOTSTRAP.md) | PENDING |

All slices 01–21 are complete — see [archive/](./archive/). Slices 31, 32,
33, 35, 36, 37, 38 completed during the auth/multi-tenant + permissions
work and have been moved to [archive/](./archive/) too; their prompts are
kept in [PROMPTS_ALL.md](./PROMPTS_ALL.md) under the "Archived prompts"
section for reference.

---

## Dependency Order

Only pending slices shown. Completed slices are archived.

```
COMPLETE: 22 ──► 23 ──► 24
                  └─► 25 ──► 32 ──► 31 ──► 33 ──► 38 ──► 39A ──► 39B
                                            └─► 35 ──► 36 ──► 37     └─► 40, 41
                  └─► 26          └─► 27       └─► 28

PENDING:    42A ──► 42C ──► 42B
            (groups + module + catalog + globs)
                  ──► (role layer composing groups)
                       ──► (admin bootstrap via PLATFORM_ADMIN_EMAIL)
```

### Shipped

- **Slice 42A / 42B / 42C** — RBAC hierarchy: permission catalog +
  permission groups (single-module) → roles (cross-module composition)
  → admin user auto-bootstrap. Eight admin read tools shipped (role_*,
  group_*, permission_holders, audit_log_list, employee_get).
  See `slices/archive/SLICE_42A_*.md`, `42B_*.md`, `42C_*.md`.
- **Slice 43** — Removed the hardcoded category layer. Three intents
  (chitchat/meta/proceed). Single `route` alias over the full permitted
  catalog. LLM-composed meta replies via `meta_compose`. Tool
  descriptions rewritten to scope/audience/output/sibling shape.
  `discoverTools` cache keyed by tenant+user. See
  `slices/archive/SLICE_43_REMOVE_CATEGORY_LAYER.md`.
- **Slice 44** — Tool catalog embeddings + vector retrieval pre-filter
  via `/admin/tool-retrieval` endpoint. pgvector (HNSW dropped — Zen 3
  doesn't support AVX-512; sequential scan over ~30 rows is sub-ms) +
  idempotent startup indexer. Bot caches retrieval responses by
  message-text hash. See `slices/archive/SLICE_44_TOOL_EMBEDDINGS.md`.
- **Slice 45** — Parallel LangGraph runtime alongside the legacy
  classifier+router pipeline. Per-thread toggle via `/lg on`. Triage
  node (cip-classifier) → plan node (cip-router-careful) → tool loop
  with write-action confirmation gate. `bot_tunables` table with seven
  seeded global defaults. Capability metadata sweep (~29 tools): added
  `sideEffectLevel`, `whenToUse[]`, `whenNotToUse[]`,
  `commonNextTools[]`, `outputSchema` to every tool annotation.
  In-process MemorySaver checkpointer. Default engine: `legacy`.
  See `slices/archive/SLICE_45_LANGGRAPH_PARALLEL_RUNTIME.md`.
- **Slice 47** — Role-aware slash commands + `suggestedActions` chips.
  Slash command registry as single source of truth (replaced inline
  `/lg` handling). `/help` filters the registry by caller permissions
  and renders a markdown menu. Welcome message gains universal chips
  (auth context not yet available at welcome time). Manifest
  `commandLists` updated with universal slashes only; admin commands
  surface via role-filtered `/help`.
  See `slices/archive/SLICE_47_SLASH_COMMANDS_AND_SUGGESTED_ACTIONS.md`.

### Drafted, not yet shipped

- **Slice 46** — Durable LangGraph state. Replaces in-process
  MemorySaver with PostgresSaver (multi-replica, restart-safe). Adds
  LLM-driven `summarize` node (compresses older messages once
  `messages.length > lg.summarize_at`, default 12). Persists per-thread
  engine override in a new `bot_engine_overrides` table so `/lg on`
  survives pod restarts. Three new tunables seeded.
  See `slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md`.

### Proposed (not yet drafted)

- **Slice 48** — Telemetry dashboard for both runtimes. Aggregates the
  structured `[turn]` log lines (engine, intent, tools attempted,
  blocked, refused, step count, clarification rate, confirmation rate,
  per-stage latency) into a queryable surface for tuning + regression
  detection. Likely Grafana over Loki/Postgres.
- **Slice 49** — Long-term factual memory across threads. New
  `bot_memory` table keyed `(tenant_id, employee_id, key)` for
  user-specific facts (preferences, last actions, durable state).
  Loaded into LangGraph state at turn start; populated by tools or a
  post-turn extractor. No vector — keyed lookups only.
- **Slice 50** — Vector retrieval over past conversations. Post-turn
  extraction pipeline distills durable facts from each thread, embeds
  via `cip-embed`, stores in a new `bot_conversation_memory` table or
  reuses `agent_memory_vectors`. Per-turn semantic search injects
  relevant memories into the planner prompt. Heavy lift — wait until
  we see actual usage demand.

### Removing the legacy pipeline

Gated on 2+ weeks of LangGraph toggle traffic with no regressions vs
legacy. After Slice 46 ships and we have at least one tenant defaulted
to `langgraph` in `bot_tunables`, we'll have data. Until then, both
runtimes coexist.

#### Earlier upcoming slices (legacy, may already be obsolete)

- **Slice 39B** — LLM-as-Classifier in the Bot. **Superseded by
  Slice 43** — the category layer it introduced has been removed in
  favour of full-catalog function calling.

---

## The Seven Non-Negotiables

Enforce in every session. Fail the session if any are violated.

1. `tenantId: string` on every domain interface, DB table, agent state, Temporal workflow ID
2. No `import` from `@anthropic-ai/sdk` anywhere — all LLM calls go via LiteLLM
3. NATS subjects only via `Subjects.*` or `buildSubject()` from `@cip/shared`
4. Every `workflow.start()` has `workflowId: \`{type}-${tenantId}-${entityId}\`` + comment
5. Every Temporal Activity validates output with Zod `.parse()` before returning
6. No MCP tool input schema contains `tenantId` — always from `authInfo.token`
7. Stubs use `throw new Error('not implemented')` — never `return undefined as any`

---

## Module Structure Rule

All hr-service business logic lives inside its module:

```
packages/hr-service/src/modules/
  certifications/    workflows/ activities/ agents/ mcp-tools/ cards/
  employees/         workflows/ activities/ mcp-tools/ cards/
  compliance/        mcp-tools/ cards/
```

Nothing from one module imports from another module. Cross-module access goes via
the shared DB layer or NATS events — never direct imports.

---

## Cross-Slice Protocol

1. Finish the current slice with the correct types even if typecheck fails on an earlier package
2. Log the issue in [CROSS_SLICE_NOTES.md](./CROSS_SLICE_NOTES.md)
3. Run `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` to resolve all open notes before the next slice

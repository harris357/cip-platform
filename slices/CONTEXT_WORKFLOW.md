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
  surface via role-filtered `/help`. `deploy.ts` generates manifest
  commandLists from REGISTRY at build time.
  See `slices/archive/SLICE_47_SLASH_COMMANDS_AND_SUGGESTED_ACTIONS.md`.
- **Slice 47b** — Removed legacy classifier+router pipeline + `/lg`
  toggle. LangGraph is now the only runtime. Deleted: `intent/`
  classifier, router, meta-compose, tool-categories, engine-toggle;
  `slash-commands/handlers/lg.ts`; shared prompts `bot-intent-classify`,
  `bot-meta-compose`; legacy `maybeSendDebugBanner` debug banner.
  Added `/about` command showing build SHA, runtime, tenant, roles,
  permission count. Pod ~30% smaller. `lg.default_engine` tunable
  retained as no-op (unused; bot always runs LangGraph).

### Shipped (recent)

- **Slice 45c** — LangChain/LangGraph 1.x + openai 6.x upgrade
  (shipped 2026-05-01 in commit `fbf957b`). Bumped LangGraph 0.2 → 1.2,
  core 0.3 → 1.1, openai 4 → 6. Installed
  `@langchain/langgraph-checkpoint-postgres@^1.0.1` (reused in 46 + 49).
  See `slices/SLICE_45C_DEPENDENCY_UPGRADE.md`.

- **Slice 46** — Durable LangGraph state + LLM summarization
  (shipped 2026-05-01 in commit `fbf957b`). `PostgresSaver` replaces
  `MemorySaver`; `summarize` node compresses older messages once
  `messages.length > lg.summarize_at` (default 12). Three new tunables
  seeded. `DATABASE_URL_HR` wired into `teams-bot-credentials`.
  See `slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md`.

### Drafted, not yet shipped

All seven below have full slice docs and are ready to implement.
Recommended order: **45d → 46b → 46c → 48 → 49 → 51 → 52**.

- **Slice 45d** — Temporal SDK 1.16 → 1.17 routine bump.
  Standalone bump because workflow code is replay-sensitive — must land
  in isolation. Four `@temporalio/*` packages move together; verify
  with end-to-end smoke test of the disable-employee flow.
  See `slices/SLICE_45D_TEMPORAL_BUMP.md`.

- **Slice 46b** — Native `interrupt()` for write-action confirmation.
  Replaces the hand-rolled `pendingWriteCall` + ingest-resume pattern
  with LangGraph 1.x's first-class `interrupt()` + `Command({resume})`.
  Removes ~80 lines, kills a confusing dual-path through `ingest`,
  puts affirm/cancel logic inside `confirm` where it belongs.
  No state-shape additions; pure simplification.
  See `slices/SLICE_46B_NATIVE_INTERRUPT.md`.

- **Slice 46c** — Checkpoint hygiene: ephemeral `candidateTools` +
  retention cron. Custom serde dumps `candidateTools` as `null` so
  mid-turn checkpoints stay small. Nightly `CronJob` keeps the latest
  checkpoint per thread plus 24h history; everything else cleared.
  Prevents `checkpoint_blobs` from growing without bound.
  See `slices/SLICE_46C_CHECKPOINT_HYGIENE.md`.

- **Slice 48** — Langfuse graph traces + structured-log telemetry.
  Two parts that share the `turnId` join key:
  1. Wire `@langfuse/langchain` `CallbackHandler` into the LangGraph
     runner so every node + every LLM call shows up as nested spans in
     a single per-turn trace tree.
  2. Aggregate `[turn]` log lines into a `bot_turn_metrics` Postgres
     table + Grafana dashboard.

  Telemetry from this slice is the gating signal for Slice 52.
  See `slices/SLICE_48_LANGFUSE_TRACES_AND_TELEMETRY.md`.

- **Slice 49 (merged)** — Bot memory (factual + semantic) via LangGraph
  `PostgresStore`. Single store instance with two namespaces per user:
  `[tenantId, employeeId, "facts"]` for keyed prefs/notes, and
  `[tenantId, employeeId, "convo"]` for embedded conversation snippets.
  `loadMemory` node hydrates both before `triage`. `extractMemory` runs
  AFTER `respond` (off the user-facing critical path). `set_user_preference`
  MCP tool for explicit user intent. Convo retrieval is OFF by default
  (`lg.memory_convo_enabled = false`) until Slice 48 telemetry justifies
  it. Replaces the original Slice 49 + Slice 50 drafts (archived).
  See `slices/SLICE_49_BOT_MEMORY.md`.

- **Slice 51** — LangGraph Studio for local dev visualization.
  Dev-only tooling. `langgraph.json` + `studio-entry.ts` stub +
  `pnpm studio` script. No production behavior change. Studio
  connects to a separate `cip_hr_studio` local DB; never points at
  production.
  See `slices/SLICE_51_LANGGRAPH_STUDIO.md`.

- **Slice 52** — Streaming partial responses to Teams. **GATED on
  Slice 48 telemetry** — only ship if p95 turn latency proves to
  warrant the perceived-latency win. Default mode `typing` (just the
  indicator); optional `progress` mode for tool-loop turns. Per-tenant
  kill switch via `lg.streaming_mode = 'none'`.
  See `slices/SLICE_52_TEAMS_STREAMING.md`.

### Proposed (not yet drafted)

(None currently.)

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

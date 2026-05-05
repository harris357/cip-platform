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

- **Slice 45c** (2026-05-01, `fbf957b`) — LangChain/LangGraph 1.x +
  openai 6.x upgrade. See `slices/SLICE_45C_DEPENDENCY_UPGRADE.md`.

- **Slice 46** (2026-05-01, `fbf957b`) — Durable LangGraph state +
  LLM summarization (PostgresSaver + summarize node). See
  `slices/SLICE_46_DURABLE_LANGGRAPH_STATE.md`.

- **Tool-annotation hotfix** (2026-05-01, `11c67ce`) — MCP SDK was
  stripping non-spec annotation fields, breaking the write-confirm
  gate + permission filter in production. Added
  `/admin/tool-metadata` side channel; bot merges back at discovery.
  Strengthened `sync_employee` description + bot.plan honesty rule.

- **Slice 45d** (2026-05-01, `76f6d8e`) — Temporal SDK 1.16 → 1.17.
  See `slices/SLICE_45D_TEMPORAL_BUMP.md`.

- **Slice 46b** (2026-05-01, `cded50e`) — Native `interrupt()` for
  write-action confirmation. Removed `routeAfterIngest`, simplified
  ingest, runner detects via `getState().tasks` and resumes with
  `Command({resume})`. New `resumed=` field in `[turn]` log.
  See `slices/SLICE_46B_NATIVE_INTERRUPT.md`.

- **Slice 46c parts 3+5** (2026-05-01, `1fee9f9`) — Parallel tool
  execution via `Promise.all` + Mistral prompt-cache visibility
  (`[llm-cache]` log lines). Part 4 (async durability) inherited
  free from 1.x default. Parts 1+2 deferred to 46d.
  See `slices/SLICE_46C_CHECKPOINT_HYGIENE.md`.

- **Slice 48** (2026-05-01, `f0213f1`) — Langfuse `CallbackHandler` +
  `bot_turn_metrics` Postgres table. Per-turn trace tree keyed by
  turnId; metrics filling for SQL-based perf debugging.
  See `slices/SLICE_48_LANGFUSE_TRACES_AND_TELEMETRY.md` and the
  runbook at `slices/BOT_PERF_DEBUGGING.md`.

- **Slice 52** (2026-05-01, `3caadda`) — Typing-indicator refresh
  for long turns. New `lg.streaming_mode` tunable (default `typing`).
  See `slices/SLICE_52_TEAMS_STREAMING.md`.

- **Slice 46d** (2026-05-01, `1b3585f`) — Ephemeral `candidateTools`
  (removed from state — Option B path: discoverTools called per-node
  with cache instead of UntrackedValue migration) + nightly retention
  CronJob (`gc.ts`) for `checkpoints`, `checkpoint_writes`, and
  `bot_turn_metrics` (90-day retention). Verified: first GC run
  trimmed checkpoints 252→10.

- **Slice 46e** (2026-05-01, `1b3585f` + followups) — Admin MCP tools
  for `bot_turn_metrics` + clickable turn footer. Five tools shipped:
  `bot_metrics_get_turn`, `_summary`, `_top_n`, `_tools`, `_outliers`,
  gated on new `bot.metrics.read` permission. `/turn <id>` slash
  command live; adaptive-card footer with "🔍 Inspect" Action.Submit.
  Followups: Langfuse trace + session deep-links via Langfuse public
  API; `(pending)` rendering for null-cost; sub-cent cost formatting.

- **Slice 48 followups** (2026-05-01, `f0213f1` → `8a7aeb9` →
  `ec04e76`) — OTEL bootstrap (`@opentelemetry/sdk-node` +
  `LangfuseSpanProcessor` in `instrumentation.ts`) so Langfuse 5.x
  traces actually flow. Session-id rotation in `ingest` on idle >
  `lg.session_timeout_minutes` (default 60). `callLLM` forwards
  `metadata.session_id` + `metadata.trace_id` so LiteLLM-side LLM
  generations join our session aggregate. Verified live: per-session
  cost now non-null in `/turn` output.

### Drafted, not yet shipped

Recommended order: **55 → 56 → 53 → 49 → 51 → 58A→B→C→D→E (cert E2E) → 58F/G → 58H/I**.

#### Slice 58 — Generic document workflow (`@cip/document-service`)

End-to-end testable on Teams after **58A → 58E**. F/G are
operational follow-ons; H/I are growth investments.

| Slice | Doc | Status |
|---|---|---|
| **58A** — `@cip/document-service` foundation (schema, ClamAV, RLS, perms, contract, lifecycle) | [SLICE_58A_DOCUMENT_SERVICE_FOUNDATION.md](./SLICE_58A_DOCUMENT_SERVICE_FOUNDATION.md) | IN PROGRESS |
| **58B** — Ingest path (bot wiring + scan + features + sensitivity + workflow + bot-progress channel) | [SLICE_58B_INGEST_SCAN_FEATURES.md](./SLICE_58B_INGEST_SCAN_FEATURES.md) | DRAFTED |
| **58C** — Classification + per-type extraction strategy (cert as first consumer) | [SLICE_58C_CLASSIFY_AND_EXTRACT.md](./SLICE_58C_CLASSIFY_AND_EXTRACT.md) | DRAFTED |
| **58D** — Subject resolution + HITL admin queue | [SLICE_58D_SUBJECT_RESOLUTION.md](./SLICE_58D_SUBJECT_RESOLUTION.md) | DRAFTED |
| **58E** — Routing handoff + cert workflow as Route-A consumer + legacy removal | [SLICE_58E_ROUTING_AND_CERT_MIGRATION.md](./SLICE_58E_ROUTING_AND_CERT_MIGRATION.md) | DRAFTED |
| **58F** — Reclassification (phase-loop refactor of 58B + uploader self-serve in-flight + admin-approved post-route + revokeFor) | [SLICE_58F_RECLASSIFICATION.md](./SLICE_58F_RECLASSIFICATION.md) | DRAFTED |
| **58G** — Soft-delete, hard-purge cron, audit retention 7y, GDPR strict erasure mode, restore semantics | [SLICE_58G_PURGE_AND_RETENTION.md](./SLICE_58G_PURGE_AND_RETENTION.md) | DRAFTED |
| **58H** — Per-tenant doc-type sklearn classifier (mirrors 56N; trust ladder from 56L; sklearn-first in 58C with LLM fallback) | [SLICE_58H_PER_TENANT_DOC_CLASSIFIER.md](./SLICE_58H_PER_TENANT_DOC_CLASSIFIER.md) | DRAFTED |
| **58I** — Cert template-and-compare (canonical template versioning + auto-derive via DBSCAN + field-rule diff HITL) | [SLICE_58I_CERT_TEMPLATE_COMPARE.md](./SLICE_58I_CERT_TEMPLATE_COMPARE.md) | DRAFTED |

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

- **Slice 53** — Card-driven write-action confirm + invoke router.
  Replaces the Slice 46b text "Reply yes/no." with an Adaptive Card
  (`Action.Execute` `[Confirm] [Cancel]`). Lays the verb-dispatched
  invoke router that future card flows (cert submit dialog,
  employee-detail action panel) will register against. Three new
  tunables (`lg.confirm_render_mode` default `"card"`,
  `lg.confirm_card_ttl_seconds`, `lg.confirm_card_max_arg_chars`).
  Per-tenant kill switch back to text via render-mode tunable. No
  state-shape change; same `interrupt()` mechanism as 46b.
  See `slices/SLICE_53_CARD_CONFIRM.md`.

- **Slice 55** — Per-tool argument extraction framework + grammar
  router. **Ships before Slice 56.** TypeScript `Extractor` interface
  + registry. Auth-derived helpers (caller_id), DB-resolution helpers
  (employee name → id, role lookup). Concrete extractors for the top
  ~10 high-volume tools. Deterministic regex grammar router as a
  graph node before triage — templated requests skip the planner
  entirely. Disambiguation card (multi-match DB resolution) +
  templated clarification (missing args). Three low-effort training-
  data entry paths: committed CSV in repo, `/teach` admin slash
  command, "Add to training set" action on `/turn` cards. Nine new
  Make commands for extractor + training-data lifecycle. Per-tenant
  kill switch via `lg.grammar_router_enabled = false`.
  See `slices/SLICE_55_ARG_EXTRACTION_FRAMEWORK.md`.

- **Slice 56** — Sklearn intent router (depends on Slice 55). New
  `intent-classifier` Python service (FastAPI + TfidfVectorizer +
  LogisticRegression). New `classify` graph node before triage.
  Reuses Slice 55's extractor framework. Five-way routing decision
  (fallthrough / clarify / skip / disambiguate / narrow_plan).
  Phased rollout: shadow → clarify+disambiguate → narrow_plan →
  skip. Captures `(text, intent, was_correct)` for retraining via
  the `correction_in_next_turn` analyzer. Per-tenant kill switch via
  `lg.classifier_enabled = false`.
  See `slices/SLICE_56_SKLEARN_INTENT_ROUTER.md`.

### Proposed (not yet drafted)

- **Slice 54** — Rich-UI follow-on to 53: cert-submission Dialog
  (`task/fetch` + `task/submit`) and employee-detail card with
  `[Disable] [Reassign role] [View certs]` `Action.Execute` panel.
  Reuses the Slice 53 invoke router by registering new verbs.
  Domain card definitions live in
  `packages/hr-service/src/modules/{certifications,employees}/cards/`.

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

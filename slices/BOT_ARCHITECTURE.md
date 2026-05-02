# Teams bot architecture

> A reference for newcomers to the codebase. Covers the full conversation lifecycle, MCP tool routing, auth, state persistence, and observability. Pairs with [LANGGRAPH_ARCHITECTURE.md](LANGGRAPH_ARCHITECTURE.md) (auto-generated graph topology) and [BOT_PERF_DEBUGGING.md](BOT_PERF_DEBUGGING.md) (operational playbook).
> **Last updated:** 2026-05-02. When you make a structural change, update this doc.

---

## What the bot does

A multi-tenant Microsoft Teams bot for HR / compliance workflows. Users chat with it; it answers questions about employees, roles, certifications, and compliance, and can take actions (disable an employee, assign a role, etc.) gated by per-tenant permissions.

Under the hood it runs a **LangGraph** agent that classifies intent, plans tool calls against a curated MCP catalog, gates write actions for confirmation, executes tools against `hr-service`, and replies — with full Langfuse trace coverage so an admin can audit every turn.

## Five things to remember

1. **Tenancy is non-negotiable.** Every database row, every Temporal workflow, every Langfuse trace is scoped by `tenantId` derived from the caller's JWT. There are no cross-tenant operations and no tenant-id arguments on tools.
2. **MCP custom annotations are stripped on the wire.** `requiredPermission`, `sideEffectLevel`, etc. travel via a side-channel HTTP endpoint (`/admin/tool-metadata`), NOT via `client.listTools()`. Anything reading `tool.annotations.X` must merge from the side channel first.
3. **State persists in Postgres**, not memory. `PostgresSaver` keeps thread state across pod restarts and replicas. Mid-turn checkpoint writes are async; suspended-at-`interrupt()` checkpoints are sync.
4. **Two trace pipelines, one tree.** LangChain (graph spans) and LiteLLM (LLM generations) are two separate Langfuse trace pipelines. They get joined via `metadata.session_id` + `metadata.trace_id` that `callLLM` injects on every LLM call. Without that, costs live in disconnected `litellm-acompletion` traces.
5. **`turnId` is the join key everywhere.** Teams footer → `[turn]` log line → `bot_turn_metrics` row → Langfuse trace name. If you can copy that 8-char hex out of any of those four surfaces, you can find everything else.

---

## End-to-end request flow

```
Teams                            cip-app                                       cip-infra / cloud
─────                            ───────                                       ─────────────────
User msg
   │
   ▼
/api/messages
   │
   ▼
bot.ts (turn handler)
   │
   ├─► Activity.fromObject({type:'typing'})  ──────────────────────────────►   Teams
   │
   ▼
dispatchSlashCommand
   │
   ├─ slash hit ──► slash handler ──► sendActivity ──────────────────────►   Teams
   │
   └─ no slash
      │
      ▼
   resolveAuthContext
      │
      ├─► sync_employee (MCP, JWT-auth)         ───────────────────────►   hr-service /mcp
      ├─► get_employee_permissions (MCP)        ───────────────────────►   hr-service /mcp
      └─► getToolMetadata (HTTP, admin token)   ───────────────────────►   hr-service /admin/tool-metadata
      │
      ▼
   runLangGraph
      │
      ├─► graph.getState(config)                 ◄──────────────────────►   PostgresSaver (cip_hr.checkpoints)
      │      └─ detectInterrupt? ──► resume with Command({resume: text})
      │      └─ else                ──► fresh-state invoke
      │
      ├─► setInterval(typing, 4000ms)            ──────────────────────►   Teams
      │
      ▼
   graph.invoke
      │
      ├─► OTEL → @langfuse/langchain CallbackHandler ──────────────────►   cloud.langfuse.com
      │      (creates root trace turn-<id> with sessionId+userId)
      │
      ├─► ingest → triage → plan → gateWrite → confirm/execute → respond → maybe summarize
      │
      └─► every callLLM ─► LiteLLM (cip-app) ──► Mistral (cloud)
                                  │
                                  └─► Langfuse plugin (uses metadata.session_id + trace_id) ──► cloud.langfuse.com
                                                                                                   (joins generations into our trace)
   ▼
sendActivity(reply + adaptive-card footer)  ──────────────────────────────►   Teams
   │
   ▼
writeTurnMetric (best-effort)               ──────────────────────────────►   bot_turn_metrics
```

---

## Components

### `teams-bot` (cip-app namespace)

The user-facing service. Stateless aside from in-memory caches. Multi-replica safe (state in Postgres).

**Key modules:**

| Module | Responsibility |
|---|---|
| [`server.ts`](../packages/teams-bot/src/server.ts) | Express app with Bot Framework adapter (`@microsoft/agents-hosting`) |
| [`bot.ts`](../packages/teams-bot/src/bot.ts) | Per-message handler — typing indicator, slash dispatch, auth resolve, runLangGraph |
| [`auth/resolve-context.ts`](../packages/teams-bot/src/auth/resolve-context.ts) | Synchronizes employee record + loads permissions |
| [`langgraph/`](../packages/teams-bot/src/langgraph/) | Graph definition, nodes, runner |
| [`mcp/tool-discovery.ts`](../packages/teams-bot/src/mcp/tool-discovery.ts) | Permission filter + Slice 44 vector retrieval; merges annotation side-channel |
| [`mcp/tool-executor.ts`](../packages/teams-bot/src/mcp/tool-executor.ts) | Per-call MCP client wrapper |
| [`slash-commands/`](../packages/teams-bot/src/slash-commands/) | `/help`, `/about`, `/turn`, `/metrics` registry + dispatch |
| [`instrumentation.ts`](../packages/teams-bot/src/instrumentation.ts) | OTEL bootstrap — MUST import first; without this, Langfuse 5.x is silent |

### `hr-service` (cip-app namespace)

The MCP server + admin HTTP API + Temporal worker. Owns the `cip_hr` Postgres database.

**Key modules:**

| Module | Responsibility |
|---|---|
| [`mcp-server/index.ts`](../packages/hr-service/src/mcp-server/index.ts) | `@modelcontextprotocol/sdk` server with bearer JWT auth middleware |
| [`modules/employees/mcp-tools/`](../packages/hr-service/src/modules/employees/mcp-tools/) | Employee CRUD, sync, role assignment |
| [`modules/certifications/mcp-tools/`](../packages/hr-service/src/modules/certifications/mcp-tools/) | Cert submit / approve / list |
| [`modules/admin/mcp-tools/`](../packages/hr-service/src/modules/admin/mcp-tools/) | Read-only audit tools, including `bot_metrics_*` (Slice 46e) |
| [`routes/admin-*.ts`](../packages/hr-service/src/routes/) | Platform-admin HTTP endpoints (token-auth) — tunables, routing-rules, tool-metadata, tool-retrieval |
| [`workflows/`](../packages/hr-service/src/workflows/) | Temporal workflows (employee-disable, cert-approval) |
| [`services/langfuse-cost.ts`](../packages/hr-service/src/services/langfuse-cost.ts) | Best-effort Langfuse public API client used by `/turn` |

### `LiteLLM` proxy (cip-app namespace)

OpenAI-compatible gateway. Resolves CIP aliases (`cip-classifier`, `cip-router-careful`, `cip-vision`, `cip-embed`) to underlying provider models. Owns the only outbound credentials to Mistral. Has its own Langfuse plugin for LLM-call telemetry.

### Postgres (cip-infra namespace)

`cip_hr` database holds:
- Domain tables (`employees`, `roles`, `permission_groups`, `certifications`, `hr_actions`, `bot_tunables`, `routing_rules`)
- LangGraph checkpointer tables (`checkpoints`, `checkpoint_blobs`, `checkpoint_writes`)
- Telemetry (`bot_turn_metrics`, `tool_embeddings`)
- pgvector extension for tool retrieval

### Langfuse Cloud

Hosted observability. Receives:
1. Graph trace tree from `@langfuse/langchain` CallbackHandler (LangChain runs).
2. Per-LLM-call generations from LiteLLM's own plugin (joined into our traces via `metadata.session_id` + `metadata.trace_id`).
3. Prompt registry (production-labeled `bot.triage`, `bot.plan`, `bot.summarize`, etc.).

---

## Conversation lifecycle

### 1. Activity ingress

Teams sends an HTTP POST to `https://bot-cip.idlevice.ca/api/messages`. The Bot Framework adapter authenticates the request and hands it to `CIPTeamsBot.run`. Bot replies with a typing indicator immediately.

### 2. Slash command dispatch

`dispatchSlashCommand` runs first. If the user typed `/help`, `/about`, `/turn <id>`, or `/metrics`, the matching handler short-circuits the rest of the turn. Slash commands run BEFORE auth resolve where they can (`/help` and `/about` need ctx; `/turn` and `/metrics` need `bot.metrics.read`).

### 3. Auth resolution

`resolveAuthContext` does three things:
1. Calls `sync_employee` (MCP). hr-service upserts the caller's employee row from JWT claims. First-sync also auto-elevates the platform admin email.
2. Calls `get_employee_permissions` (MCP). Returns `{tenantId, employeeId, permissions: Record<string,boolean>, roles: string[]}`.
3. Calls `getToolMetadata` (HTTP — cached 5 min per pod). Returns the side-channel annotation map for every registered MCP tool. This is necessary because the MCP SDK strips non-spec annotation fields (`requiredPermission`, `sideEffectLevel`, `whenToUse`, etc.) from `client.listTools()` responses — we have to fetch them out-of-band.

Result: a `BotAuthContext` with everything downstream needs.

### 4. LangGraph invocation

`runLangGraph` mints a `turnId` (8-char hex). It then:

**a. Reads persisted state** via `graph.getState({configurable: {thread_id: <Teams conversation id>}})`. Two cases:

- **Suspended at confirm** (last turn left an active interrupt): the user's reply text is fed in via `new Command({resume: text})`. Execution resumes inside the `confirm` node from the line after `interrupt()`.
- **Fresh turn**: invoke with seed state (tenantId, employeeId, latestUserText, turnId, etc.).

**b. Sets up the typing-indicator interval** (refreshes every 4s during long turns so Teams doesn't drop it).

**c. Awaits `graph.invoke(...)`** with these config options:
- `callbacks: [langfuseHandler]` — emits a Langfuse trace tree.
- `metadata: {turnId, tenantId, employeeId, threadId, langfuseSessionId, langfuseUserId}` — Langfuse picks up `langfuseSessionId`/`langfuseUserId` automatically; the rest is generic metadata.
- `runName: 'turn-<id>'` — Langfuse trace name.

**d. Detects new interrupt** via `getState().tasks[*].interrupts`. If suspended, render the confirmation prompt; otherwise pick the last AIMessage.

**e. Sends reply + adaptive-card footer.** Footer carries `turn=<id>` and a "🔍 Inspect" Action.Submit that fires `messageBack` with `/turn <id>`.

**f. Best-effort `writeTurnMetric`.** Inserts a row into `bot_turn_metrics`. Failures only log; the durable backup is the structured `[turn]` log line.

### 5. The graph

See [LANGGRAPH_ARCHITECTURE.md](LANGGRAPH_ARCHITECTURE.md) for the auto-generated diagram + per-node detail.

```
START → ingest → triage ─┬─► respond ─┬─► END (or summarize → END)
                         └─► plan → gateWrite ─┬─► confirm ─┬─► END (cancel)
                                               │            └─► execute (loop or → respond)
                                               ├─► execute (loop)
                                               └─► respond
```

Per-node summary:

- **`ingest`**: append HumanMessage, reset per-turn fields, **rotate `sessionId`** if idle > `lg.session_timeout_minutes` (default 60). Defensive clear of `pendingWriteCall`.
- **`triage`**: cheap nemo classifier → non-binding signals. Failure falls back to `{needsTool: true, confidence: 0}` so the planner still runs.
- **`plan`**: strong mistral-small with function-calling. Reads candidate tools via `discoverTools(ctx, latestUserText)` cache. Two-channel exposure: function-calling slot + markdown reference block.
- **`gateWrite`**: per-tool-call check. Write/external + not authorized verbally → stage `pendingWriteCall` → confirm.
- **`confirm`**: calls `interrupt(payload)` — graph SUSPENDS. On resume, classifies user's reply and routes to execute or END.
- **`execute`**: `Promise.all` over tool_calls (parallel). Validates name against `discoverTools` (hallucination guard). Distills 1-line fact for state.lastToolFacts.
- **`respond`**: picks final AIMessage.
- **`summarize`**: when `messages.length > lg.summarize_at`, compresses older tail. Emits `RemoveMessage(id)` per dropped message so the reducer actually drops them.

---

## MCP tool routing

### Discovery pipeline

1. **`client.listTools()`** — MCP server lists every registered tool. Returns `{name, description, inputSchema}` plus a stripped `annotations` (custom fields lost on serialization).
2. **`/admin/tool-metadata`** — HTTP fetch (cached 5 min per pod) to merge `requiredPermission`, `sideEffectLevel`, `whenToUse`, `whenNotToUse`, `commonNextTools`, `outputSchema` back into each tool.
3. **Permission filter** — `tool.annotations.requiredPermission` checked against `ctx.permissions[required] === true`. UX-layer filter only; hr-service's `assertPermission` is the actual security gate.
4. **Vector retrieval** (Slice 44) — when `permitted.length >= 10`, narrow to top-K most-similar to the user message via `/admin/tool-retrieval` (pgvector cosine on `mistral-embed`-1024 embeddings of tool descriptions).
5. **Cache** — stored 5 min per `(tenantId, employeeId)`. Cleared by pod restart.

### Two-channel exposure to the planner

- **Channel 1 (machine):** function-calling `tools` array on the OpenAI request. Schema-validated. Just name + brief description + JSON Schema input.
- **Channel 2 (human):** markdown "Tool reference" block in the planner system prompt. Carries the operational guidance that doesn't fit in the function-calling schema:
  ```
  ### tool_name
  Description first sentence.
  - Use when: hint1; hint2
  - Don't use when: anti-hint1; anti-hint2
  - Returns: { field1: type, field2: type, ... }
  - Often followed by: tool_a, tool_b
  - ⚠ WRITE action — requires explicit user authorization.
  ```

The planner sees both. Function-calling validates the name and args; the markdown block tells it WHEN to use what.

### Authorization gate (write actions)

`gateWrite` runs after `plan`:
- For each tool call: look up `sideEffectLevel` from candidate tool annotations.
- If `'write'` or `'external'`: check `isExplicitlyAuthorized` — user message must contain a verb from `lg.authorized_write_verbs` AND mention an entity matching one of the tool args (string match).
- Not authorized → stage `pendingWriteCall` → route to `confirm` → suspend at `interrupt()` → render "About to: X. Reply yes/no.".
- Next user message: runner detects the suspension, invokes with `Command({resume: userText})`; `confirm` resumes, classifies reply, emits AIMessage(tool_calls) on affirm.

Same flow protects every write tool. Hard rule: server-side `assertPermission` runs again inside the tool handler regardless — gate is UX hardening, not the security boundary.

### Execution

`executeTool` in `tool-executor.ts`:
- Connects an MCP client with the user's bearer JWT.
- Calls `client.callTool({name, arguments})` — JWT flows to hr-service so server-side auth fires per call.
- Parses the response envelope (`{ok, data, message?}` or `{ok: false, code, message}`).
- `execute` node runs all calls in `Promise.all` (parallel — Slice 46c).

---

## Auth + tenancy

### Three layers of identity

1. **AAD identity** (Microsoft Entra) — what Teams sends. The bot's adapter validates the Bot Framework signature.
2. **Keycloak realm user** — per-tenant federated identity. The bot exchanges the AAD identity for a Keycloak JWT against the tenant's realm.
3. **CIP employee record** — `employees` table row. Created/updated by `sync_employee` from Keycloak claims on every turn.

### Tenant resolution

Teams' `activity.channelData.tenant.id` is an AAD GUID. The bot calls `/admin/tenants/by-aad/<guid>` to get the CIP tenant (`{cipTenantId, realm, name}`). All downstream calls use `cipTenantId`. Per-tenant Keycloak client secrets live in K8s secrets named `tenant-aad-<cipTenantId>`.

### Permission model

- **Permissions** — fine-grained codes like `employee.disable`, `cert.approve`, `bot.metrics.read`. Catalogued in `permission_catalog`.
- **Permission groups** — bundles of permissions, scoped to a `service+module`. Pre-defined groups like `admin__cert`, `hr_standard__employee`.
- **Roles** — composed of permission groups. Pre-defined roles: `field_worker`, `hr_standard`, `hr-service-admin`. Created per-tenant.
- **Employee role assignments** — `employee_role_assignments` table links employees to roles.

The bot resolves a flat `permissions: Record<string, boolean>` map at auth time and uses it everywhere. Tools register `requiredPermission` annotations; the bot's UX filter drops disallowed tools from the catalog. The hr-service's `assertPermission` is the actual security gate (defense in depth).

### Bearer-JWT propagation

The Keycloak JWT obtained at auth time flows through every MCP call. hr-service's MCP server has an `attachBearerAuth` middleware that puts the token on `req.auth`, which the SDK exposes as `context.authInfo.token`. Each tool handler calls `extractAuthContext(authInfo)` to get `{tenantId, employeeId, roles}` and `await assertPermission(authInfo, '<perm>')` to gate.

---

## State persistence

### Per-thread checkpointer

`@langchain/langgraph-checkpoint-postgres@1.0.1` provides `PostgresSaver`. Tables in `cip_hr` (public schema):

| Table | Purpose |
|---|---|
| `checkpoints` | One row per (thread_id, checkpoint_ns, checkpoint_id) — the JSONB state snapshot |
| `checkpoint_blobs` | Per-channel binary state (versioned per channel) |
| `checkpoint_writes` | Pending writes queued for a checkpoint |
| `checkpoint_migrations` | Schema-version tracking (managed by `setup()`) |

Configuration:
- **Durability**: defaults to `"async"` in LG 1.x (`PregelOptions.durability`). Mid-turn writes don't block; pod death between transitions could lose the very last write but the next user message resets to `ingest` with the previously-persisted state.
- **Suspension safety**: `interrupt()` forces a synchronous write at the suspension point regardless of durability flag — so confirm-resume across pod restarts is guaranteed safe.
- **Retention**: nightly CronJob (Slice 46d, see [`packages/hr-service/src/scripts/gc.ts`](../packages/hr-service/src/scripts/gc.ts)) keeps the last 10 checkpoints per (thread, ns) plus everything in the last 24h. Deletes the rest. Same job trims `bot_turn_metrics` to 90 days.

### State shape

Defined in [`state.ts`](../packages/teams-bot/src/langgraph/state.ts). Key fields:

| Field | Reducer | Purpose |
|---|---|---|
| `messages` | `messagesStateReducer` (append; supports `RemoveMessage`) | Conversation history |
| `summary` | replace | Compressed older-message summary (set by `summarize`) |
| `triageSignals` | replace | Non-binding signals from triage; reset by ingest |
| `pendingWriteCall` | replace | Set by `gateWrite`, cleared by `confirm` after resume |
| `lastToolFacts` | append within a turn; reset by ingest | 1-line distilled fact per tool result |
| `stepCount` | replace | Plan-iterations guard |
| `latestUserText` | replace | Set by runner before invoke |
| `turnId` | replace | Per-turn correlation id |
| `sessionId` | replace | Langfuse session — rotated by ingest on idle > tunable |
| `sessionLastActivityAt` | replace | Epoch ms; used by ingest's session-rotation check |

Notably **NOT** in state: `candidateTools` (Slice 46d). Each consumer node calls `discoverTools` directly. Net: zero bytes serialized for the tool catalog per checkpoint.

---

## Observability

### `turnId` is the join key

Every turn gets an 8-char hex id at runner entry. It appears in:

| Surface | Where |
|---|---|
| Teams response footer | adaptive-card body: `... turn=\`<id>\`` |
| Pod log | `[turn] turn=<id> engine=langgraph ...` structured line |
| `bot_turn_metrics` row | `turn_id` PK |
| Langfuse trace name | `runName: 'turn-<id>'` |
| Langfuse trace metadata | `metadata.turnId` field |

Pasting a `turn=<id>` into anywhere finds the corresponding row in any other surface.

### Two trace pipelines, one tree

- **LangChain pipeline** — `@langfuse/langchain` `CallbackHandler` emits one trace per `graph.invoke` (named `turn-<id>`). Spans for each node + each LangChain run within. By itself, this trace has NO LLM cost data — the actual LLM calls happen via LiteLLM, in a different process.
- **LiteLLM pipeline** — LiteLLM's own Langfuse plugin emits per-LLM-call generations with cost + token data. It runs in the LiteLLM proxy, separate from our process.

**The join**: `callLLM` (in [`packages/shared/src/clients/litellm.ts`](../packages/shared/src/clients/litellm.ts)) injects `metadata.session_id` (from `state.sessionId`) and `metadata.trace_id` (from OTEL active-span context) into every request. LiteLLM's plugin uses both to attach generations to OUR session and trace tree. Without this, LLM cost data lives in disconnected `litellm-acompletion` traces.

### Sessions

`state.sessionId` rotates in `ingest` when idle > `lg.session_timeout_minutes` (default 60). Persists across pod restarts via PostgresSaver. The runner reads it before invoke and sets `langfuseSessionId` so Langfuse's session view groups consecutive turns of one continuous interaction. After a long idle gap, a new session id mints automatically.

### `bot_turn_metrics` table

Append-only fact table written by the runner after every turn. Columns: see [BOT_PERF_DEBUGGING.md](BOT_PERF_DEBUGGING.md). Used for SQL-based latency/cost queries and as the backing store for the admin MCP tools.

### Admin metrics tools

Five MCP tools registered by hr-service, gated on `bot.metrics.read`:

- `bot_metrics_get_turn(turn_id)` — single-turn detail + Langfuse trace + session URLs + latency + cost.
- `bot_metrics_summary(since)` — aggregate p50/p95/p99 latency, intent mix, refusal rate over a window.
- `bot_metrics_top_n(metric, since, limit, intent?)` — top N by latency/step count.
- `bot_metrics_tools(since)` — per-tool calls, refusal rate, p95 graph time.
- `bot_metrics_outliers(since)` — flagged turns (refused tools, high steps, low triage confidence, p95+ latency, abandoned confirms).

### `/turn <id>` slash command

Wraps `bot_metrics_get_turn` + Langfuse cost API. Renders a card with: timestamp, intent, latency, tools, triage confidence, flags, Langfuse trace latency + cost, session turn count + cost, "Open Trace" + "Open Session" deep-links.

### `[llm-cache]` log lines

Mistral does prefix-caching automatically. `callLLM` logs `[llm-cache] purpose=X cached_tokens=N total_prompt_tokens=M hit_ratio=R` when the response carries `usage.prompt_tokens_details.cached_tokens > 0`. Useful for verifying prompt template stability across iterations.

---

## Operational concerns

### Deploys

```
git push                                  ─►  GitHub Actions builds + pushes images to ghcr.io
make deploy svc=teams-bot [TAG=<sha>]     ─►  helm upgrade --install with the image tag
make deploy svc=hr-service [TAG=<sha>]
```

Helm charts live in each package's `helm/` directory.

### Secrets

`teams-bot-credentials` and `hr-service-credentials` K8s secrets. Sourced from `.envrc` via `scripts/create-secrets.sh`. Common keys: `LITELLM_VIRTUAL_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`, `LANGFUSE_PROJECT_ID`, `PLATFORM_ADMIN_TOKEN`, `DATABASE_URL_HR`. Per-tenant Keycloak secrets in `tenant-aad-<tenantId>`.

### Migrations

`packages/hr-service/src/db/migrations/NNN_*.sql`. The migration runner (`pnpm --filter @cip/hr-service run migrate`) tracks applied migrations in `schema_migrations`. Run from `bootstrap.sh` on cluster create; ad-hoc with port-forward + the same command.

### Tunables

`bot_tunables` table. Global defaults seeded with `tenant_id = '00000000-0000-0000-0000-000000000000'`. Per-tenant overrides via INSERT/UPDATE on `(tenant_id, key)`. Keys (`lg.*` namespace): see migrations 018, 019, 021, 022. Bot fetches the merged map per request via `/admin/bot-tunables` (cached 5 min per tenant).

### Routing rules

`routing_rules` table. Maps `(service, purpose)` to a CIP alias. Reads via `/admin/routing-rules` → `resolveAlias` in the bot. Per-tenant overrides supported.

### Slash command registry

Single source of truth at [`packages/teams-bot/src/slash-commands/registry.ts`](../packages/teams-bot/src/slash-commands/registry.ts). Universal commands (no permission requirement) are also surfaced in Teams' app manifest `commandLists` — generated at build time by [`packages/teams-bot/src/scripts/deploy.ts`](../packages/teams-bot/src/scripts/deploy.ts) so the static manifest stays in sync.

---

## Reading the codebase

If you have 10 minutes, read in this order:

1. [`runner.ts`](../packages/teams-bot/src/langgraph/runner.ts) — the entry point. Shows how a turn flows through the graph.
2. [`graph.ts`](../packages/teams-bot/src/langgraph/graph.ts) — node + edge wiring.
3. [`state.ts`](../packages/teams-bot/src/langgraph/state.ts) — what the graph carries between nodes.
4. One node, e.g. [`plan.ts`](../packages/teams-bot/src/langgraph/nodes/plan.ts) — to see how an LLM call is structured.
5. [`auth/resolve-context.ts`](../packages/teams-bot/src/auth/resolve-context.ts) — how tenancy + permissions flow.
6. [`hr-service/mcp-server/index.ts`](../packages/hr-service/src/mcp-server/index.ts) — how the MCP tools register.
7. [`shared/clients/litellm.ts`](../packages/shared/src/clients/litellm.ts) — the LLM call helper.

If you want to understand a specific behavior:

- **"Why was this tool picked?"** — Langfuse trace `bot.plan` generation → input field shows the prompt + tool reference; output shows the tool call args.
- **"Why is this turn slow?"** — see [BOT_PERF_DEBUGGING.md](BOT_PERF_DEBUGGING.md).
- **"What changed in this slice?"** — `slices/SLICE_NN_*.md`.
- **"How does cross-pod state work?"** — [`checkpointer.ts`](../packages/teams-bot/src/langgraph/checkpointer.ts) + Slice 46 doc.

---

## Glossary

| Term | Means |
|---|---|
| **Tenant** | An organization using the platform. Has its own Keycloak realm + CIP tenant id. |
| **Thread** | A Teams conversation id. Becomes the LangGraph `thread_id` for state-keying. |
| **Session** | A continuous interaction within a thread, bounded by 60-min idle. Used for Langfuse session grouping. |
| **Turn** | One user message + bot reply pair. Has a unique `turnId`. |
| **Trace** | A Langfuse-side span tree for one turn. Created by either our LangChain handler or LiteLLM. |
| **MCP** | Model Context Protocol — the SDK we use for tool registration + invocation. |
| **Tool** | A function exposed by hr-service via MCP. Has annotations (permission, when-to-use, side-effect-level). |
| **Capability** | Older name for a tool. Some legacy code still says capability; treat as synonym. |
| **Slice** | One focused change set, designed in `slices/SLICE_NN_*.md` and shipped as a single PR. |

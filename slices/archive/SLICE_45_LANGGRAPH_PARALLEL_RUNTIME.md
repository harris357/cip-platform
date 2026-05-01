# Slice 45 — Parallel LangGraph runtime for the Teams bot

> **Prerequisite:** Slices 43 + 44 deployed.
> **Package:** `@cip/teams-bot`, `@cip/platform-core` (tunables table + endpoint), `@cip/hr-service` (capability-metadata sweep), `@cip/shared` (Langfuse prompts).
> **Verify:** `pnpm -r typecheck`; smoke tests for both engines via the toggle; write-confirmation interrupt round-trip.

---

## Scope (locked decisions)

1. **LangGraph runtime** alongside legacy. Per-thread toggle (`/lg on`).
2. **Triage node** with non-binding `TriageSignals`.
3. **Capability metadata sweep** across every MCP tool annotation (~30 files).
4. **Write-action confirmation gate** with graph interrupt.
5. **`bot_tunables` table in `cip_platform`.** Per-tenant override with global default fallback. Bot reads via a new platform-core admin endpoint.
6. **Capability metadata exposed in two channels:** short `description` in the function-calling `tools` parameter, plus a structured "Tool reference" section in the planner's system prompt.
7. **`candidateTools` is computed-not-persisted** in the checkpoint. On resume, re-derived from the live MCP catalog + current permissions before any pending write executes.
8. **Telemetry log shape** spec'd in this slice (dashboards land in Slice 48).
9. **All system prompts in Langfuse** with code-resident fallbacks. Tool descriptions stay in code (tightly coupled to implementation).

---

## Architecture

```
                              ┌──────────────────────────┐
Teams activity ─────────────► │  bot.ts handleAuth...    │
                              └────────────┬─────────────┘
                                           │ slash-command catch
                                  ┌────────▼────────┐
                                  │  selectEngine() │ ←──── bot_tunables (per-tenant default)
                                  └───┬─────────┬───┘       overrides Map (per-thread)
                          legacy ◄────┘         └────► langgraph
                              │                          │
                              ▼                          ▼
                  [classifier + router      ┌──── LangGraph runtime ────┐
                   + meta_compose pipeline] │  ingest                   │
                              │              │    │                     │
                              ▼              │    ▼                     │
                       sendActivity          │  discoverCandidates      │
                                             │    │                     │
                                             │    ▼                     │
                                             │  triage  (cip-classifier)│
                                             │    │                     │
                                             │    ▼                     │
                                             │  routeOnSignals          │
                                             │   ├─ ask  ──► respond ──►END
                                             │   └─ proceed             │
                                             │       │                  │
                                             │       ▼                  │
                                             │     plan (cip-router-careful)
                                             │       │                  │
                                             │       ├─ no tool_calls   │
                                             │       │   ──► respond ──►END
                                             │       └─ tool_calls      │
                                             │           │              │
                                             │           ▼              │
                                             │     gateWriteAction      │
                                             │       ├─ blocked         │
                                             │       │  ──► confirm ──►(interrupt)
                                             │       └─ allowed         │
                                             │           │              │
                                             │           ▼              │
                                             │      executeTool         │
                                             │           │              │
                                             │     loop ► plan          │
                                             │     until stepCount      │
                                             │     ≥ MAX_STEPS or       │
                                             │     no more tool_calls   │
                                             │           │              │
                                             │           ▼              │
                                             │       respond  ──► END   │
                                             │                          │
                                             │  (resume after confirm:  │
                                             │   ingest → discover →    │
                                             │   re-validate write →    │
                                             │   execute)               │
                                             └────────────────────────────┘
```

---

## `bot_tunables` table

**Location decision:** lives in `cip_hr` alongside `routing_rules`. Originally planned for `cip_platform`, but platform-core has no migration tooling or database connection wired up today — every "platform-level" table currently lives in `cip_hr` for historical reasons. Adding a separate cip_platform DB just for `bot_tunables` is more setup than the table is worth. **Tech debt:** consolidate `routing_rules` + `bot_tunables` into a real `cip_platform` schema if/when we add platform-core DB infrastructure for other reasons.

```sql
-- packages/hr-service/src/db/migrations/018_bot_tunables.sql
CREATE TABLE IF NOT EXISTS bot_tunables (
  tenant_id   UUID NULL,           -- NULL = global default
  key         TEXT NOT NULL,
  value_json  JSONB NOT NULL,
  notes       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by  TEXT,
  PRIMARY KEY (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'), key)
);

INSERT INTO bot_tunables (tenant_id, key, value_json, notes) VALUES
  (NULL, 'lg.max_steps',                '5',                                                                  'Max plan→execute loops per turn.'),
  (NULL, 'lg.triage_clarify_threshold', '0.7',                                                                'confidence ≥ this triggers clarification path.'),
  (NULL, 'lg.max_recent_messages',      '8',                                                                  'How many prior messages flow into plan context.'),
  (NULL, 'lg.affirmation_patterns',     '["yes","y","confirm","go ahead","do it","ok","okay","sure"]',        'Match lower-cased + trimmed user reply.'),
  (NULL, 'lg.cancellation_patterns',    '["no","n","cancel","stop","never mind","nevermind","wait"]',         NULL),
  (NULL, 'lg.authorized_write_verbs',   '["disable","off-board","offboard","create","add","assign","grant","revoke","remove","fire","approve","reject"]', 'Match in user message to bypass write-confirmation gate.'),
  (NULL, 'lg.default_engine',           '"legacy"',                                                            'Per-tenant engine default. "legacy" or "langgraph". Overridable per-thread by /lg.');
```

Read precedence (per request):
1. Look up `(tenant_id = ctx.tenantId, key)` — if present, use it.
2. Else look up `(tenant_id = NULL, key)` — global default.
3. Else fall back to a code-resident constant (defense in depth — never crash on a missing tunable).

### Endpoint

```
GET /admin/bot-tunables?tenantId=<uuid>
Response: { tunables: { "<key>": <value_json>, ... } }
```

Auth: `x-platform-admin-token` (same as `/admin/routing-rules`). Bot caches the response per-tenant for 5 min.

### Helper

```ts
// packages/teams-bot/src/langgraph/tunables.ts
export async function getTunables(tenantId: string): Promise<Tunables> { /* fetch + cache */ }
export function getTunable<T>(tunables: Tunables, key: string, fallback: T): T { /* precedence */ }
```

---

## State shape

```ts
// packages/teams-bot/src/langgraph/state.ts

export interface TriageSignals {
  needsTool: boolean;
  answerDirectly: boolean;
  needsClarification: boolean;
  currentGoal: string;
  knownEntities: Record<string, string>;
  confidence: number;
  clarificationQuestion?: string;
}

export interface PendingWriteCall {
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolCallId: string;
  summary: string;   // human-readable: "Disable Jane Smith"
}

export const StateAnnotation = Annotation.Root({
  threadId:        Annotation<string>(),
  tenantId:        Annotation<string>(),
  employeeId:      Annotation<string>(),

  messages:        Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
  summary:         Annotation<string>({ reducer: (_, n) => n, default: () => '' }),

  permissions:     Annotation<Record<string, boolean>>({ reducer: (_, n) => n, default: () => ({}) }),
  roles:           Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),

  // Computed-not-persisted: serialized as [] in checkpoints; re-derived on every
  // turn (and on resume from interrupt) by `discoverCandidates`. This guarantees
  // a confirm→resume cycle always uses the user's CURRENT permitted tool set,
  // not whatever was permitted when the interrupt fired.
  candidateTools:  Annotation<McpTool[]>({
    reducer: (_, n) => n,
    default: () => [],
    // Custom serializer hook: replaced with [] when the checkpointer persists.
  }),

  triageSignals:   Annotation<TriageSignals | null>({ reducer: (_, n) => n, default: () => null }),
  pendingWriteCall: Annotation<PendingWriteCall | null>({ reducer: (_, n) => n, default: () => null }),
  lastToolFacts:   Annotation<string[]>({ reducer: (a, n) => [...a, ...n], default: () => [] }),
  stepCount:       Annotation<number>({ reducer: (_, n) => n, default: () => 0 }),
});
```

---

## Nodes

### `ingest`
Append the new `HumanMessage`. Reset `stepCount`, `lastToolFacts`, `triageSignals`. **Special case:** if `pendingWriteCall` is set, classify the user's reply against `lg.affirmation_patterns` and `lg.cancellation_patterns`. If affirmed, fall through to `discoverCandidates` then directly to `executeTool` (skipping triage + plan — the call is already chosen). If cancelled or unrecognized, clear `pendingWriteCall`, emit "Cancelled.", end.

### `discoverCandidates`
Wraps existing `discoverTools(ctx, latestUserText)`. Hydrates `candidateTools`. Slice 44 vector retrieval applies as today.

### `triage`
LLM call to `cip-classifier`. Output strictly conforms to `TriageSignals` (Zod-validated). On parse failure: log warning, default to `{needsTool: true, answerDirectly: false, needsClarification: false, confidence: 0}` (let the planner decide).

### `routeOnSignals` (conditional edge)
```
threshold = getTunable(t, 'lg.triage_clarify_threshold', 0.7)
if   triage.needsClarification && triage.confidence >= threshold → 'ask'
else                                                              → 'plan'
```
The `'ask'` path goes to `respond` directly using `triage.clarificationQuestion`. (No planner call.)

### `plan`
LLM call to `cip-router-careful`. Receives:

- **Via `messages` array:** last `lg.max_recent_messages` messages + the planner system prompt (Langfuse `bot.plan`) + a markdown "Tool reference" section listing each candidate tool's full metadata.
- **Via `tools` parameter:** OpenAI function-calling definitions with short `description` + Zod-derived input schema. (See "Capability metadata channels" below.)
- **`tool_choice`:** `'auto'`.

Returns an `AIMessage`. `tool_calls` presence implicitly signals decision (call vs final answer).

### `gateWriteAction` (conditional edge)
For each tool call in the latest AIMessage, look up the tool's `sideEffectLevel`:
- `'none' | 'read'` → proceed to `executeTool`.
- `'write' | 'external'` → check `isExplicitlyAuthorized(latestUserText, toolName, args, tunables)`. If authorized → execute. If not → store `pendingWriteCall` (one tool call at a time; if multiple writes, gate the first), route to `confirm`.

`isExplicitlyAuthorized` matches user text against `lg.authorized_write_verbs` AND verifies the entity name from `args` appears in the user message. Conservative — when in doubt, gate.

### `confirm` (interrupt point)
Emits a Teams message: `"About to: <pendingWriteCall.summary>. Reply yes to confirm or no to cancel."` Sets graph option `interruptBefore: ['confirm']` so LangGraph saves state and returns control to bot.ts.

### `executeTool`
Wraps existing `executeTool()`. Validates name against `state.candidateTools` (rejects hallucinated names with `ToolMessage({content: JSON.stringify({refused: 'unknown_tool'})})`). After execution, `distillFact()` produces a deterministic ~80-char summary; pushes into `lastToolFacts` and a `ToolMessage` into `messages`. Increments `stepCount`.

### `shouldContinue` (conditional edge)
```
maxSteps = getTunable(t, 'lg.max_steps', 5)
if stepCount >= maxSteps → 'respond'
else                     → 'plan'
```

### `respond`
Sends the latest AIMessage content (or, on the `ask` path, `triage.clarificationQuestion`). Appends the LangGraph footer (see "Telemetry / footer").

---

## Capability metadata expansion (sweep)

Every `server.tool()` annotation in `@cip/hr-service` gains:

```ts
{
  requiredPermission: 'employee.find' | null,
  sideEffectLevel:    'none' | 'read' | 'write' | 'external',
  whenToUse:          string[],   // 1–4 short bullets
  whenNotToUse:       string[],   // 0–3 bullets where ambiguity exists; optional
  commonNextTools:    string[],   // tool names; optional
  outputSchema:       JsonSchema | null,  // required when this tool appears in another tool's commonNextTools
}
```

**Reference example** (`employee_find`):

```ts
{
  requiredPermission: 'employee.find',
  sideEffectLevel:    'read',
  whenToUse: [
    'User asks to look up a specific employee by email',
    'A subsequent operation needs the employee ID and only the email is known',
  ],
  whenNotToUse: [
    'User wants a list of multiple employees (use employee_list)',
    'User asks about themselves (use get_employee_permissions)',
  ],
  commonNextTools: ['employee_get', 'employee_assign_role', 'employee_disable'],
  outputSchema: {
    type: 'object',
    required: ['employee'],
    properties: {
      employee: {
        type: 'object',
        required: ['id', 'email', 'fullName'],
        properties: {
          id:         { type: 'string', format: 'uuid' },
          email:      { type: 'string' },
          fullName:   { type: 'string' },
          disabledAt: { type: ['string', 'null'], format: 'date-time' },
        },
      },
    },
  },
}
```

The legacy runtime ignores all new fields; only `requiredPermission` is read by `discoverTools`. No risk of regression.

---

## Capability metadata channels (planner-only)

The planner sees tool metadata through **two channels** simultaneously:

### Channel 1 — `tools` parameter (function-calling contract)

```ts
{
  type: 'function',
  function: {
    name: tool.name,
    description: tool.description,    // existing prose; unchanged
    parameters: zodToJsonSchema(tool.inputSchema),
  }
}
```

This is what Mistral's function-calling validates against. Short, focused, matches today's shape.

### Channel 2 — system prompt "Tool reference" section

A markdown block injected into the planner's system prompt (Langfuse `bot.plan`), regenerated per turn from the `candidateTools` array:

```
## Tool reference

### role_list
Returns every CIP role in the caller's tenant.
- Use when: audits, "what roles exist", "list our roles"
- Don't use when: user is asking about THEIR own roles (use get_employee_permissions)
- Returns: { roles: [{code, label, group_count}], total: number }
- Often followed by: role_get, role_members

### employee_find
Find a single employee by exact email match.
- Use when: looking up specific employee by email; need the employee ID for a follow-up call
- Don't use when: listing multiple employees; user asks about themselves
- Returns: { employee: {id, email, fullName, disabledAt} }
- Often followed by: employee_get, employee_assign_role, employee_disable

[... one block per candidate tool ...]
```

The markdown is built by `formatToolReference(tools: McpTool[]): string` — pure TS, no LLM call. Output is appended to the system prompt as `{{tool_reference}}` Jinja2 variable.

**Token cost:** ~150-250 tokens per tool × N candidates (typically 6-15 after retrieval). Total ~2-4K extra input tokens per `plan` call. At mistral-small rates, ~$0.0008 per call. Acceptable.

**Why two channels:**
- Channel 1 enforces validation (schema-checked tool calls).
- Channel 2 surfaces operational metadata the model uses to decide *whether* to call a tool. Function-calling APIs don't have a slot for `whenNotToUse` or `outputSchema` — those have to live somewhere the model reads, which is the system prompt.

---

## Slash-command toggle

```ts
// packages/teams-bot/src/langgraph/engine-toggle.ts
type Engine = 'legacy' | 'langgraph';

const overrides = new Map<string, Engine>();

export async function selectEngine(
  ctx: BotAuthContext,
  threadId: string,
): Promise<Engine> {
  if (process.env['BOT_FORCE_LANGGRAPH'] === 'true') return 'langgraph';
  const k = `${ctx.tenantId}:${threadId}`;
  const perThread = overrides.get(k);
  if (perThread) return perThread;
  const tunables = await getTunables(ctx.tenantId);
  return getTunable(tunables, 'lg.default_engine', 'legacy' as Engine);
}

export function handleEngineSlashCommand(ctx, threadId, text): { reply: string } | null {
  // /lg on, /lg off, /lg status — store in `overrides` map, return reply.
}
```

Per-thread overrides are in-process. Slice 46 persists to a small `bot_engine_overrides` table.

---

## Prompts (Langfuse)

Two new prompts. Both follow the existing pattern: production version in Langfuse, fallback in `@cip/shared/src/clients/prompts/`. Seeded by the bootstrap script.

### `bot.triage` (Langfuse)

Variables: `recent` (array of {role, content}), `latest` (string), `userContext` (roles, permissions hint).

Output schema: strict JSON matching `TriageSignals`. Triage MUST NOT pick tools or answer the user.

### `bot.plan` (Langfuse)

Variables: `recent`, `summary`, `currentGoal`, `facts` (lastToolFacts), `tool_reference` (the markdown block from Channel 2), `latest`.

Tool definitions go via the OpenAI `tools` parameter (Channel 1) — not embedded in this prompt template.

---

## Telemetry / footer

Every LangGraph turn emits one structured `[turn]` log line and one Teams footer.

### `[turn]` log line

```
[turn] engine=langgraph tenantId=… threadId=… intent=<triage decision: ask|direct|tool>
       toolsAttempted=[<names>] toolsBlocked=[<names>] toolsRefused=[<names>]
       stepCount=N triageConfidence=0.X clarificationFired=<bool>
       confirmationFired=<bool> totalMs=N triageMs=N planMs=N execMs=N respondMs=N
       fallbackHit=<bool>
```

Field definitions:
- `intent`: `ask` (clarification path), `direct` (plan called with no tool result), `tool` (at least one tool ran).
- `toolsAttempted`: tool names the planner emitted across all `plan` calls this turn.
- `toolsBlocked`: tools blocked by `gateWriteAction` awaiting confirmation.
- `toolsRefused`: tool names rejected by `executeTool` (hallucinations, schema failures).
- `clarificationFired`: triage routed to `ask`.
- `confirmationFired`: gate triggered an interrupt this turn.
- `fallbackHit`: any node fell back to a hardcoded default (e.g., triage parse failure).

### Footer (Teams message)

```
_⏱ 2.42s · langgraph · triage=0.4s plan=0.7s exec=0.6s respond=0.7s ·
  cip-classifier → cip-router-careful → role_list → respond_
```

Engine name is always present so the user sees which path served the turn. Tools chained as arrows. On confirm interrupt:

```
_⏱ 0.9s · langgraph · awaiting confirmation · cip-classifier → cip-router-careful → ⏸_
```

---

## Files in scope

```
packages/platform-core/src/db/migrations/<NNN>_bot_tunables.sql           NEW
packages/platform-core/src/db/queries/bot-tunables.ts                      NEW
packages/platform-core/src/routes/admin-bot-tunables.ts                    NEW
packages/platform-core/src/server.ts                                       (mount the new route)

packages/teams-bot/package.json                                            (+@langchain/langgraph, @langchain/core)
packages/teams-bot/src/langgraph/state.ts                                  NEW
packages/teams-bot/src/langgraph/checkpointer.ts                           NEW
packages/teams-bot/src/langgraph/graph.ts                                  NEW
packages/teams-bot/src/langgraph/runner.ts                                 NEW
packages/teams-bot/src/langgraph/tunables.ts                               NEW (fetch + cache + getTunable)
packages/teams-bot/src/langgraph/engine-toggle.ts                          NEW
packages/teams-bot/src/langgraph/nodes/ingest.ts                           NEW
packages/teams-bot/src/langgraph/nodes/discover.ts                         NEW
packages/teams-bot/src/langgraph/nodes/triage.ts                           NEW
packages/teams-bot/src/langgraph/nodes/plan.ts                             NEW
packages/teams-bot/src/langgraph/nodes/gate-write.ts                       NEW
packages/teams-bot/src/langgraph/nodes/confirm.ts                          NEW
packages/teams-bot/src/langgraph/nodes/execute.ts                          NEW
packages/teams-bot/src/langgraph/nodes/respond.ts                          NEW
packages/teams-bot/src/langgraph/util/messages.ts                          NEW
packages/teams-bot/src/langgraph/util/distill.ts                           NEW
packages/teams-bot/src/langgraph/util/authorize-write.ts                   NEW
packages/teams-bot/src/langgraph/util/tool-reference.ts                    NEW (formatToolReference)
packages/teams-bot/src/bot.ts                                              (engine dispatch + slash command catch)

packages/shared/src/clients/prompts/bot-triage.ts                          NEW
packages/shared/src/clients/prompts/bot-plan.ts                            NEW
packages/shared/src/clients/prompts/index.ts                               (register both)

packages/hr-service/src/modules/**/mcp-tools/*.ts                          (~30 files — capability-metadata sweep)

slices/SLICE_45_LANGGRAPH_PARALLEL_RUNTIME.md                              this file
```

---

## Hard rules (non-negotiables)

- **Existing runtime is untouched.** No `intent/*` files modified by this slice.
- **Reuse existing infra.** `discoverTools`, `executeTool`, `resolveAlias`, `callLLM`, MCP `requiredPermission` annotations, vector retrieval — all called from inside graph nodes.
- **Triage produces only signals.** No tool selection, no final answer. Output strictly conforms to `TriageSignals`.
- **Planner uses native function calling.** No custom JSON output shape.
- **No tool-name invention.** `executeTool` rejects calls to names not in current `state.candidateTools`.
- **No write without confirmation.** Any `sideEffectLevel: 'write' | 'external'` tool routes through `gateWriteAction`. Bypass only when `isExplicitlyAuthorized` matches.
- **No magic numbers.** Every threshold, pattern list, and step count reads from `bot_tunables`. Code constants are fallbacks only.
- **`candidateTools` is computed-not-persisted.** Re-derived on every turn and on resume.
- **All system prompts in Langfuse.** Tool descriptions and capability metadata stay in code (tightly coupled to implementation).
- **No `@anthropic-ai/sdk` import.**
- **Stubs forbidden.**

---

## Verification

**Typecheck:**
```
pnpm --filter @cip/teams-bot typecheck
pnpm --filter @cip/platform-core typecheck
pnpm --filter @cip/hr-service typecheck
pnpm --filter @cip/shared typecheck
```

**Smoke tests** — per Teams thread, `/lg on` first:

| Query                                  | Expected                                                                          |
|----------------------------------------|-----------------------------------------------------------------------------------|
| `/lg on`                               | `_Engine: LangGraph (this thread)._`                                              |
| "Hi"                                   | triage → answerDirectly; plan w/ no tools; friendly reply                         |
| "What are my roles"                    | one tool call to `get_employee_permissions`                                       |
| "Find Jane and disable her"            | plan → multi-call; gate triggers on `employee_disable`; confirm                   |
| "yes" (after confirm)                  | resume; re-validates permission; runs disable; "Done"                             |
| Permission revoked between confirm + resume | resume detects loss; refuses with explanation                                  |
| "Cancel" (after confirm)               | "Cancelled."                                                                      |
| "Disable Jane" (explicit verb + name)  | gate bypassed via `isExplicitlyAuthorized`; runs immediately                      |
| "Do that for the other one too"        | uses prior turn entities via `messages`; works                                    |
| `/lg off` then "What are my roles"     | falls back to legacy; identical to today                                          |

**Hallucination guard:** force the planner to emit a fake tool name (test fixture). `executeTool` returns `{refused: 'unknown_tool'}`; planner re-plans.

**Tunables override:** insert per-tenant row `lg.max_steps = 2`. Verify the loop respects it on the next turn after cache TTL expires.

**Cost:** capture Langfuse trace token counts for the canonical query set on legacy vs langgraph. Document the ratio in `CROSS_SLICE_NOTES`.

---

## Memory model

This slice ships **short-term, in-thread memory only**. No cross-thread, no vector retrieval over past conversations, no user-preference store. Future slices layer those on top.

### What's stored (Slice 45)

| Field                | Lifetime        | Where                             | Notes                                                                              |
|----------------------|-----------------|------------------------------------|------------------------------------------------------------------------------------|
| `messages`           | per-thread      | LangGraph state via checkpointer  | Cap at `lg.max_recent_messages` (8) flowing into prompt; older trimmed at runtime  |
| `summary`            | per-thread      | LangGraph state                    | Empty in Slice 45; populated by `summarize` node in Slice 46                       |
| `lastToolFacts`      | per-turn        | LangGraph state                    | Cleared each `ingest`. Distilled tool-result lines.                                |
| `triageSignals.knownEntities` | per-turn | LangGraph state                    | Reset each turn in this slice. Could be promoted to durable in Slice 49.           |
| `pendingWriteCall`   | per-thread      | LangGraph state                    | Persists across the confirm interrupt; cleared on resume.                          |

### Persistence — Slice 45

`MemorySaver` (in-process Map). Keyed by `(thread_id)` at the LangGraph level. Survives:
- Node transitions within a turn
- Successive turns within a pod's lifetime (so "do that for the other one too" works)

Does NOT survive:
- Pod restarts
- Multi-replica scenarios (each pod has its own Map)

### Persistence — Slice 46 (deferred)

Swap `MemorySaver` for `PostgresSaver` (LangGraph's `@langchain/langgraph-checkpoint-postgres`). Schema lives in `cip_platform` since state is platform-runtime data, not HR domain. Multi-replica safe; survives restarts.

### What's NOT in this slice

**Long-term factual memory** (e.g., "Sarah prefers JSON output", "Tom's team is Engineering"):
- Would live in a new `bot_memory` table, keyed `(tenant_id, employee_id, fact_key)`.
- Populated by tools or post-turn extraction.
- Loaded into state at turn start.
- Deferred — proposed Slice 49.

**Vector retrieval over past conversations** (e.g., "what did we figure out about that AAD issue last month"):
- Post-turn pipeline: extract durable facts from `messages` → embed via `cip-embed` → store with metadata.
- Per-turn: semantic search → top-K → inject into planner prompt.
- Would either reuse `agent_memory_vectors` (existing in cip_hr from migration 003 — 1536-dim, ada-002 era) or add a fresh `bot_conversation_memory` (1024-dim, mistral-embed compatible).
- Deferred — proposed Slice 50.

### Why short-term only for this slice

- The LangGraph runtime mechanics (state, reducers, checkpointer, interrupts) are themselves a significant change. Bundling long-term memory makes the diff harder to validate.
- Long-term memory needs a *consumer* — fact extraction, retrieval, prompt injection. Those depend on the runtime existing first.
- We don't have data yet on what cross-thread memory the bot actually needs. Building it speculatively risks over-engineering. Once Slice 45 is in production and we see real conversation patterns, we'll know if it's "users want preferences remembered" or "users want past tickets retrievable" — different solutions.

### LangGraph "store" abstraction

LangGraph provides a `BaseStore` interface (in-memory, Redis, Postgres bindings) for cross-thread key-value with optional embedding indexing. **We are not using `BaseStore` in Slice 45.** When Slices 49 or 50 land, that's where they'd plug in — keeping the LangGraph idiom consistent.

---

## Out of scope (deferred)

- LLM-driven `summarize` node (compress old messages into `summary`) — Slice 46
- Postgres checkpointer for multi-replica + pod-restart durability — Slice 46
- Persisted per-thread engine override (DB-backed `bot_engine_overrides`) — Slice 46
- Long-term factual memory (`bot_memory`) — proposed Slice 49
- Vector retrieval over past conversations — proposed Slice 50
- Telemetry dashboard + alerting — Slice 48
- Removing the legacy pipeline — only after 2+ weeks of toggle traffic with no regressions

---

## Cross-slice notes

- `meta_compose` has no analog in LangGraph. Meta queries flow naturally through `triage → plan` (with no tools called) → `respond`.
- `chitchat | meta | proceed` enum is unused by LangGraph. Triage emits richer signals; the planner sees the message + tools and decides natively.
- The capability-metadata sweep adds fields the legacy pipeline ignores (only reads `requiredPermission`). No regression risk.
- `bot_tunables` lives in `cip_platform`. If we ever consolidate `routing_rules` into platform-core too, that's a separate cleanup slice.

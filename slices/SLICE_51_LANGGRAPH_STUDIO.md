# Slice 51 — LangGraph Studio for local dev visualization

> **Prerequisite:** None (works against any compiled graph). Slice 46b nice-to-have so the suspended-state UI matches the production interrupt pattern.
> **Package:** `@cip/teams-bot` (configuration only).
> **Verify:** `pnpm --filter @cip/teams-bot studio` (or the equivalent CLI command) opens the Studio UI; the bot graph is visualized; sending a synthetic input through the UI runs the graph against a local Postgres or in-memory checkpointer; node-by-node state diffs are visible.

---

## Why

Today, debugging "why did the planner pick X tool?" or "why did triage route to respond instead of plan?" means:
1. Find the `[turn]` log line by `turnId`.
2. Cross-reference Langfuse generations by hand.
3. Mentally compose a graph trace from the discrete spans.

LangGraph Studio (shipped with 1.x) renders the graph as an interactive node-link diagram, lets you step through a turn one node at a time, and shows the state diff at each transition. Native to the runtime — no instrumentation needed beyond a config file.

This is **dev tooling only.** It does not run in production. Its value is closing the "can I see what happened" gap during local development and incident triage.

## What this slice IS

1. **`langgraph.json` config** in the repo root pointing the Studio CLI at our compiled graph factory.
2. **A thin entrypoint module** that exports a graph instance with a stub `BotAuthContext`. Studio doesn't have real Teams + Keycloak — it needs a graph that compiles standalone.
3. **A pnpm script** (`pnpm --filter @cip/teams-bot studio`) that wraps `langgraph dev` with the right working directory and env.
4. **A short README block** in the slice doc covering: how to start Studio, how to feed it a synthetic input, how to inspect node-level state diffs.

## What this slice is NOT

- **Not a production deployment of LangGraph Server.** Studio's local mode is enough.
- **Not an integration with Langfuse.** Studio shows graph state; Langfuse shows LLM generations. They're complementary; this slice doesn't change that.
- **Not a way to replay against real production checkpoints.** Studio's local checkpointer is separate from production's `cip_hr` tables. Pulling a live checkpoint into Studio is a future enhancement.

---

## Configuration

```jsonc
// langgraph.json (repo root, NEW)
{
  "node_version": "22",
  "dependencies": ["./packages/teams-bot"],
  "graphs": {
    "bot": "./packages/teams-bot/src/langgraph/studio-entry.ts:botGraph"
  },
  "env": ".env.studio"
}
```

```ts
// packages/teams-bot/src/langgraph/studio-entry.ts (NEW)
//
// Dev-only entrypoint for `langgraph dev` (LangGraph Studio).
// Constructs a graph with a stub BotAuthContext so Studio can compile it
// without a live Teams / Keycloak / hr-service.
//
// Studio bypasses ingest's resume-handling and gateWriteAction's permission
// checks — those need real ctx. For now, Studio is for graph-shape inspection
// + planner prompt iteration, not full E2E debugging.

import { buildGraph } from './graph.js';
import type { BotAuthContext } from '../auth/resolve-context.js';

const stubCtx: BotAuthContext = {
  tenantId:    process.env['STUDIO_TENANT_ID']   ?? '00000000-0000-0000-0000-000000000001',
  employeeId:  process.env['STUDIO_EMPLOYEE_ID'] ?? 'studio-dev',
  permissions: { /* populate via env or empty for graph-shape work */ },
  roles:       ['developer'],
  tenantConfig: {
    litellmVirtualKey: process.env['LITELLM_VIRTUAL_KEY'] ?? 'sk-fake-studio',
    realm:             'studio',
  },
  // ...other ctx fields stubbed minimally
};

export const botGraph = buildGraph(stubCtx);
```

```dotenv
# .env.studio (NEW, gitignored)
DATABASE_URL_HR=postgresql://localhost:5432/cip_hr_studio
LITELLM_BASE_URL=http://localhost:4000
LITELLM_VIRTUAL_KEY=sk-fake-studio
HR_SERVICE_URL=http://localhost:3000
PLATFORM_ADMIN_TOKEN=studio
STUDIO_TENANT_ID=...
STUDIO_EMPLOYEE_ID=studio-dev
```

```jsonc
// packages/teams-bot/package.json (add to "scripts")
{
  "scripts": {
    // ... existing
    "studio": "langgraph dev --config ../../langgraph.json"
  }
}
```

A new dev dependency is also needed: the `langgraph` CLI. Add `@langchain/langgraph-cli` to the workspace root devDependencies. (Verify exact package name at implementation time — at LG 1.2.9 the CLI may be a separate package.)

---

## Files in scope

```
langgraph.json                                                NEW (repo root)
.env.studio.example                                           NEW (committed; .env.studio gitignored)
.gitignore                                                    (+ .env.studio)
packages/teams-bot/src/langgraph/studio-entry.ts              NEW
packages/teams-bot/package.json                               (+studio script)
package.json                                                  (+@langchain/langgraph-cli devDep)

slices/SLICE_51_LANGGRAPH_STUDIO.md                           this file
```

---

## Hard rules

- **No production behavior change.** Studio config exists in the repo but never runs in CI or production. Studio dependencies are devDependencies.
- **Studio's checkpointer is local Postgres or in-memory.** It MUST NOT point at production `cip_hr`. The `.env.studio` file's `DATABASE_URL_HR` defaults to a `cip_hr_studio` database (operator's responsibility to create locally).
- **No secrets in `.env.studio.example`.** Real values land in the gitignored `.env.studio`.
- **Don't gate features on Studio being installed.** The CLI is optional dev tooling; the bot must build, typecheck, and run without it.

---

## Verification

**Local installation:**
```bash
pnpm install
pnpm --filter @cip/teams-bot studio
```
Studio CLI starts, prints a localhost URL.

**Graph rendering:**
1. Open Studio in a browser.
2. Confirm the graph diagram shows: `START → ingest → discover → triage → plan → gateWrite → confirm/execute → respond → summarize → END`.
3. Conditional edges show the predicate names (`routeOnSignals`, `shouldContinue`, etc.).

**Synthetic turn:**
1. From Studio's input pane, send `{ latestUserText: "show my certs" }`.
2. Step through node-by-node.
3. Confirm `discover` populates `candidateTools`, `triage` sets `triageSignals`, `plan` emits a tool call.

**Replay:**
1. Take an existing thread_id from the input dropdown.
2. Step backward through prior nodes — confirm state diffs at each step.

**Cleanup:**
1. Stop Studio.
2. Confirm production teams-bot is unaffected (no shared env, no shared checkpointer).

---

## Out of scope (deferred)

- Studio in CI as a "graph-shape lint" (run `langgraph dev --validate` to ensure the graph compiles and node names match an expected manifest). Nice-to-have if we add new nodes frequently.
- Pulling production checkpoints into Studio for forensic replay (would require a tenant-scoped export tool with redaction).
- Studio Cloud / hosted variant.

---

## Cross-slice notes

- 46b's native interrupt pattern is what Studio renders most cleanly — the `__interrupt__` task surfaces in Studio as a paused node. If 46b ships before 51, the demo is more impressive.
- 49's PostgresStore (cross-thread memory) is visible in Studio as a separate panel once configured. We don't wire it in this slice; it'll happen naturally when 49 ships.

# CIP Platform — Slice Map

> One slice = one focused session. Work in order. Later slices depend on earlier ones compiling.

---

## Slice Map

| # | Slice | Doc | Status |
|---|-------|-----|--------|
| 02 | Shared Types | [SLICE_02_SHARED_TYPES.md](./SLICE_02_SHARED_TYPES.md) | pending |
| 05A | HR Domain Schema | [SLICE_05A_HR_DOMAIN.md](./SLICE_05A_HR_DOMAIN.md) | pending |
| 05B | HR ORM + Registry | [SLICE_05B_HR_ORM.md](./SLICE_05B_HR_ORM.md) | pending |
| 06 | HR Temporal Workflows | [SLICE_06_HR_TEMPORAL.md](./SLICE_06_HR_TEMPORAL.md) | pending |
| 07 | Vision Agent | [SLICE_07_VISION_AGENT.md](./SLICE_07_VISION_AGENT.md) | pending |
| 08 | NATS Watcher | [SLICE_08_NATS_WATCHER.md](./SLICE_08_NATS_WATCHER.md) | pending |
| 09 | MCP Server | [SLICE_09_MCP_SERVER.md](./SLICE_09_MCP_SERVER.md) | pending |
| 10 | Platform Core | [SLICE_10_PLATFORM_CORE.md](./SLICE_10_PLATFORM_CORE.md) | pending |
| 14 | Matching Activities | [SLICE_14_MATCHING.md](./SLICE_14_MATCHING.md) | pending |
| 15 | Employee Onboarding | [SLICE_15_EMPLOYEE_ONBOARDING.md](./SLICE_15_EMPLOYEE_ONBOARDING.md) | pending |
| 16 | Complex Query Tools | [SLICE_16_COMPLEX_QUERY_TOOLS.md](./SLICE_16_COMPLEX_QUERY_TOOLS.md) | pending |
| 17 | Teams Bot | [SLICE_17_TEAMS_BOT.md](./SLICE_17_TEAMS_BOT.md) | pending |

Slices 01–13 and App Images are complete — see [archive/](./archive/).

---

## Dependency Order

```
02 (shared types)
 └─ 05A (domain schema)
     └─ 05B (Drizzle ORM + LookupRegistry)
         ├─ 06 (Temporal workflows)
         │   ├─ 07 (vision agent)
         │   ├─ 08 (NATS watcher)
         │   └─ 14 (matching activities)  ← fills stubs from 06
         ├─ 09 (MCP server)
         │   └─ 16 (complex query tools)
         └─ 15 (employee onboarding)      ← needs 06 worker registration
10 (platform core)                        ← parallel with 05B+
17 (teams bot)                            ← parallel with 09+, no hr-service imports
```

Slices 06, 09, 10, 17 can all proceed in parallel once 05B is done.

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

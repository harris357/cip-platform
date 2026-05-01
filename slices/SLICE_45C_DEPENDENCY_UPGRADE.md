# Slice 45c — LangChain/LangGraph 1.x + openai SDK 6.x upgrade

> **Prerequisite:** Slice 47b deployed (LangGraph is the only runtime; legacy classifier deleted).
> **Package:** `@cip/teams-bot`, `@cip/shared`, `@cip/hr-service` (workspace-wide upgrade).
> **Verify:** `pnpm -r run typecheck` passes; bot smoke-tested against a live triage + plan + execute path; Langfuse generations still appear with the same metadata fields.

---

## Why

The bot was authored against `@langchain/langgraph` 0.2.x and `openai` 4.x. As of 2026-05-01 the installed versions are:

| Package | Installed | Latest | Gap |
|---|---|---|---|
| `@langchain/langgraph` | 0.2.74 | **1.2.9** | major |
| `@langchain/core` | 0.3.80 | **1.1.42** | major |
| `@langchain/openai` | 0.4.9 | **1.4.5** | major |
| `openai` | 4.104.0 | **6.35.0** | **TWO majors** |
| `@langfuse/langchain` | 5.2.0 | 5.2.0 | current |
| `@langchain/langgraph-checkpoint-postgres` | — | **1.0.1** | not installed |

Three things make this an explicit slice rather than a routine bump:

1. **LangGraph 1.x ships a native `BaseStore` with built-in semantic search.** Slice 49 was originally designed around a hand-built `bot_memory` table and Slice 50 around a separate `bot_conversation_memory` pgvector table. PostgresStore from `@langchain/langgraph-checkpoint-postgres` provides keyed get/put + vector search + TTL + namespaces in one component. Adopting it lets us merge Slices 49 and 50 into a single, much smaller slice — but only if we're on LangGraph 1.x.
2. **`@langchain/langgraph-checkpoint-postgres` 1.0.1 is the same package Slice 46 needs for `PostgresSaver`.** Installing it once unblocks 46 + the merged 49 simultaneously.
3. **`openai` 4.x → 6.x is a deliberate API change.** v5 shipped streaming-helper renames; v6 reorganized the chat-completion request shape. Application code in `callLLM`, `chatCompletion` helpers, and any direct `OpenAI` constructor calls needs review. We opt to do this upgrade in a focused session rather than letting it bleed into Slice 46.

## What this slice IS

1. **Bump the four LangChain packages** to their latest 1.x lines across `@cip/teams-bot`, `@cip/hr-service`, `@cip/shared`. Update peer-dep ranges in `package.json` to match what 1.x actually requires.
2. **Add `@langchain/langgraph-checkpoint-postgres@^1.0.1`** to `@cip/teams-bot` (PostgresSaver) and `@cip/hr-service` (its `PostgresStore` will be used in merged Slice 49).
3. **Bump `openai` 4.x → 6.x** in `@cip/teams-bot` and `@cip/shared`. Audit every `openai` import — fix breakages, update message-shape construction, update any tools/tool_choice payloads to whatever 6.x expects.
4. **Verify Langfuse generations still appear** with `purpose`, `tenantId`, `trace_id` metadata after the bumps. The `@langfuse/langchain` integration interacts with `@langchain/core`'s callback system, so we need to confirm nothing silently broke during the major-version jump.
5. **Migration smoke test:** start the bot, trigger triage → plan → confirm-gated execute end-to-end. Watch for runtime errors that typecheck wouldn't catch (e.g., shape mismatches in tool-call results).

## What this slice is NOT

- **Not an architectural rewrite.** No new graph nodes, no new tunables, no new tables. Pure dependency bump + breakage fixes.
- **Not Slice 46.** The PostgresSaver wiring lives in 46. We only INSTALL the package here.
- **Not Slice 49.** The PostgresStore wiring lives in the merged 49. Same — install only.
- **Not LangGraph Studio adoption.** Separate decision.

---

## Files in scope (likely)

```
packages/teams-bot/package.json                     (bump 4 + add 1)
packages/hr-service/package.json                    (bump 4 + add 1)
packages/shared/package.json                        (bump openai)
pnpm-lock.yaml                                      (regen)

# Audit / fix sweep — touched only if the upgrade breaks them:
packages/teams-bot/src/llm/call-llm.ts
packages/teams-bot/src/llm/chat-completion.ts
packages/teams-bot/src/langgraph/nodes/triage.ts
packages/teams-bot/src/langgraph/nodes/plan.ts
packages/teams-bot/src/langgraph/nodes/respond.ts
packages/teams-bot/src/langgraph/runner.ts
packages/teams-bot/src/langgraph/checkpointer.ts
packages/hr-service/src/<llm-call-sites>            (whatever exists)
packages/shared/src/clients/<openai-direct-callers> (whatever exists)

slices/SLICE_45C_DEPENDENCY_UPGRADE.md              this file
```

The exact `src/` file list depends on what breaks. Start by bumping versions, then `pnpm -r run typecheck` and walk the errors.

---

## Hard rules

- **No model-specific code introduced during the fix sweep.** Per `LLM_PROVIDER_NOTES.md`. If a 6.x change requires adapting a request shape, adapt it generically — don't add `if (provider === 'mistral') ...`.
- **Canonical chat-completion shape preserved.** System + user-role messages remain mandatory; never call with system-only.
- **Langfuse metadata preserved.** Check that `metadata.trace_id`, `metadata.purpose`, `metadata.tenantId` still flow into Langfuse generations after the bump. If 1.x renamed any of these fields, update + document in `LLM_PROVIDER_NOTES.md`.
- **No silent regressions.** If a package upgrade requires removing or renaming a feature (e.g., a deprecated method), call it out in the commit body — don't bury it.
- **Lockfile committed.** `pnpm-lock.yaml` updates land in the same commit.
- **`@langfuse/langchain` stays at its current major.** Already current. Don't move to a beta line.

---

## Verification

**Compile + typecheck:**
```bash
pnpm install
pnpm -r run typecheck
```

**Smoke test (local against a tenant):**
1. Send "show employees in HR" — expect triage → plan → execute → respond, real data.
2. Send "disable Jane Smith" — expect confirm gate fires.
3. Reply "yes" — expect write executes.
4. Check Langfuse: each LLM call appears as a generation with `trace_id` matching the turn footer's `turn=<id>`.

**Regression watch:**
- `tools_attempted` log field still populates.
- Triage confidence still parses.
- `meta_compose` chitchat path still emits a reply.

---

## Out of scope (deferred to subsequent slices)

- Wiring `PostgresSaver` (Slice 46).
- Wiring `PostgresStore` for memory (merged Slice 49).
- Langfuse `CallbackHandler` (Slice 48).

---

## Cross-slice notes

- Slices 46, 48, and merged 49 all assume 1.x APIs. They're blocked on this slice.
- If the openai 4 → 6 jump exposes anything in `@cip/shared` that 's been broken since the 4 → 5 era and was never noticed, fix in this slice — those are 4-major-old debts and shouldn't be carried forward.
- If LangGraph 1.x has renamed `MemorySaver` / `BaseCheckpointSaver` exports, update `packages/teams-bot/src/langgraph/checkpointer.ts` to match. Slice 46 will replace `MemorySaver` entirely, but until then this slice keeps the in-memory saver working.

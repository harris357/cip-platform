# CIP Context-Slicing — Quick Reference

## Session Checklist

```
□ Open the SLICE_NN doc for today's slice
□ Read "What You Are Building" and "Acceptance Criteria"  
□ Copy the prompt from PROMPTS_ALL.md into Claude Code
□ Wait for typecheck to pass (do not stop early)
□ Commit: git commit -m "slice(NN): <slice name>"
□ Update this cheatsheet: mark the slice done ✅
```

## Slice Status Tracker

| Slice | Name | Status | Commit |
|-------|------|--------|--------|
| 00 | Orientation | ☐ Read | — |
| 00-INFRA | **Platform Readiness** ← do first | ☐ | — |
| 01 | Workspace Root | ☐ | — |
| 02 | Shared Types | ☐ | — |
| 03 | Shared Clients & Utils | ☐ | — |
| 04 | Infrastructure YAML | ☐ | — |
| 05 | HR DB Layer | ☐ | — |
| 06 | HR Temporal | ☐ | — |
| 07 | Vision Agent | ☐ | — |
| 08 | NATS Watcher | ☐ | — |
| 09 | MCP Server | ☐ | — |
| 10 | Platform Core | ☐ | — |
| 11 | Teams Bot | ☐ | — |
| 12 | Infra Scripts | ☐ | — |
| 13 | Makefile & Scripts | ☐ | — |

---

## The 7 Non-Negotiables (memorise these)

| # | Rule | How to spot a violation |
|---|------|------------------------|
| 1 | `tenantId` on everything | Interface missing `tenantId: string` (not optional) |
| 2 | LiteLLM only | `import { Anthropic }` or `new OpenAI({ apiKey: process.env.ANTHROPIC_API_KEY })` |
| 3 | Subject builder | Backtick NATS subjects outside `subject-builder.ts` |
| 4 | Workflow ID pattern | `workflow.start()` without `{workflowType}-{tenantId}-{entityId}` comment |
| 5 | Zod on Activity output | `return rawResult` from an Activity without `.parse()` |
| 6 | JWT tenantId in MCP | `tenantId` field in a tool's `z.object()` input schema |
| 7 | TS strict stubs | `return undefined as any` or `return {} as SomeType` |

---

## Common Claude Code Commands

```bash
# Typecheck one package
pnpm --filter @cip/shared typecheck
pnpm --filter @cip/hr-service typecheck

# Typecheck all packages
pnpm -r run typecheck

# Install after adding dependencies
pnpm install

# Run a specific script
pnpm --filter @cip/infra tsx src/start.ts

# Check for Anthropic SDK violations
grep -r "anthropic-ai/sdk" packages/ --include="*.ts"

# Check for raw NATS subject strings (potential violations)
grep -r "nats\." packages/ --include="*.ts" | grep -v "subject-builder"
```

---

## Useful Mental Models

**Tenant boundary:** Imagine a line around everything one tenant owns. `tenantId` is the key that decides which side of the line you're on. If a datum can leak across that line, it's a bug.

**LiteLLM as the sole LLM door:** LiteLLM is the only process that knows the Anthropic API key. Every service that talks to an LLM is talking to LiteLLM, not to Anthropic. This means cost attribution, rate limiting, and logging happen in one place.

**Temporal as the source of truth for long-running work:** If something takes more than 30 seconds or might fail and need retrying, it lives in Temporal. No direct HTTP chains for multi-step processes.

**NATS subjects as a typed API:** Treat `cip.{tenantId}.{domain}.{event}.v1` like a typed function signature. The subject builder enforces this. Wildcard subscriptions in the watcher are fine, but individual publishers must use explicit subjects.

# CIP Platform — Context-Sliced Development Workflow

> **Purpose:** This document is the master index for working on the CIP platform one focused slice at a time. It prevents context overload, keeps token usage tight, and ensures you understand each layer before building on it.

---

## Why Context Slicing?

The CIP repo is large. Feeding the entire codebase to Claude Code in one session produces:
- Shallow implementations (Claude fills gaps with guesses)
- Missed constraint enforcement (tenantId, Zod validation, LiteLLM-only rule)
- Hard-to-review diffs
- Wasted tokens on files not relevant to the current task

**The alternative:** Load only the files relevant to the slice you are working on, implement that slice completely, verify it compiles, then move on.

---

## The Slice Map

Each slice has its own guidance document. Work through them in order — later slices depend on earlier ones compiling cleanly.

| # | Slice | Guidance Doc | Claude Code Prompt |
|---|-------|-------------|-------------------|
| 0 | **Orientation & Platform Readiness** ← **start here** | [`SLICE_00.md`](./SLICE_00.md) | `PROMPT 00-A` then `PROMPT 00-B` in `PROMPTS_ALL.md` |
| 1 | **Workspace Root** | [`SLICE_01_WORKSPACE_ROOT.md`](./SLICE_01_WORKSPACE_ROOT.md) | `PROMPT 01` in `PROMPTS_ALL.md` |
| 2 | **Shared Types** | [`SLICE_02_SHARED_TYPES.md`](./SLICE_02_SHARED_TYPES.md) | [`PROMPT_02_SHARED_TYPES.md`](./PROMPT_02_SHARED_TYPES.md) |
| 3 | **Shared Clients & Utils** | [`SLICE_03_SHARED_CLIENTS.md`](./SLICE_03_SHARED_CLIENTS.md) | [`PROMPT_03_SHARED_CLIENTS.md`](./PROMPT_03_SHARED_CLIENTS.md) |
| 4 | **Infrastructure YAML** | [`SLICE_04_INFRA_YAML.md`](./SLICE_04_INFRA_YAML.md) | [`PROMPT_04_INFRA_YAML.md`](./PROMPT_04_INFRA_YAML.md) |
| 5 | **HR Service — DB Layer** | [`SLICE_05_HR_DB.md`](./SLICE_05_HR_DB.md) | [`PROMPT_05_HR_DB.md`](./PROMPT_05_HR_DB.md) |
| 6 | **HR Service — Temporal Workflows & Activities** | [`SLICE_06_HR_TEMPORAL.md`](./SLICE_06_HR_TEMPORAL.md) | [`PROMPT_06_HR_TEMPORAL.md`](./PROMPT_06_HR_TEMPORAL.md) |
| 7 | **HR Service — Vision Agent (LangGraph)** | [`SLICE_07_VISION_AGENT.md`](./SLICE_07_VISION_AGENT.md) | [`PROMPT_07_VISION_AGENT.md`](./PROMPT_07_VISION_AGENT.md) |
| 8 | **HR Service — NATS Watcher** | [`SLICE_08_NATS_WATCHER.md`](./SLICE_08_NATS_WATCHER.md) | [`PROMPT_08_NATS_WATCHER.md`](./PROMPT_08_NATS_WATCHER.md) |
| 9 | **HR Service — MCP Server** | [`SLICE_09_MCP_SERVER.md`](./SLICE_09_MCP_SERVER.md) | [`PROMPT_09_MCP_SERVER.md`](./PROMPT_09_MCP_SERVER.md) |
| 10 | **Platform Core** | [`SLICE_10_PLATFORM_CORE.md`](./SLICE_10_PLATFORM_CORE.md) | [`PROMPT_10_PLATFORM_CORE.md`](./PROMPT_10_PLATFORM_CORE.md) |
| 11 | **Teams Bot** | [`SLICE_11_TEAMS_BOT.md`](./SLICE_11_TEAMS_BOT.md) | [`PROMPT_11_TEAMS_BOT.md`](./PROMPT_11_TEAMS_BOT.md) |
| 12 | **Infra Scripts** | [`SLICE_12_INFRA_SCRIPTS.md`](./SLICE_12_INFRA_SCRIPTS.md) | [`PROMPT_12_INFRA_SCRIPTS.md`](./PROMPT_12_INFRA_SCRIPTS.md) |
| 13 | **Makefile & Shell Scripts** | [`SLICE_13_MAKEFILE.md`](./SLICE_13_MAKEFILE.md) | [`PROMPT_13_MAKEFILE.md`](./PROMPT_13_MAKEFILE.md) |

---

## The Non-Negotiables (enforce in every slice)

These rules must be checked in every session. Put them at the top of your mental checklist before reviewing any output.

1. **`tenantId` everywhere** — every DB row, NATS payload, agent state, Temporal workflow ID
2. **LiteLLM only** — no `import { Anthropic } from '@anthropic-ai/sdk'` anywhere in service packages
3. **Subject builder** — NATS subjects always via `buildSubject()`, never raw strings
4. **Workflow ID pattern** — `{workflowType}-{tenantId}-{entityId}` at every call site
5. **Zod validation on Activity output** — never return unvalidated data from a Temporal Activity
6. **JWT-sourced tenantId in MCP** — never accept tenantId as a tool argument
7. **TypeScript strict** — stubs throw `new Error('not implemented')`, never `return undefined as any`

---

## Session Ritual

Before starting any Claude Code session:

```
1. Open the relevant SLICE_NN doc — read the "What You Are Building" section
2. Open the relevant PROMPT_NN doc — copy the prompt verbatim into Claude Code
3. After Claude Code finishes: run `pnpm typecheck` from the repo root
4. Fix any type errors before closing the session
5. Commit with message: "slice(NN): <slice name>"
```

---

## Context Files Per Slice (quick reference)

The prompt docs below already list the exact files to load. This table is for quick orientation.

| Slice | Key files Claude Code needs in context |
|-------|----------------------------------------|
| 1 | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json` |
| 2 | `packages/shared/src/types/**` |
| 3 | `packages/shared/src/clients/**`, `packages/shared/src/utils/**` |
| 4 | `infra/k8s/**`, `infra/helm/**` |
| 5 | `packages/hr-service/src/db/**` |
| 6 | `packages/hr-service/src/workflows/**`, `packages/hr-service/src/activities/**` |
| 7 | `packages/hr-service/src/agents/vision-agent/**` |
| 8 | `packages/hr-service/src/nats/**` |
| 9 | `packages/hr-service/src/mcp-server/**` |
| 10 | `packages/platform-core/src/**` |
| 11 | `packages/teams-bot/src/**` |
| 12 | `packages/infra/src/**` |
| 13 | `Makefile`, `scripts/**` |

---

## Supporting Files

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Read automatically by Claude Code at session start — scope rules, non-negotiables, cross-slice note format. Place at repo root. |
| `.claude/settings.json` | Denies Claude Code read/write access to `node_modules/`, `dist/`, `.envrc`, and other out-of-scope paths. Place at repo root. |
| `CROSS_SLICE_NOTES.md` | Running log of issues found in one slice that require a fix in an earlier slice. Resolved using `PROMPT CROSS-SLICE`. |

---

## Cross-Slice Protocol

Later slices will sometimes reveal that an earlier slice was incomplete or wrong — a missing field on a shared type, a Zod schema out of sync, a Helm secret name that doesn't match `create-secrets.sh`. The protocol:

1. **Do not fix it mid-session.** Finish the current slice with the correct shapes as they *should* be, even if typecheck temporarily fails on an earlier package.
2. **Claude Code writes a `CROSS-SLICE NOTE`** at the end of its response (format in `CLAUDE.md`).
3. **Copy the note into `CROSS_SLICE_NOTES.md`** before starting the next slice.
4. **Run `PROMPT CROSS-SLICE`** from `PROMPTS_ALL.md` to resolve all open notes in a dedicated session.

The five patterns most likely to produce cross-slice notes:
- `@cip/shared` types missing fields — discovered in Slices 06, 07, 09, 11
- `subject-builder.ts` missing a `Subjects.*` helper — discovered in Slices 08, 11
- Zod schema out of sync with its TypeScript type — discovered in Slices 06, 07
- Helm `secretKeyRef` names not matching `create-secrets.sh` — discovered in Slices 06, 10, 11
- Hardcoded Temporal task queue strings instead of env var — discovered in Slices 06, 10

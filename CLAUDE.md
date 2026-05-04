# CIP Platform — Claude Code Instructions

> This file is read automatically by Claude Code at the start of every session.
> It is the single source of truth for how Claude Code must behave in this repo.

---

## Scope Discipline — Read This First

**You are always working on one slice at a time.**

Before doing anything else, read the prompt you were given and identify:
1. Which slice you are on
2. The exact list of files you are permitted to create or modify
3. The hard rules for that slice

Do not read, scan, or load files outside that list unless a hard rule explicitly
requires it (e.g. "check that this type exists in @cip/shared"). When in doubt,
do not load the file — ask instead.

---

## What You May Read Without Being Asked

These files are always safe to read (all slice docs live in slices/):
- `slices/CONTEXT_WORKFLOW.md` — the slice map
- `slices/SLICE_00.md` — orientation and platform readiness reference
- The specific `slices/SLICE_NN*.md` file named in your prompt
- `slices/CROSS_SLICE_NOTES.md` — only when running a cross-slice session
- Any file explicitly listed in your prompt's "Read before writing" section

**Everything else requires explicit instruction in the prompt.**

---

## What You Must Never Do

- **Do not read the entire repo** to orient yourself. Read only what the prompt specifies.
- **Do not load `node_modules/`**, `dist/`, or any compiled output.
- **Do not read files from other slice directories** to understand context. If you
  need to know what a type looks like in `@cip/shared`, read only the specific
  type file, not the entire package.
- **Do not modify files outside the slice's permitted file list** — even if you
  spot an improvement. Log it as a cross-slice note instead (see below).
- **Do not run `pnpm install` mid-session** unless the prompt explicitly says to.
  Run it only after all files for the slice are created.

---

## The Seven Non-Negotiables

Check every file you produce against all seven before finishing a session.

1. `tenantId: string` (not optional) on every domain interface, DB table, agent state, and Temporal workflow ID
2. No `import` from `@anthropic-ai/sdk` anywhere outside `infra/k8s/litellm-config.yaml` comments
3. NATS subjects only via `buildSubject()` or `Subjects.*` from `packages/shared/src/utils/subject-builder.ts`
4. Every `workflow.start()` call has `workflowId: \`{workflowType}-${tenantId}-${entityId}\`` plus the comment `// Workflow ID pattern: {workflowType}-{tenantId}-{entityId}` on the preceding line
5. Every Temporal Activity that produces domain data calls `.parse()` on a Zod schema before returning
6. No MCP tool input schema contains `tenantId` as a field — it is always from `authInfo.token`
7. All stubs use `throw new Error('not implemented')` — never `return undefined as any`

---

## Durability Check — Before Designing Any New Pipeline

**Run this check before writing the slice doc for any work that
involves cron jobs, multi-step processes, or multi-system writes.**
We have a Temporal cluster + worker pods deployed; failing to use
them when the work fits is leaving infrastructure on the table.

Ask these six questions about the work you're about to design:

1. **Multi-step?** Does the operation involve 2+ network/DB/storage
   calls that need to all succeed for the operation to be
   "complete"?
2. **Cron-driven?** Is this work scheduled (weekly/daily/hourly),
   especially if any step takes > 30 seconds or could fail mid-way?
3. **Wait for human?** Does the workflow need to pause for an admin
   review, approval, or external event (HITL)?
4. **Bad if interrupted?** Would a pod restart mid-execution leave
   the system in a partial/inconsistent state requiring manual
   recovery?
5. **Compensating actions?** If step N fails after step N-1 succeeded,
   should we roll back N-1 (delete the S3 object, revoke the KC role,
   etc.)?
6. **Fan-out?** Will we ever want to run this operation across
   multiple tenants/entities in parallel?

**Two or more "yes" answers = strong Temporal candidate.** Use the
existing patterns:

- Signal-paused HITL: `certification-processing.workflow.ts`,
  `retrain-model.workflow.ts` (slice 56N)
- Compensating action: `retrain-model.workflow.ts:228-256`
- MCP tool → `workflow.start` handoff: `process-document.ts:61-68`
- Activity proxy with per-step timeouts:
  `retrain-model.workflow.ts:56-80`

**One "yes" answer or fewer = stay sync.** Single SQL UPDATE in an MCP
handler, sub-100ms request paths, LangGraph nodes (its own runtime),
and operator-driven diagnostic scripts are NOT Temporal candidates.

**If unsure** between sync and Temporal, default to sync first; it's
easier to convert sync→Temporal once a real durability problem hits
than to back out a needless workflow. But document the decision in
the slice doc so reviewers can challenge it.

**Pattern reference:** `slices/TEMPORAL_AUDIT_2026_05_04.md` for the
last comprehensive audit; re-run quarterly to catch missed
opportunities.

---

## Cross-Slice Issues — How to Handle Them

If you discover during a session that an earlier slice produced something incorrect
(a missing field, a wrong type, an incomplete contract), do NOT fix it silently.

Do this instead:

1. **Finish the current slice** with the correct types/interfaces as they should be,
   even if it means the typecheck fails because `@cip/shared` doesn't match yet.

2. **Write a cross-slice note** at the end of your response in this format:

```
CROSS-SLICE NOTE
Slice: 07 (Vision Agent)
Affects: Slice 02 (Shared Types)
File: packages/shared/src/types/agent.ts
Issue: VisionAgentState is missing the field `certType: string`.
       The vision agent nodes.ts requires it at line 34.
Fix: Add `certType: string` to VisionAgentState interface.
     This is not optional — the extraction prompt uses it to select the correct schema.
Resolution: Run PROMPT CROSS-SLICE before starting Slice 08.
```

3. The developer then runs `PROMPT CROSS-SLICE` (in `slices/PROMPTS_ALL.md`) before
   starting the next slice to resolve all outstanding notes.

---

## Typecheck Is Mandatory Before Finishing

Every session that touches TypeScript files must end with a typecheck.
Do not mark a session complete if typecheck fails.

```bash
# Single package (preferred — faster, scoped)
pnpm --filter @cip/<package-name> typecheck

# Full repo (only for cross-package changes or final verification)
pnpm -r run typecheck
```

If typecheck fails on a package you did not touch in this session, note it
but do not fix it — it belongs to a different slice.

---

## Commit Convention

```
slice(NN): <short description>

Examples:
slice(02): shared types — tenant, cert, agent, workflow, events
slice(06): hr-service temporal workflows and activities
slice(cross): fix VisionAgentState missing certType field
```

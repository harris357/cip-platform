# CIP Platform — Cross-Slice Notes

> **Purpose:** When a session reveals that an earlier slice needs a fix, it is logged here
> rather than fixed immediately. Cross-slice fixes are batched and applied using
> `PROMPT CROSS-SLICE` from `PROMPTS_ALL.md` before the next slice begins.
>
> **Format:** Copy the template below. Set status to OPEN when logged, RESOLVED when fixed.

---

## Template

```
### CS-NNN
- **Logged in:** Slice NN (name)
- **Affects:** Slice NN (name)
- **File:** packages/.../src/...
- **Status:** OPEN
- **Issue:** One sentence describing what is wrong.
- **Why it matters:** Which downstream slices or runtime behaviours break if not fixed.
- **Fix:** Exact change required — field to add, type to correct, function to rename, etc.
```

---

## Open Notes

<!-- New notes go here. Move to Resolved once fixed. -->

*(none yet)*

---

## Resolved Notes

*(none yet)*

---

## Patterns to Watch For

These are the cross-slice issues that occur most often in this codebase,
based on the architecture's known coupling points.

### `@cip/shared` types are too narrow (Slices 02 → 06, 07, 09, 10, 11)

The most common issue. `VisionAgentState`, `ExtractionResult`, `CertProcessingInput`
and similar types are defined in Slice 02 but not fully exercised until Slice 06 or 07.
Fields that seem optional at definition time turn out to be required by the time
an Activity or LangGraph node tries to use them.

**Watch for:** TypeScript errors in later slices referencing `@cip/shared` types with
messages like "Property X does not exist" or "Type undefined is not assignable to string."

**Resolution pattern:** Add the field to the type in `packages/shared/src/types/`,
re-run `pnpm --filter @cip/shared typecheck`, then re-run typecheck on the affected service.

---

### Subject builder missing an event (Slices 03 → 08, 09, 11)

`subject-builder.ts` defines `Subjects.certUploaded`, `Subjects.certProcessed` etc.
in Slice 03. Later slices (NATS Watcher in 08, cert-upload handler in 11) may
need subjects not yet defined there.

**Watch for:** A slice prompt forcing you to write a raw NATS subject string because
the `Subjects.*` helper doesn't exist yet.

**Resolution pattern:** Add the helper to `subject-builder.ts` and re-export it from
`packages/shared/src/index.ts`. This is a safe additive change that doesn't break
any existing slice.

---

### Zod schema doesn't match the TypeScript type (Slices 03 → 06, 07)

`zod-schemas.ts` in Slice 03 defines `ExtractionResultSchema`. If the TypeScript
`ExtractionResult` interface in Slice 02 changes shape, the Zod schema falls out of sync.
This won't always produce a TypeScript error — it produces a runtime validation failure.

**Watch for:** An Activity that calls `.parse()` and the Zod schema rejects a value
that the TypeScript type says should be valid. Also watch for a Zod schema that accepts
values the TypeScript type has marked as optional but should be required (or vice versa).

**Resolution pattern:** Update `zod-schemas.ts` to match the TypeScript type exactly.
Consider using `z.infer<typeof Schema>` as the TypeScript type to keep them in sync
automatically — if you do this, update the type in `@cip/shared/types/` to re-export
the Zod-inferred type instead of a hand-written interface.

---

### Helm values don't reference the right K8s secret name (Slices 04 → 06, 10, 11, 12)

K8s secret names are established in Slice 00-B (Platform Readiness) and encoded
in `scripts/create-secrets.sh`. Slice 04 writes Helm values files. Later slices
add Helm charts for each service. If any of these use a different secret name from
what `create-secrets.sh` creates, the pod fails to start with a `SecretNotFound` error.

**Watch for:** A Helm `deployment.yaml` that references `secretKeyRef.name: some-secret`
where `some-secret` doesn't match any name in `create-secrets.sh`.

**Resolution pattern:** Cross-check every `secretKeyRef.name` in every Helm template
against the secret names in `create-secrets.sh`. The canonical list is in `CLAUDE.md`
(the seven secrets created in Slice 00-B's K8s section).

---

### Temporal task queue name mismatch (Slices 03 → 06, 10, 12)

`TEMPORAL_TASK_QUEUE_HR` and `TEMPORAL_TASK_QUEUE_PLATFORM` are set as env vars
in `.envrc` and K8s secrets. The Temporal worker in each service reads from these.
If a workflow `start()` call uses a hardcoded string instead of the env var,
the workflow will be dispatched to a queue that no worker is polling.

**Watch for:** Any `taskQueue: 'cip-hr-tasks'` or similar hardcoded string outside
of the env var reference `process.env['TEMPORAL_TASK_QUEUE_HR']`.

**Resolution pattern:** Replace every hardcoded task queue string with
`process.env['TEMPORAL_TASK_QUEUE_HR'] ?? 'cip-hr-tasks'` (env var with fallback).

---

### `tenantId` dropped at a boundary (any slice)

The most insidious cross-slice concern. `tenantId` flows correctly through one layer
then gets dropped at a handoff — typically where a plain object is constructed instead
of spread from an existing typed value.

**Watch for:**
- An Activity input that is constructed with `{ certId, documentUrl }` missing `tenantId`
- A NATS event payload that is `JSON.stringify({ certId, status })` with no `tenantId`
- An agent state that is initialised with `{ runId, startedAt }` and `tenantId` added only
  as an afterthought, or not at all

**Resolution pattern:** For every object construction that produces a domain type,
check the resulting object against the type definition and confirm `tenantId` is present.
TypeScript strict mode catches most but not all of these (it won't catch a `string` being
passed where `string` is expected but the *value* is wrong or empty).
